// ------------------------------------------------------------------
// 気象庁（JMA）の「エリアマスター」を取得し、
//   ・都道府県 → 気象台（office）コード
//   ・市区町村（このアプリの MUNI_LIST の表記） → 二次細分区域（class20）コード
// への対応表を組み立てるモジュール。
//
// 参照データ: https://www.jma.go.jp/bosai/common/const/area.json
//   - centers  : 地方単位の大くくり（例：北海道地方 等）
//   - offices  : 気象台単位（天気予報・警報注意報JSONのキーと同じ6桁コード）
//   - class10s : 一次細分区域
//   - class15s : 市町村等をまとめた地域
//   - class20s : 二次細分区域（警報・注意報の実際の発表単位。ほぼ市区町村に対応）
//
// このファイルはネットワーク越しに毎回 area.json を取りに行くと重い（かつ
// JMA側への負荷にもなる）ため、Netlify Blobs に取得結果を24時間キャッシュする。
// area.json はほぼ変化しない静的な参照データのため、多少古くても実用上問題ない。
//
// 【既知の限界】
// ・市区町村名のマッチングは文字列の完全一致（正規化後）で行っている。
//   平成の大合併等で名称が変わった市区町村や、area.json側の表記揺れがある場合は
//   マッチせず、都道府県単位のデータにフォールバックする（=その市区町村だけ
//   実況の細かい差が反映されない）。マッチ率は update-risk-data.mjs の
//   診断情報（matchStats）で確認できる。
// ・北海道は気象台が複数（宗谷地方・上川等）に分かれているため、
//   centers 経由で「北海道地方」配下と判定するロジックに加え、
//   既知のオフィスコード一覧をフォールバックとして併用している。
//   area.json の実際の構造が想定と異なっていた場合はこの一覧を調整する必要がある。
// ------------------------------------------------------------------

import { getStore } from '@netlify/blobs';
import { PREFS } from './scoring.mjs';
import { MUNI_LIST } from './muni-list.mjs';

const AREA_JSON_URL = 'https://www.jma.go.jp/bosai/common/const/area.json';
const CACHE_STORE = 'jma-cache';
const CACHE_KEY = 'area-master-v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24時間

// 2026年時点で公開されている北海道の気象台（予報区）コードの既知の一覧。
// area.json の centers/offices 構造からの判定が何らかの理由で失敗した場合の
// セーフティネットとして使用する（judgeが取れればこちらは使われない）。
const KNOWN_HOKKAIDO_OFFICE_CODES = new Set([
  '011000', // 宗谷地方
  '012000', // 上川・留萌地方
  '013000', // 石狩・空知・後志地方
  '014030', // 胆振・日高地方
  '014100', // 渡島・檜山地方
  '015000', // オホーツク地方
  '016000', // 十勝地方
  '017000', // 釧路・根室地方
]);

function normalizeName(name){
  if(!name) return '';
  return String(name)
    .normalize('NFKC')
    .replace(/ヶ/g, 'ケ').replace(/ヵ/g, 'カ')
    .replace(/之/g, 'ノ')
    .trim();
}

async function fetchAreaMasterRaw(){
  const res = await fetch(AREA_JSON_URL, {
    headers: { 'User-Agent': 'hailscope-app/1.0 (+hail risk index; contact via app support)' },
  });
  if(!res.ok) throw new Error(`area.json fetch failed: HTTP ${res.status}`);
  return res.json();
}

// area.json を取得（Blobsに24hキャッシュ）。取得に失敗した場合、期限切れでも
// キャッシュが残っていればそれを使う（気象庁側の一時的な障害等でパイプライン
// 全体が止まらないようにするため）。
export async function getAreaMaster(){
  let store;
  try{ store = getStore(CACHE_STORE); }catch(e){ store = null; }

  let cached = null;
  if(store){
    cached = await store.get(CACHE_KEY, { type: 'json' }).catch(() => null);
    if(cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS){
      return { area: cached.data, fromCache: true, fetchedAt: cached.fetchedAt };
    }
  }

  try{
    const data = await fetchAreaMasterRaw();
    if(store){
      await store.setJSON(CACHE_KEY, { fetchedAt: Date.now(), data }).catch(() => {});
    }
    return { area: data, fromCache: false, fetchedAt: Date.now() };
  }catch(e){
    if(cached){
      return { area: cached.data, fromCache: true, fetchedAt: cached.fetchedAt, staleFallback: true };
    }
    throw e;
  }
}

function findNode(area, id){
  return area.class20s?.[id] || area.class15s?.[id] || area.class10s?.[id]
    || area.offices?.[id] || area.centers?.[id] || null;
}

// 任意のエリアコードから親をたどり、area.offices に存在するコード（気象台コード）を返す。
function officeCodeFor(area, id, maxHops = 6){
  return ancestorInLayer(area, id, 'offices', maxHops);
}

