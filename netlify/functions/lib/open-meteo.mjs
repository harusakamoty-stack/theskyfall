// ------------------------------------------------------------------
// Open-Meteo（https://open-meteo.com）から、気象庁の公開データには含まれない
// 大気安定度に関する数値（CAPE・Lifted Index・CIN・0℃高度）と、参考情報として
// 海面更正気圧を取得するモジュール。
//
// 【なぜ気象庁ではなくOpen-Meteoを使うのか】
// 気象庁は数値予報GPV（GSM/MSM）をGRIB2形式で配信しているが、これは気象業務支援
// センター(JMBSC)との有償契約が必要で、無償・無契約で使えるJSON/XML形式の
// CAPE/SSI/Lifted Index等は（少なくとも2026年8月時点で）公開されていない
// （高層天気図は画像のみで構造化データではない）。一方Open-Meteoは無料・APIキー
// 不要で、GFS/ICON/ECMWF等の複数の数値予報モデルを統合し、CAPE等を
// 事前計算済みのJSONとして提供している（月30万コール程度までは非商用利用で
// 無料、と2026年時点の公式ドキュメントに明記）。JMA自身のモデル(GSM/MSM)は
// これらの項目を直接には持たないため、Open-Meteo側も内部的にはGFS/ICON等の
// 値を用いている（＝日本域の値も気象庁ではなく主に米欧のモデルに基づく）。
//
// 【簡略化した独自指標であることの明示】
// NOAA/SPCが定義する正式な「SHIP（Significant Hail Parameter）」は
// 700-500hPa気温減率・地上混合比・0-6km鉛直シアーなど、ここでは取得していない
// 要素も必要とする。本モジュールのcomputeInstabilityScore()は、CAPE・Lifted
// Index・CIN・0℃高度という取得できた範囲の要素だけを使った簡略版であり、
// 正式なSHIPそのものではない（比較検証もできていない）。あくまで「無から
// 有（実際の大気の状態）」への改善であって、専門機関の予測精度と同等という
// 意味ではない。
// ------------------------------------------------------------------

const UA = { 'User-Agent': 'hailscope-app/1.0 (+hail risk index; contact via app support)' };
const HOURLY_VARS = ['cape', 'lifted_index', 'convective_inhibition', 'freezing_level_height', 'pressure_msl'];

