// ------------------------------------------------------------------
// フロントエンド（index.html）内の指数算出ロジックをNode側に移植したものです。
// アプリ側の computeScore / computeMuniScore と同じ結果になるよう、
// 値を変更した場合は必ず両方に反映してください。
// ------------------------------------------------------------------

export const REGION_BASE = {
  hokkaido:      [24,20,18,22],
  tohoku_p:      [48,26,20,42],
  tohoku_j:      [30,22,20,30],
  kanto:         [62,28,22,50],
  koshin:        [50,32,26,44],
  hokuriku:      [34,24,20,32],
  tokai:         [50,26,22,42],
  kinki:         [46,24,20,34],
  chugoku:       [38,22,20,28],
  shikoku:       [36,22,20,28],
  kyushu_n:      [34,24,22,26],
  kyushu_s:      [30,26,24,24],
  okinawa:       [24,22,22,20],
};

export const MOUNTAIN_BONUS = new Set(['群馬','栃木','長野','山梨','岐阜','熊本','宮崎','福島','埼玉']);

// [名称, 短縮名, 地域キー, col, row, size] — col/row/sizeはバックエンドでは未使用
export const PREFS = [
  ['北海道','北海道','hokkaido',13,1,2],
  ['青森県','青森','tohoku_p',13,3,1],
  ['岩手県','岩手','tohoku_p',14,4,1],
  ['秋田県','秋田','tohoku_j',12,4,1],
  ['宮城県','宮城','tohoku_p',14,5,1],
  ['山形県','山形','tohoku_j',12,5,1],
  ['福島県','福島','tohoku_p',13,6,1],
  ['新潟県','新潟','hokuriku',12,7,1],
  ['茨城県','茨城','kanto',14,7,1],
  ['栃木県','栃木','kanto',13,7,1],
  ['群馬県','群馬','kanto',12,8,1],
  ['埼玉県','埼玉','kanto',13,8,1],
  ['千葉県','千葉','kanto',15,8,1],
  ['東京都','東京','kanto',14,9,1],
  ['神奈川県','神奈','kanto',13,9,1],
  ['富山県','富山','hokuriku',11,8,1],
  ['石川県','石川','hokuriku',10,8,1],
  ['福井県','福井','hokuriku',10,9,1],
  ['山梨県','山梨','koshin',12,9,1],
  ['長野県','長野','koshin',11,9,1],
  ['岐阜県','岐阜','tokai',10,10,1],
  ['静岡県','静岡','tokai',13,10,1],
  ['愛知県','愛知','tokai',11,10,1],
  ['三重県','三重','tokai',10,11,1],
  ['滋賀県','滋賀','kinki',9,9,1],
  ['京都府','京都','kinki',8,9,1],
  ['大阪府','大阪','kinki',8,10,1],
  ['兵庫県','兵庫','kinki',7,9,1],
  ['奈良県','奈良','kinki',9,10,1],
  ['和歌山県','和歌','kinki',9,11,1],
  ['鳥取県','鳥取','chugoku',6,9,1],
  ['島根県','島根','chugoku',5,9,1],
  ['岡山県','岡山','chugoku',7,10,1],
  ['広島県','広島','chugoku',6,10,1],
  ['山口県','山口','chugoku',5,10,1],
  ['徳島県','徳島','shikoku',8,11,1],
  ['香川県','香川','shikoku',7,11,1],
  ['愛媛県','愛媛','shikoku',6,11,1],
  ['高知県','高知','shikoku',7,12,1],
  ['福岡県','福岡','kyushu_n',4,10,1],
  ['佐賀県','佐賀','kyushu_n',3,11,1],
  ['長崎県','長崎','kyushu_n',2,11,1],
  ['熊本県','熊本','kyushu_n',3,12,1],
  ['大分県','大分','kyushu_n',4,11,1],
  ['宮崎県','宮崎','kyushu_s',4,12,1],
  ['鹿児島県','鹿児','kyushu_s',3,13,1],
  ['沖縄県','沖縄','okinawa',1,15,1],
];

export const SLOTS = [
  {key:'early',  label:'早朝', d:'5-9時',  mult:0.60, startHour:5,  endHour:9},
  {key:'morning',label:'午前', d:'9-12時', mult:0.80, startHour:9,  endHour:12},
  {key:'noon',   label:'午後', d:'12-17時',mult:1.20, startHour:12, endHour:17},
  {key:'evening',label:'夕方', d:'17-21時',mult:1.05, startHour:17, endHour:21},
  {key:'night',  label:'夜間', d:'21-5時', mult:0.50, startHour:21, endHour:5},
];

const HAIL_CURVE_K = 1.45;

export function hashVariance(name){
  let h = 0;
  for(let i=0;i<name.length;i++){ h = (h*31 + name.charCodeAt(i)) % 997; }
  return (h % 11) - 5; // -5..5
}

export function computeScore(pref, dayIdx, slotIdx){
  const base = REGION_BASE[pref[2]][dayIdx];
  const bonus = MOUNTAIN_BONUS.has(pref[0].replace('都','').replace('府','').replace('県','')) ? 9 : 0;
  const instability = Math.min(100, (base + bonus) * SLOTS[slotIdx].mult);
  const hail = Math.pow(instability / 100, HAIL_CURVE_K) * 100;
  const variance = hashVariance(pref[0]);
  return Math.max(1, Math.min(96, Math.round(hail + variance)));
}

export function computeMuniScore(prefName, muniName, dayIdx, slotIdx){
  const pref = PREFS.find(p => p[0] === prefName);
  if(!pref) return null;
  const prefScore = computeScore(pref, dayIdx, slotIdx);
  const v = hashVariance(prefName + '|' + muniName);
  return Math.max(1, Math.min(97, Math.round(prefScore + v*1.3)));
}

export function findPref(prefName){
  return PREFS.find(p => p[0] === prefName) || null;
}

// 現在の日本時間（JST）から、アプリの「今日」(dayIdx=0)に対応する時間帯(slotIdx)を決定する。
// アプリ側のDAYSは固定表示のデモ日程のため、バックエンドは常にdayIdx=0（今日）を基準に、
// 実時刻に応じたslotだけを動的に決定する。
export function currentSlotIndexJST(now = new Date()){
  const jstHour = (now.getUTCHours() + 9) % 24;
  if(jstHour >= 21 || jstHour < 5) return 4;  // night 21-5
  if(jstHour >= 5 && jstHour < 9) return 0;   // early 5-9
  if(jstHour >= 9 && jstHour < 12) return 1;  // morning 9-12
  if(jstHour >= 12 && jstHour < 17) return 2; // noon 12-17
  return 3; // evening 17-21
}

export function currentJstDateKey(now = new Date()){
  const jst = new Date(now.getTime() + 9*60*60*1000);
  return jst.toISOString().slice(0,10); // YYYY-MM-DD (JST基準)
}

// 現在のJST時（0〜23）。気圧の3時間変化など、5区分のslotではなく実際の
// 時刻そのものが必要な補助シグナルの計算に使う。
export function currentJstHour(now = new Date()){
  return (now.getUTCHours() + 9) % 24;
}
