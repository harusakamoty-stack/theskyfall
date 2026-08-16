// ------------------------------------------------------------------
// 気象庁（JMA）の天気予報JSON・警報注意報JSONを取得し、
// スコアリングで使いやすい形に正規化するモジュール。
//
//   天気予報: https://www.jma.go.jp/bosai/forecast/data/forecast/{officeCode}.json
//   警報注意報: https://www.jma.go.jp/bosai/warning/data/warning/{officeCode}.json
//
// どちらも認証不要で公開されているエンドポイントだが、公式にドキュメント化された
// APIではないため、将来的にレスポンス形式が変わる可能性がある。そのため、
// パース処理は try/catch で個別に保護し、一部が失敗しても全体が落ちないようにしている。
//
// 【天気予報JSONの構造（既知の形）】
// レスポンスはオブジェクトの配列 [短期予報, 週間予報] で、
//   短期予報.timeSeries[0] : 天気コード・天気文（1〜3日目、1日1値、一次細分区域単位)
//   短期予報.timeSeries[1] : 降水確率（pops）6時間ごと、当日〜翌日程度
//   週間予報.timeSeries[0] : 日別の天気コード・降水確率（7日分、当日分は精度が粗い）
// area.code は一次細分区域（class10）コードで、複数のエリアが含まれることがある。
// ------------------------------------------------------------------

const FORECAST_URL = (code) => `https://www.jma.go.jp/bosai/forecast/data/forecast/${code}.json`;
const WARNING_URL = (code) => `https://www.jma.go.jp/bosai/warning/data/warning/${code}.json`;

const UA = { 'User-Agent': 'hailscope-app/1.0 (+hail risk index; contact via app support)' };

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

function parseJstIso(iso){
  // JMAのタイムスタンプは "2026-08-16T18:00:00+09:00" のようにオフセット付きで
  // 返ってくるため、UTC変換をせず文字列から直接JSTの日付・時を読み取る。
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):/);
  if(!m) return null;
  return { dateKey: m[1], hour: parseInt(m[2], 10) };
}

