import { getStore } from '@netlify/blobs';
import { findPref } from './lib/scoring.mjs';
import { makeRegistrationId, makeToken } from './lib/crypto.mjs';
import { sendEmail } from './lib/mail.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_REGISTRATIONS_PER_EMAIL = 10;

function json(status, body){
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export default async (req) => {
  if(req.method !== 'POST'){
    return json(405, { ok:false, error:'method not allowed' });
  }

  let body;
  try{
    body = await req.json();
  }catch(e){
    return json(400, { ok:false, error:'invalid JSON' });
  }

  const email = String(body.email || '').trim();
  const pref = String(body.pref || '').trim();
  const city = String(body.city || '').trim();

  if(!EMAIL_RE.test(email)){
    return json(400, { ok:false, error:'メールアドレスの形式が正しくありません' });
  }
  if(!findPref(pref)){
    return json(400, { ok:false, error:'都道府県が正しくありません' });
  }
  if(!city || city.length > 40){
    return json(400, { ok:false, error:'市区町村が正しくありません' });
  }

  const store = getStore('hail-registrations');

  // 同一メールアドレスの登録件数を簡易的に制限（濫用対策）
  const { blobs } = await store.list();
  let countForEmail = 0;
  for(const b of blobs){
    const rec = await store.get(b.key, { type: 'json' }).catch(()=>null);
    if(rec && rec.email === email.toLowerCase()) countForEmail++;
  }
  const id = makeRegistrationId(email, pref, city);
  const alreadyExists = blobs.some(b => b.key === id);
  if(!alreadyExists && countForEmail >= MAX_REGISTRATIONS_PER_EMAIL){
    return json(429, { ok:false, error:'登録できる地域の上限に達しています' });
  }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const existing = await store.get(id, { type: 'json' }).catch(()=>null);

  const RESEND_COOLDOWN_MS = 10 * 60 * 1000; // 同じ宛先への確認メール再送は10分に1回まで（スパム対策）
  const lastSentMs = existing?.lastConfirmationSentAt ? Date.parse(existing.lastConfirmationSentAt) : 0;
  const withinCooldown = existing?.status === 'pending' && (nowMs - lastSentMs) < RESEND_COOLDOWN_MS;

  const record = {
    id,
    email: email.toLowerCase(),
    pref,
    city,
    status: existing?.status === 'active' ? 'active' : 'pending', // 既にconfirm済みならactiveを維持
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastAlertKey: existing?.lastAlertKey || null,
    lastConfirmationSentAt: existing?.lastConfirmationSentAt || null,
  };
  await store.setJSON(id, record);

  if(withinCooldown){
    // 直近で確認メールを送ったばかりなので、再送はスキップ（他人のメールアドレスへの連続送信を防止）
    return json(200, { ok:true, status: record.status });
  }

  // pendingの場合のみ確認メールを送信（activeなら再送しない＝再登録での過剰送信を防止）
  if(record.status === 'pending'){
    const token = makeToken('confirm', id);
    const base = new URL(req.url).origin;
    const confirmUrl = `${base}/.netlify/functions/confirm?id=${id}&token=${token}`;
    const unsubUrl = `${base}/.netlify/functions/unsubscribe?id=${id}&token=${makeToken('unsubscribe', id)}`;

    try{
      await sendEmail({
        to: record.email,
        subject: '【愛車雹アラート】通知登録の確認',
        html: `
          <p>愛車雹アラートで、以下の地域のメール通知登録を受け付けました。</p>
          <p><b>${record.pref} ${record.city}</b></p>
          <p>このメールアドレスの登録を確認し、通知を有効にするには、以下のリンクをクリックしてください。</p>
          <p><a href="${confirmUrl}">${confirmUrl}</a></p>
          <p>ご自身で登録されていない場合は、このメールは無視していただいて構いません（クリックしない限り通知は有効になりません）。</p>
          <hr>
          <p style="color:#888;font-size:12px;">通知の解除はいつでもこちらから：<a href="${unsubUrl}">${unsubUrl}</a></p>
        `,
      });
      record.lastConfirmationSentAt = now;
      await store.setJSON(id, record);
    }catch(e){
      // メール送信に失敗しても登録自体は保存済み。エラーを返してユーザーに再試行を促す。
      return json(502, { ok:false, error:'確認メールの送信に失敗しました。時間を置いて再度お試しください。' });
    }
  }

  return json(200, { ok:true, status: record.status });
};