// 任意のエリアコードから親をたどり、area.class10s に存在するコード（一次細分区域）を返す。
// 天気予報JSON（pops/weathers）は一次細分区域単位で配信されるため、
// class20（二次細分区域＝市区町村相当）から見てどの一次細分区域に属するかを
// 特定するために使用する。
function class10CodeFor(area, id, maxHops = 6){
  return ancestorInLayer(area, id, 'class10s', maxHops);
}

// 任意のエリアコードから親をたどり、指定した層（'offices'|'class10s'|'class15s'）に
// 存在するコードを返す汎用ヘルパー。自分自身が既にその層に属していればそのまま返す。
function ancestorInLayer(area, id, layerKey, maxHops = 6){
  let cur = id;
  for(let i = 0; i < maxHops; i++){
    if(area[layerKey]?.[cur]) return cur;
    const node = findNode(area, cur);
    if(!node || !node.parent) return null;
    cur = node.parent;
  }
  return null;
}

// 指定した気象台コードが、このアプリの47都道府県のどれに対応するかを判定する。
function prefNameForOffice(area, officeCode, prefFullNames){
  const office = area.offices?.[officeCode];
  if(!office) return null;

  // 1. 気象台名が都道府県名と完全一致するケース（大半の都道府県はこちら）
  if(prefFullNames.includes(office.name)) return office.name;

  // 2. 北海道: 既知のオフィスコード一覧に含まれていれば北海道と判定
  if(KNOWN_HOKKAIDO_OFFICE_CODES.has(officeCode)) return '北海道';

  // 3. centers（地方区分）をたどり、「北海道」を含む地方名であれば北海道と判定
  let cur = office.parent;
  for(let i = 0; i < 4 && cur; i++){
    const center = area.centers?.[cur];
    if(!center) break;
    if(center.name && center.name.includes('北海道')) return '北海道';
    cur = center.parent;
  }

  // 4. 最終手段: 気象台名に都道府県名（末尾の都道府県文字を除いた部分）が
  //    部分文字列として含まれるかどうかで判定
  const bySubstring = prefFullNames.find(p => {
    const core = p.replace(/(都|道|府|県)$/, '');
    return core.length >= 2 && office.name && office.name.includes(core);
  });
  return bySubstring || null;
}

// 都道府県ごとに、その配下にある「気象台コード一覧」を返す
// （北海道は複数、それ以外は基本1つ）。
export function officesByPrefecture(area){
  const prefFullNames = PREFS.map(p => p[0]);
  const result = {};
  for(const prefName of prefFullNames) result[prefName] = [];

  for(const officeCode of Object.keys(area.offices || {})){
    const prefName = prefNameForOffice(area, officeCode, prefFullNames);
    if(prefName && result[prefName]) result[prefName].push(officeCode);
  }
  return result;
}

// 市区町村（MUNI_LIST の表記）→ 二次細分区域（class20）コードの対応表を構築する。
// マッチしなかった市区町村は class20Code: null（呼び出し側で都道府県単位に
// フォールバックする）。
export function matchMunicipalitiesToClass20(area){
  const prefFullNames = PREFS.map(p => p[0]);

  // class20コード → { name, officeCode, class10Code, prefName }
  const class20Info = {};
  for(const [code, node] of Object.entries(area.class20s || {})){
    const officeCode = officeCodeFor(area, code);
    const class10Code = class10CodeFor(area, code);
    const prefName = officeCode ? prefNameForOffice(area, officeCode, prefFullNames) : null;
    class20Info[code] = { name: node.name, officeCode, class10Code, prefName };
  }

  // 都道府県ごとに「正規化した地名 → class20コード」のインデックスを作成
  const indexByPref = {};
  for(const [code, info] of Object.entries(class20Info)){
    if(!info.prefName) continue;
    if(!indexByPref[info.prefName]) indexByPref[info.prefName] = new Map();
    indexByPref[info.prefName].set(normalizeName(info.name), code);
  }

  const matched = {}; // prefName -> { cityName -> class20Code|null }
  const stats = { totalCities: 0, matchedCities: 0, byPref: {} };

  for(const prefName of prefFullNames){
    matched[prefName] = {};
    const cities = MUNI_LIST[prefName] || [];
    const idx = indexByPref[prefName] || new Map();
    let prefMatched = 0;
    for(const city of cities){
      const code = idx.get(normalizeName(city)) || null;
      matched[prefName][city] = code;
      stats.totalCities++;
      if(code){ stats.matchedCities++; prefMatched++; }
    }
    stats.byPref[prefName] = { total: cities.length, matched: prefMatched };
  }

  return { matched, stats, class20Info };
}

// テスト・診断用に内部ヘルパーも公開する
export { normalizeName, officeCodeFor, class10CodeFor, prefNameForOffice, ancestorInLayer };