function addDaysToDateKey(dateKey, days){
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// アプリの時間帯スロットが、天気予報JSONの6時間ブロック（0,6,12,18時始まり）の
// どれに対応するかのマッピング。dOffsetはそのスロットが属する「日」からの
// 日付オフセット（nightスロットは日をまたぐため2ブロックを平均する）。
const SLOT_BLOCK_MAP = {
  early:   [{ dOffset: 0, hour: 6 }],
  morning: [{ dOffset: 0, hour: 6 }],
  noon:    [{ dOffset: 0, hour: 12 }],
  evening: [{ dOffset: 0, hour: 18 }],
  night:   [{ dOffset: 0, hour: 18 }, { dOffset: 1, hour: 0 }],
};

function safeNum(v){
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 短期予報部分から「一次細分区域コード → 日付ごとの天気文・降水確率ブロック」を組み立てる
function parseShortTerm(report){
  const result = {}; // class10Code -> { weatherByDate: {dateKey: text}, popBlocks: {`${dateKey}|${hour}`: pop} }

  for(const ts of (report.timeSeries || [])){
    const timeDefines = ts.timeDefines || [];
    for(const areaEntry of (ts.areas || [])){
      const code = areaEntry.area?.code;
      if(!code) continue;
      if(!result[code]) result[code] = { weatherByDate: {}, popBlocks: {} };

      if(Array.isArray(areaEntry.weathers)){
        areaEntry.weathers.forEach((text, i) => {
          const t = parseJstIso(timeDefines[i]);
          if(t && text) result[code].weatherByDate[t.dateKey] = text;
        });
      }
      if(Array.isArray(areaEntry.pops)){
        areaEntry.pops.forEach((pop, i) => {
          const t = parseJstIso(timeDefines[i]);
          if(!t) return;
          const p = safeNum(pop);
          if(p === null) return;
          result[code].popBlocks[`${t.dateKey}|${t.hour}`] = p;
        });
      }
    }
  }
  return result;
}

// 週間予報部分から「一次細分区域コード（または府県単位コード） → 日付ごとの
// 天気コード・降水確率（日別・粗い）」を組み立てる
function parseWeekly(report){
  const result = {}; // code -> { popByDate: {dateKey: pop}, codeByDate: {dateKey: weatherCode} }
  for(const ts of (report.timeSeries || [])){
    const timeDefines = ts.timeDefines || [];
    for(const areaEntry of (ts.areas || [])){
      const code = areaEntry.area?.code;
      if(!code) continue;
      if(!result[code]) result[code] = { popByDate: {}, codeByDate: {} };
      if(Array.isArray(areaEntry.pops)){
        areaEntry.pops.forEach((pop, i) => {
          const t = parseJstIso(timeDefines[i]);
          if(!t) return;
          const p = safeNum(pop);
          if(p !== null) result[code].popByDate[t.dateKey] = p;
        });
      }
      if(Array.isArray(areaEntry.weatherCodes)){
        areaEntry.weatherCodes.forEach((wc, i) => {
          const t = parseJstIso(timeDefines[i]);
          if(t && wc) result[code].codeByDate[t.dateKey] = wc;
        });
      }
    }
  }
  return result;
}

// 指定した一次細分区域コードについて、日付(dateKey)・スロットキーに対応する
// 降水確率と「雷」文言の有無を取り出す。短期予報になければ週間予報にフォールバックする。
export function lookupPopAndThunder(parsed, class10Code, dateKey, slotKey){
  const short = parsed.short[class10Code];
  const weekly = parsed.weekly[class10Code] || parsed.weeklyByOfficeFallback;

  let pop = null;
  if(short){
    const blocks = SLOT_BLOCK_MAP[slotKey] || [{ dOffset: 0, hour: 12 }];
    const vals = [];
    for(const b of blocks){
      const d = b.dOffset === 0 ? dateKey : addDaysToDateKey(dateKey, b.dOffset);
      const v = short.popBlocks[`${d}|${b.hour}`];
      if(typeof v === 'number') vals.push(v);
    }
    if(vals.length) pop = vals.reduce((a, c) => a + c, 0) / vals.length;
  }
  if(pop === null && weekly && typeof weekly.popByDate[dateKey] === 'number'){
    pop = weekly.popByDate[dateKey];
  }

  let hasThunder = false;
  if(short && short.weatherByDate[dateKey]){
    hasThunder = /雷/.test(short.weatherByDate[dateKey]);
  } else if(weekly && weekly.codeByDate[dateKey]){
    // 週間予報の天気コードは大分類のみ。100番台=晴れ,200番台=曇り,300番台=雨 等で、
    // 雷を伴うコードは概ね "3XX"/"4XX" のうち特定コード（例:313,314,326,328,340 等）に対応するが、
    // 網羅的な対応表は非公開のため、ここでは弱いシグナルとして「不明」扱い（雷ありとはみなさない）。
    hasThunder = false;
  }

  return { pop, hasThunder, dataAvailable: pop !== null };
}

export async function fetchForecast(officeCode){
  const raw = await fetchJson(FORECAST_URL(officeCode));
  // raw は通常 [短期予報, 週間予報] の配列。稀に1要素のみのオフィスもあるため防御的に扱う。
  const shortReport = Array.isArray(raw) ? raw[0] : raw;
  const weeklyReport = Array.isArray(raw) && raw.length > 1 ? raw[1] : null;

  return {
    short: parseShortTerm(shortReport || {}),
    weekly: weeklyReport ? parseWeekly(weeklyReport) : {},
    reportDatetime: shortReport?.reportDatetime || null,
  };
}

const ACTIVE_STATUSES = new Set(['発表', '継続']);

// 警報注意報JSONをパースし、class20コードごとの「発表中の警報・注意報コード集合」を返す。
export async function fetchWarnings(officeCode){
  const raw = await fetchJson(WARNING_URL(officeCode));
  const areaTypes = raw.areaTypes || [];
  const class20Warnings = {}; // class20Code -> Set<string warningCode>

  // areaTypes[1] が class20（二次細分区域）単位である想定だが、念のため
  // 「エリアコードが7桁」かどうかでも判定する（class10は6桁想定）。
  const targetLayer = areaTypes.find(layer =>
    (layer.areas || []).some(a => a.code && String(a.code).length === 7)
  ) || areaTypes[areaTypes.length - 1];

  for(const areaEntry of (targetLayer?.areas || [])){
    const code = areaEntry.code;
    if(!code) continue;
    const set = new Set();
    for(const w of (areaEntry.warnings || [])){
      if(w.code && ACTIVE_STATUSES.has(w.status)) set.add(w.code);
    }
    class20Warnings[code] = set;
  }

  return { class20Warnings, reportDatetime: raw.reportDatetime || null, headlineText: raw.headlineText || '' };
}

// officeCode単位でまとめて取得し、片方が失敗しても他方は使えるようにする。
export async function fetchOfficeData(officeCode){
  const [forecastRes, warningRes] = await Promise.allSettled([
    fetchForecast(officeCode),
    fetchWarnings(officeCode),
  ]);

  return {
    forecast: forecastRes.status === 'fulfilled' ? forecastRes.value : null,
    forecastError: forecastRes.status === 'rejected' ? String(forecastRes.reason) : null,
    warnings: warningRes.status === 'fulfilled' ? warningRes.value : null,
    warningsError: warningRes.status === 'rejected' ? String(warningRes.reason) : null,
  };
}

export const WARNING_CODES = {
  THUNDER_ADVISORY: '14',   // 雷注意報
  HEAVY_RAIN_WARNING: '03', // 大雨警報
  FLOOD_WARNING: '04',      // 洪水警報
  STORM_WARNING: '05',      // 暴風警報
  HEAVY_SNOW_WARNING: '06', // 大雪警報
};

export { parseJstIso, addDaysToDateKey };
