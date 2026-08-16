import { getStore } from '@netlify/blobs';
import { computeMuniScore, currentSlotIndexJST, currentJstDateKey, SLOTS } from './lib/scoring.mjs';
import { makeToken } from './lib/crypto.mjs';
import { sendEmail } from './lib/mail.mjs';

const ALERT_THRESHOLD = 80;
const RISK_STORE = 'hail-risk-data';
const RISK_KEY = 'latest';

export function riskLabel(v){
  if(v < 20) return '低い';
  if(v < 40) return 'やや低い';
  if(v < 60) return '中程度';
  if(v < 80) return '高い';
  return '非常に高い';
}

// 実データ（update-risk-data-background.mjsが書き込んだ最新スナップショット）から
// 該当地域・現在時間帯のスコアを取り出す。見つからない場合、または実シグナル
// （降水確率取得成功、もしくは警報・雷ナウキャストの反映）が一切無く中立値のみで
// 埋められている場合はnullを返し、呼び出し側でv1の静的推定式にフォールバックする。
// hasRealSignalを見ずにscoreの有無だけで判定すると、気象台のデータ取得が丸ごと
// 失敗した地域でも常に「中立値」が実データとして扱われてしまい、フォールバックが
// 一切発動しなくなる（＝v1フォールバックが死んでいるコードパスになる）バグがあった。
export function resolveRealScore(riskData, pref, city, dayIdx, slotIdx){
  if(!riskData || !riskData.ok) return null;
  const entry = riskData.cityScores?.[pref]?.[city];
  const cell = entry?.days?.[dayIdx]?.[slotIdx];
  if(!cell || !cell.hasRealSignal) return null;
  return typeof cell.score === 'number' ? cell.score : null;
}

export default async () => {
  const store = getStore('hail-registrations');
  const { blobs } = await store.list();

  const now = new Date();
  const slotIdx = currentSlotIndexJST(now);
  const dateKey = currentJstDateKey(now);
  const alertKey = `${dateKey}|${slotIdx}`;
  const slot = SLOTS[slotIdx];

  // 実データスナップショットは全登録レコードで共通のため、ループの外で1回だけ読む。
  let riskData = null;
  try{
    const riskStore = getStore(RISK_STORE);
    riskData = await riskStore.get(RISK_KEY, { type: 'json' });
  }catch(e){
    riskData = null; // 読めなくても致命的ではない（全件v1にフォールバックするだけ）
  }

  let checked = 0, alerted = 0, skipped = 0, errors = 0;
  let usedRealData = 0, usedFallback = 0;

  for(const b of blobs){
    const record = await store.get(b.key, { type: 'json' }).catch(()=>null);
    if(!record || record.status !== 'active') continue;
    checked++;

    if(record.lastAlertKey === alertKey){ skipped++; continue; } // このスロットでは既に通知済み

    let score = resolveRealScore(riskData, record.pref, record.city, 0, slotIdx);
    if(score !== null){
      usedRealData++;
    } else {
      score = computeMuniScore(record.pref, record.city, 0, slotIdx);
      usedFallback++;
    }
    if(score === null || score < ALERT_THRESHOLD) continue;

    const unsubUrl = `${process.env.URL || ''}/.netlify/functions/unsubscribe?id=${record.id}&token=${makeToken('unsubscribe', record.id)}`;

    try{
      await sendEmail({
        to: record.email,
        subject: `【雹害アラート】${record.pref}${record.city} の警戒レベルが「${riskLabel(score)}」（${slot.label}）`,
        html: `
          <p>登録地域で降雹指数が上昇しています。</p>
          <p><b>${record.pref} ${record.city}</b><br>
          警戒レベル：<b>${riskLabel(score)}</b>（指数 ${score} / 100・${slot.label} ${slot.d}）</p>
          <p>可能であれば、お車をガレージや屋根のある場所へ移動してください。</p>
          <p style="color:#888;font-size:12px;">この指数は気象庁の公開情報（天気予報・警報注意報・雷ナウキャスト等）を参考にした独自の参考推定値であり、公式の降雹予報ではありません。最終的な判断は気象庁の最新の警報・注意報を必ずご確認ください。</p>
          <hr>
          <p style="color:#888;font-size:12px;">通知の解除はこちら：<a href="${unsubUrl}">${unsubUrl}</a></p>
        `,
      });
      record.lastAlertKey = alertKey;
      record.updatedAt = new Date().toISOString();
      await store.setJSON(record.id, record);
      alerted++;
    }catch(e){
      errors++;
    }
  }

  return new Response(JSON.stringify({
    ok: true, checked, alerted, skipped, errors,
    usedRealData, usedFallback,
    riskDataAvailable: !!riskData?.ok,
    slot: slot.key, dateKey,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { schedule: '0 * * * *' };
