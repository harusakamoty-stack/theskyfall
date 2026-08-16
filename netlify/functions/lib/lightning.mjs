// ------------------------------------------------------------------
// 雷ナウキャスト（雷活動度）のタイル画像を取得し、指定した緯度経度における
// 活動度レベル（0〜4）を判定するモジュール。
//
// 参照: https://www.jma.go.jp/bosai/jmatile/data/nowc/{basetime}/none/{validtime}/surf/thns/{z}/{x}/{y}.png
//   - これは気象庁の公開Webサイト「今後の雨」が実際に使用しているタイルURLパターンで、
//     ログイン等は不要だが、公式にドキュメント化されたAPIではない（形式が予告なく
//     変わる可能性がある）。
//   - basetime/validtimeは対象時刻一覧JSON（targetTimes_N3.json）から取得する必要がある。
//   - 色の凡例（レベル1〜4に対応するRGB値）はJMAから機械可読な形で公開されておらず、
//     本モジュールの色判定は「黄→橙→赤→紫（活動度が上がるほど暖色から寒色寄りの
//     濃い色になる」という一般的な説明に基づくヒューリスティックです。実際の色味と
//     ずれている可能性があるため、実運用開始後にサンプル画像で検証・調整することを
//     強く推奨します（本ファイル冒頭のLEVEL_COLOR_HINTSを参照）。
//
// 【解像度上の制約】
// 市区町村ごとに緯度経度を用意するのは現実的でないため、このモジュールは
// 都道府県庁所在地の代表地点1点のみをサンプリングする。つまり「雷ナウキャスト」
// 由来のシグナルは都道府県単位で同一となり、同じ県内の市区町村間の違いには
// 反映されない（警報注意報は市区町村クラスタ単位で反映される点と対照的）。
// ------------------------------------------------------------------

import { PNG } from 'pngjs';

const TILE_ZOOM = 8; // ズームレベル（3〜9の範囲で有効とされる）
const UA = { 'User-Agent': 'hailscope-app/1.0 (+hail risk index; contact via app support)' };

// 参考: レベルに対応すると説明されている色のおおよその色相（度）。
// 正式な色コード表が非公開のため、「色相・彩度・明度」による大まかな
// バケット分けとして扱う（誤判定を避けるため境界には余裕を持たせている）。
const LEVEL_COLOR_HINTS = [
  { level: 1, hueRange: [45, 65], note: '黄（今後発雷可能性あり）' },
  { level: 2, hueRange: [25, 45], note: '橙（発雷可能性あり）' },
  { level: 3, hueRange: [0, 15],  note: '赤（雷発生中）' },
  { level: 4, hueRange: [270, 320], note: '紫（激しい雷）' },
];

function rgbToHsl(r, g, b){
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if(d !== 0){
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch(max){
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s, l };
}

function classifyPixel(r, g, b, a){
  if(a < 40) return 0; // ほぼ透明 = 活動なし
  const { h, s, l } = rgbToHsl(r, g, b);
  if(s < 0.25 || l > 0.92 || l < 0.05) return 0; // 彩度が低い/白抜け/黒すぎる = 背景扱い
  for(const hint of LEVEL_COLOR_HINTS){
    const [lo, hi] = hint.hueRange;
    if(h >= lo && h <= hi) return hint.level;
  }
  return 0;
}

function lonLatToTile(lon, lat, zoom){
  const latRad = (lat * Math.PI) / 180;
  const n = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  // タイル内でのピクセル位置（0〜255）も同時に計算する
  const xFloat = ((lon + 180) / 360) * n;
  const yFloat = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const px = Math.floor((xFloat - x) * 256);
  const py = Math.floor((yFloat - y) * 256);
  return { x, y, z: zoom, px, py };
}

let cachedTargetTimes = null;
let cachedTargetTimesAt = 0;
const TARGET_TIMES_TTL_MS = 2 * 60 * 1000; // 2分（雷ナウキャストは高頻度更新のため短め）

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
  const url = `https://www.jma.go.jp/bosai/jmatile/data/nowc/${basetime}/none/${validtime}/surf/thns/${z}/${x}/${y}.png`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try{
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if(!res.ok) return null; // そのタイルにデータがない（雷活動なし）場合は404になることがある
    const buf = Buffer.from(await res.arrayBuffer());
    return PNG.sync.read(buf);
  }catch(e){
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 指定した1地点（緯度経度）の現在の雷活動度レベル（0〜4）を返す。
// 取得・解析に失敗した場合は例外を投げず、level:0（活動なしと同等）で返す
// ことで、パイプライン全体が雷ナウキャストの障害で止まらないようにしている。
export async function getLightningLevel(lat, lon){
  try{
    const times = await getLatestTargetTimes();
    // targetTimes_N3.json は [{basetime, validtime}, ...] 形式（最新が先頭または末尾）。
    // 「現在に最も近い実況」を使いたいため、リストの中から最新のものを選ぶ。
    const list = Array.isArray(times) ? times : (times?.targetTimes || []);
    if(!list.length) return { level: 0, ok: false, reason: 'no-target-times' };
    const latest = list[list.length - 1];
    const basetime = latest.basetime || latest.baseTime;
    const validtime = latest.validtime || latest.validTime || basetime;
    if(!basetime) return { level: 0, ok: false, reason: 'no-basetime' };

    const { x, y, z, px, py } = lonLatToTile(lon, lat, TILE_ZOOM);
    const png = await fetchTilePng(basetime, validtime, x, y, z);
    if(!png) return { level: 0, ok: true, reason: 'no-activity-or-tile-missing' };

    const idx = (png.width * py + px) << 2;
    const r = png.data[idx], g = png.data[idx + 1], b = png.data[idx + 2], a = png.data[idx + 3];
    const level = classifyPixel(r, g, b, a);
    return { level, ok: true, sample: { r, g, b, a } };
  }catch(e){
    return { level: 0, ok: false, reason: String(e) };
  }
}

export { lonLatToTile, classifyPixel, rgbToHsl };