function buildUrl(lat, lon){
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: HOURLY_VARS.join(','),
    timezone: 'Asia/Tokyo',
    forecast_days: '4',
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

async function fetchJson(url, timeoutMs = 8000){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try{
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Open-Meteoのhourly応答（"time"配列＋各変数の並行配列）を
// { "2026-08-16|18": {cape, li, cin, freezingLevelM, pressureMsl} } の形に変換する。
// timezone=Asia/Tokyoを指定しているため、time文字列（例:"2026-08-16T18:00"）は
// そのままJSTのdateKeyと時を表す（UTC変換は不要）。
function parseHourly(raw){
  const hourly = raw?.hourly;
  const times = hourly?.time;
  const result = {};
  if(!Array.isArray(times)) return result;

  for(let i = 0; i < times.length; i++){
    const m = String(times[i]).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):/);
    if(!m) continue;
    const key = `${m[1]}|${parseInt(m[2], 10)}`;
    result[key] = {
      cape: numOrNull(hourly.cape?.[i]),
      li: numOrNull(hourly.lifted_index?.[i]),
      cin: numOrNull(hourly.convective_inhibition?.[i]),
      freezingLevelM: numOrNull(hourly.freezing_level_height?.[i]),
      pressureMsl: numOrNull(hourly.pressure_msl?.[i]),
    };
  }
  return result;
}

function numOrNull(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// アプリの時間帯スロットに対応する代表時刻（jma-fetch.mjsのSLOT_BLOCK_MAPと
// 考え方は同じだが、Open-Meteoは1時間刻みのデータを直接持っているため、
// 6時間ブロックの平均ではなく該当時刻をそのまま使う。nightのみ日をまたぐため
// 当日18時・翌日0時の平均を取る点は既存のJMA側ロジックと揃えている）。
const SLOT_HOUR_MAP = {
  early: [{ dOffset: 0, hour: 6 }],
  morning: [{ dOffset: 0, hour: 6 }],
  noon: [{ dOffset: 0, hour: 12 }],
  evening: [{ dOffset: 0, hour: 18 }],
  night: [{ dOffset: 0, hour: 18 }, { dOffset: 1, hour: 0 }],
};

function addDaysToDateKey(dateKey, days){
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// 指定した日付・スロットの大気安定度データを取り出す。該当時刻が無ければnullを返す。
export function lookupInstability(parsed, dateKey, slotKey){
  const blocks = SLOT_HOUR_MAP[slotKey] || [{ dOffset: 0, hour: 12 }];
  const samples = [];
  for(const b of blocks){
    const d = b.dOffset === 0 ? dateKey : addDaysToDateKey(dateKey, b.dOffset);
    const v = parsed[`${d}|${b.hour}`];
    if(v) samples.push(v);
  }
  if(!samples.length) return { cape: null, li: null, cin: null, freezingLevelM: null, pressureMsl: null, dataAvailable: false };

  const avg = (key) => {
    const vals = samples.map(s => s[key]).filter(v => typeof v === 'number');
    return vals.length ? vals.reduce((a, c) => a + c, 0) / vals.length : null;
  };
  const cape = avg('cape'), li = avg('li'), cin = avg('cin');
  const freezingLevelM = avg('freezingLevelM'), pressureMsl = avg('pressureMsl');
  const dataAvailable = [cape, li, cin, freezingLevelM].some(v => typeof v === 'number');
  return { cape, li, cin, freezingLevelM, pressureMsl, dataAvailable };
}

// 指定した日付・時（0-23）の気圧と、その3時間前の気圧の差(hPa)を返す。
// nullは「どちらかのデータが無く判定不能」を意味する（呼び出し側は補助シグナル
// として無視すればよい）。"now"スロットのみで意味を持つ、実時刻ベースの
// 補助的なシグナルのため、5区分のslotではなく実際の時刻を直接受け取る。
export function computePressureTrend(parsed, dateKey, hour){
  const cur = parsed[`${dateKey}|${hour}`]?.pressureMsl;
  let prevHour = hour - 3;
  let prevDateKey = dateKey;
  if(prevHour < 0){
    prevHour += 24;
    prevDateKey = addDaysToDateKey(dateKey, -1);
  }
  const prev = parsed[`${prevDateKey}|${prevHour}`]?.pressureMsl;
  if(typeof cur !== 'number' || typeof prev !== 'number') return null;
  return cur - prev;
}

// 1地点分のOpen-Meteo予報（4日分・1時間刻み）を取得し、パース済みの
// lookup用オブジェクトを返す。取得失敗時は例外を投げ、呼び出し側
// （mapWithConcurrency経由）でエラーとして捕捉される想定。
export async function fetchInstabilityData(lat, lon){
  const raw = await fetchJson(buildUrl(lat, lon));
  return parseHourly(raw);
}

// CAPE・Lifted Index・CIN・0℃高度から、0〜100の「対流不安定度」簡易指標を算出する。
// 【重要】これはNOAA/SPCの正式なSHIP等ではなく、取得できた要素だけを使った
// 独自の簡略式（本ファイル冒頭のコメント参照）。係数は気象学的に妥当と考えられる
// 大まかな目安（日本の夏季の対流性シャワーで典型的に見られる値のレンジ）を
// 基にした経験的なものであり、実際の降雹実績と照合したものではない。
export function computeInstabilityScore({ cape, li, cin, freezingLevelM }){
  let sum = 0;
  let any = false;

  if(typeof cape === 'number'){
    any = true;
    // 0 J/kg -> 0点、2200 J/kg以上 -> 満点50点（2000前後は日本の夏の
    // 発達した積乱雲でしばしば見られる値、2500超はかなり強い部類とされる）
    sum += clamp(cape / 2200, 0, 1) * 50;
  }
  if(typeof li === 'number'){
    any = true;
    // Lifted Indexは負が大きいほど不安定。0以上->0点、-8以下->満点30点
    sum += clamp((0 - li) / 8, 0, 1) * 30;
  }
  if(typeof cin === 'number'){
    any = true;
    // CIN（対流抑制）が強い(より負)ほど、CAPEがあっても対流が起きにくい
    // ため減点する。-50 J/kg程度までは無視できる範囲として扱う。
    if(cin < -50) sum -= clamp((-cin - 50) / 150, 0, 1) * 15;
  }
  if(typeof freezingLevelM === 'number'){
    any = true;
    // 0℃高度が低いほど、地上に達するまでに雹が融けにくい。
    // 3200m以下は融解层が薄く雹が残りやすい目安、4700m以上は真夏の
    // 高い0℃高度で、強い雷雲でも雹が融けきってしまいやすい目安として
    // 加点/減点する（いずれも経験的な目安であり、正式な基準値ではない）。
    if(freezingLevelM <= 3200) sum += 12;
    else if(freezingLevelM >= 4700) sum -= 12;
  }

  if(!any) return null;
  return Math.max(0, Math.min(100, Math.round(sum)));
}

function clamp(v, lo, hi){
  return Math.max(lo, Math.min(hi, v));
}

export { addDaysToDateKey };
