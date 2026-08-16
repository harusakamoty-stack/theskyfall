// ------------------------------------------------------------------
// 実データ（気象庁 天気予報JSON・警報注意報JSON・雷ナウキャスト）に基づく
// 降雹ポテンシャル指数 v2 の算出ロジック。
//
// 【設計方針】
// ・「今日・現在時刻に最も近いスロット」だけは、警報注意報（雷注意報等）と
//   雷ナウキャストという“実況に近い”シグナルを反映する。
// ・それ以外（今日の他の時間帯、明日・明後日・3日後）は、気象庁の予報JSONに
//   含まれる降水確率・天気文（「雷」の記載有無）のみを使う。警報や雷ナウキャストは
//   未来の時刻には存在しないため、正直に「予報ベースの粗い推定」として扱う。
// ・v1（静的テーブル）にあった「山沿い・内陸ボーナス」「時間帯係数」
//   「べき乗による下側圧縮カーブ」は、実データを使うようになった後も
//   気象学的に妥当な補正として引き続き使用する。
// ・v1にあった「地名文字列から機械的に算出した±5のダミー変動」は廃止した。
//   実データ（警報の市区町村クラスタ差等）が既に地域差を表現するため、
//   演出目的の疑似乱数は不要と判断したため。
// ------------------------------------------------------------------

import { MOUNTAIN_BONUS, SLOTS } from './scoring.mjs';
import { WARNING_CODES } from './jma-fetch.mjs';

const HAIL_CURVE_K = 1.45;
const SEVERE_WARNING_CODES = new Set([
  WARNING_CODES.HEAVY_RAIN_WARNING,
  WARNING_CODES.FLOOD_WARNING,
  WARNING_CODES.STORM_WARNING,
  WARNING_CODES.HEAVY_SNOW_WARNING,
]);

function hasMountainBonus(prefName){
  const core = prefName.replace(/(都|道|府|県)$/, '');
  return MOUNTAIN_BONUS.has(core);
}

// 1地点・1日・1スロット分の指数を計算する。
//   pop            : 降水確率（0-100）。取得できなければnull。
//   hasThunder     : 天気文に「雷」の記載があるか
//   warningCodes   : 現在有効な警報注意報コードのSet（"now"スロットのみ意味を持つ）
//   lightningLevel : 雷ナウキャスト活動度 0-4（"now"スロットのみ意味を持つ、都道府県代表地点）
//   includeNowSignals: このスロットが「現在時刻に最も近いスロット」かどうか
//   prefName       : 山沿いボーナス判定用
//   slotIdx        : SLOTSのインデックス（時間帯係数用）
//   instabilityScore    : Open-Meteo由来のCAPE/Lifted Index/CIN/0℃高度から算出した
//                         簡易対流不安定度0-100（lib/open-meteo.mjs）。JMAの警報・雷
//                         ナウキャストと違い、予報モデル由来のため"now"以外の
//                         日・スロットでも利用できる（＝未来日の精度改善の主眼）。
//                         取得できなければnull。
//   precipNowcastLevel  : 高解像度降水ナウキャストの実況降水強度0-4
//                         （"now"スロットのみ意味を持つ、都道府県代表地点）。
//   pressureTrendHpaPer3h: 海面更正気圧の3時間変化(hPa)。負に大きいほど気圧が
//                         急降下＝前線・低気圧接近の目安（"now"スロットのみ）。
//                         あくまで補助的な弱いシグナルとして小さめの重みで扱う。
export function computeAreaScore({
  pop,
  hasThunder,
  warningCodes,
  lightningLevel,
  includeNowSignals,
  prefName,
  slotIdx,
  instabilityScore = null,
  precipNowcastLevel = null,
  pressureTrendHpaPer3h = null,
}){
  let base = 0;
  const popAvailable = typeof pop === 'number';
  const instabilityAvailable = typeof instabilityScore === 'number';
  // popだけでなくinstabilityScore(CAPE等)のどちらか一方でも取れていれば
  // 「実データに基づく」とみなす。CAPE等は気象庁の予報とは別経路(Open-Meteo)
  // で取得しているため、片方が失敗しても他方でカバーできる。
  const dataAvailable = popAvailable || instabilityAvailable;

  if(instabilityAvailable){
    // CAPE等の実際の大気安定度データがあれば、それを主軸(重み0.7)としつつ、
    // 降水確率を「そもそも湿り気があるか」の目安として少し織り込む(重み0.3)。
    // 降水確率が低いのにCAPEだけ高いケース（雨雲が実際には来ない空振り）を
    // 過大評価しすぎないようにするための配分。
    const popPart = popAvailable ? pop * 0.6 : 20;
    base += instabilityScore * 0.7 + popPart * 0.3;
  } else if(popAvailable){
    base += pop * 0.6; // 降水確率をベースの不安定度に緩やかに反映(最大60)
  } else {
    base += 20; // 予報データが一切取得できない場合の中立的なデフォルト値
  }

  if(hasThunder) base += 25;

  let usedNowSignals = false;
  if(includeNowSignals){
    if(warningCodes?.has(WARNING_CODES.THUNDER_ADVISORY)){ base += 30; usedNowSignals = true; }
    if(warningCodes && [...SEVERE_WARNING_CODES].some(c => warningCodes.has(c))){
      base += 20;
      usedNowSignals = true;
    }
    if(typeof lightningLevel === 'number' && lightningLevel > 0){
      base += lightningLevel * 12;
      usedNowSignals = true;
    }
    if(typeof precipNowcastLevel === 'number' && precipNowcastLevel > 0){
      base += precipNowcastLevel * 10;
      usedNowSignals = true;
    }
    if(typeof pressureTrendHpaPer3h === 'number' && pressureTrendHpaPer3h <= -1.5){
      base += 5; // 気圧急降下は補助シグナルとして小さめの加点にとどめる
      usedNowSignals = true;
    }
  }

  if(hasMountainBonus(prefName)) base += 9;

  base = Math.min(100, base);
  const mult = SLOTS[slotIdx]?.mult ?? 1;
  const instability = Math.min(100, base * mult);
  const hail = Math.pow(instability / 100, HAIL_CURVE_K) * 100;
  const score = Math.max(1, Math.min(97, Math.round(hail)));

  return { score, dataAvailable, usedNowSignals };
}

export { HAIL_CURVE_K, SEVERE_WARNING_CODES };
