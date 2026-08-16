// ------------------------------------------------------------------
// 高解像度降水ナウキャストのタイル画像を取得し、指定した緯度経度における
// 「今まさに降っている雨の強さ」を0〜4のレベルで判定するモジュール。
// lib/lightning.mjs（雷ナウキャスト=thns）と同じタイル配信の仕組みを使うが、
// 要素名が異なる（hrpns）ため別モジュールとして実装している。
//
// 参照: https://www.jma.go.jp/bosai/jmatile/data/nowc/{basetime}/none/{validtime}/surf/hrpns/{z}/{x}/{y}.png
//   - 250m格子（land沿岸部、直近30分）→1km格子（35〜60分先）、5分ごと更新、
//     予報時間は最大60分先までの「高解像度降水ナウキャスト」の配信タイル
//     （気象庁の解説ページ・OSS実装(kikuchan/jmamap, Kanahiro/jma-utils)で
//     要素名"hrpns"を確認）。ログイン等は不要。
//
// 【未検証の前提であることの明示（重要）】
// ・basetime/validtimeの一覧取得に使うtargetTimes_N3.jsonは、既存のlightning.mjs
//   が雷ナウキャスト(thns)向けに使っているのと同じエンドポイントを流用している。
//   雷ナウキャストと高解像度降水ナウキャストが同一の更新サイクル・同一の
//   targetTimesファイルを共有しているという確証は取れておらず、OSS実装からの
//   間接的な傍証（同じ構造の中にhrpns/hrpns_ndが値として現れる例）に基づく
//   推測である。もし前提が誤っていた場合、症状としては「常にタイルが404＝
//   常にlevel:0（降水なし）」という形で静かに間違い続ける可能性があるため、
//   運用開始後はdiagnostics（tileHitCount等）を確認し、明らかに全地点が
//   level:0のまま推移していないか検証することを推奨する。
// ・雨量強度と色の対応（何mm/hが何色か）についても、気象庁は機械可読な
//   色凡例表を公開していない（画像でのみ提供）ため、雷ナウキャストと同様に
//   色相ベースのヒューリスティックで代用している。実際の色味とずれている
//   可能性がある。
// ------------------------------------------------------------------

import { PNG } from 'pngjs';
import { lonLatToTile, rgbToHsl } from './lightning.mjs';

const TILE_ZOOM = 8;
const UA = { 'User-Agent': 'hailscope-app/1.0 (+hail risk index; contact via app support)' };

// 一般的な雨量レーダーの配色（弱い=寒色〜強い=暖色〜非常に強い=赤紫）という
// 説明に基づく大まかな色相バケット。正式な凡例表が非公開のための代用。
const LEVEL_HUE_HINTS = [
  { level: 1, hueRange: [180, 250], note: '青（弱い降水、目安1〜5mm/h程度）' },
  { level: 2, hueRange: [80, 179],  note: '緑〜黄緑（やや強い降水、目安5〜20mm/h程度）' },
  { level: 3, hueRange: [30, 79],   note: '黄〜橙（強い降水、目安20〜50mm/h程度）' },
  { level: 4, hueRange: [330, 360], note: '赤〜マゼンタ（非常に強い降水、目安50mm/h以上）', altRange: [0, 15] },
];

function classifyPrecipPixel(r, g, b, a){
  if(a < 40) return 0; // 透明 = 降水なし
  const { h, s, l } = rgbToHsl(r, g, b);
  if(s < 0.2 || l > 0.95 || l < 0.05) return 0; // 彩度が低い/白抜け/黒すぎる = 背景扱い
  for(const hint of LEVEL_HUE_HINTS){
    const [lo, hi] = hint.hueRange;
    if(h >= lo && h <= hi) return hint.level;
    if(hint.altRange){
      const [alo, ahi] = hint.altRange;
      if(h >= alo && h <= ahi) return hint.level;
    }
  }
  return 0;
}

let cachedTargetTimes = null;
let cachedTargetTimesAt = 0;
const TARGET_TIMES_TTL_MS = 2 * 60 * 1000;

async function getLatestTargetTimes(){
  if(cachedTargetTimes && (Date.now() - cachedTargetTimesAt) < TARGET_TIMES_TTL_MS){
    return cachedTargetTimes;
  }
  const url = 'https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N3.json';
  const res = await fetch(url, { headers: UA });
  if(!res.ok) throw new Error(`targetTimes fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  cachedTargetTimes = data;
  cachedTargetTimesAt = Date.now();
  return data;
}

async function fetchTilePng(basetime, validtime, x, y, z){
  const url = `https://www.jma.go.jp/bosai/jmatile/data/nowc/${basetime}/none/${validtime}/surf/hrpns/${z}/${x}/${y}.png`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try{
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if(!res.ok) return null; // そのタイルにデータがない（降水なし）場合は404になることがある
    const buf = Buffer.from(await res.arrayBuffer());
    return PNG.sync.read(buf);
  }catch(e){
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 指定した1地点（緯度経度）の現在の降水強度レベル（0〜4）を返す。
// 取得・解析に失敗した場合は例外を投げず、level:0（降水なしと同等）で返すことで、
// パイプライン全体が高解像度降水ナウキャストの障害で止まらないようにしている。
export async function getPrecipNowcastLevel(lat, lon){
  try{
    const times = await getLatestTargetTimes();
    const list = Array.isArray(times) ? times : (times?.targetTimes || []);
    if(!list.length) return { level: 0, ok: false, reason: 'no-target-times' };
    const latest = list[list.length - 1];
    const basetime = latest.basetime || latest.baseTime;
    const validtime = latest.validtime || latest.validTime || basetime;
    if(!basetime) return { level: 0, ok: false, reason: 'no-basetime' };

    const { x, y, z, px, py } = lonLatToTile(lon, lat, TILE_ZOOM);
    const png = await fetchTilePng(basetime, validtime, x, y, z);
    if(!png) return { level: 0, ok: true, reason: 'no-precip-or-tile-missing' };

    const idx = (png.width * py + px) << 2;
    const r = png.data[idx], g = png.data[idx + 1], b = png.data[idx + 2], a = png.data[idx + 3];
    const level = classifyPrecipPixel(r, g, b, a);
    return { level, ok: true, sample: { r, g, b, a } };
  }catch(e){
    return { level: 0, ok: false, reason: String(e) };
  }
}

export { classifyPrecipPixel };
