import { getStore } from '@netlify/blobs';
import { computeMuniScore, currentSlotIndexJST, currentJstDateKey, SLOTS } from './lib/scoring.mjs';
import { makeToken } from './lib/crypto.mjs';
import { sendEmail } from './lib/mail.mjs';

const ALERT_THRESHOLD = 80;

export default async () => {
  const store = getStore('hail-registrations');
  const { blobs } = await store.list();

  const now = new Date();
  const slotIdx = currentSlotIndexJST(now);
  const dateKey = currentJstDateKey(now);
  const alertKey = `${dateKey}|${slotIdx}`;
  const slot = SLOTS[slotIdx];

  let checked = 0, alerted = 0, skipped = 0, errors = 0;

  for(const b of blobs){
    const record = await store.get(b.key, { type: 'json' }).catch(()=>null);
    if(!record || record.status !== 'active') continue;
    checked++;

    if(record.lastAlertKey === alertKey){ skipped++; continue; } // このスロットでは既に通知済み

    const score = computeMuniScore(record.pref, record.city, 0, slotIdx);
    if(score === null || score < ALERT_THRESHOLD) continue;

    const unsubUrl = `${process.env.URL || ''}/.netlify/functions/unsubscribe?id=${record.id}&token=${makeToken('unsubscribe', record.id)}`;

    try{
      await sendEmail({
        to: record.email,
        subject: `【雹害アラート】${record.pref}${record.city} の降雹指数が${score}%（${slot.label}）`,
        html: `
          <p>登録地域で降雹指数が上昇しています。</p>
          <p><b>${record.pref} ${record.city}</b><br>
          指数：<b>${score}%</b>（${slot.label} ${slot.d}）</p>
          <p>可能であれば、お車をガレージや屋根のある場所へ移動してください。</p>
          <p style="color:#888;font-size:12px;">この指数は気象庁の公開情報を参考にした独自の参考推定値であり、公式の降雹予報ではありません。最終的な判断は気象庁の最新の警報・注意報を必ずご確認ください。</p>
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

  return new Response(JSON.stringify({ ok:true, checked, alerted, skipped, errors, slot: slot.key, dateKey }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { schedule: '0 * * * *' };
