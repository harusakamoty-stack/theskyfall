import { getStore } from '@netlify/blobs';
import { verifyToken } from './lib/crypto.mjs';

function html(status, body){
  return new Response(
    `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>雹害アラート</title>
    <style>
      body{font-family:'Noto Sans JP',sans-serif; background:#080b14; color:#e9edf7; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:20px;}
      .card{max-width:420px; text-align:center; background:#11172a; border:1px solid #232c45; border-radius:14px; padding:32px 28px;}
      h1{font-size:18px; margin-bottom:12px;}
      p{font-size:14px; color:#8a93b3; line-height:1.7;}
      a{color:#7fe7ff;}
    </style></head><body><div class="card">${body}</div></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export default async (req) => {
  const url = new URL(req.url);
  const id = url.searchParams.get('id') || '';
  const token = url.searchParams.get('token') || '';

  if(!id || !verifyToken('confirm', id, token)){
    return html(400, '<h1>リンクが正しくありません</h1><p>お手数ですが、アプリから再度登録をお試しください。</p>');
  }

  const store = getStore('hail-registrations');
  const record = await store.get(id, { type: 'json' }).catch(()=>null);
  if(!record){
    return html(404, '<h1>登録が見つかりません</h1><p>既に解除されている可能性があります。</p>');
  }

  record.status = 'active';
  record.updatedAt = new Date().toISOString();
  await store.setJSON(id, record);

  return html(200, `<h1>登録を確認しました</h1><p><b>${record.pref} ${record.city}</b><br>の降雹アラートが有効になりました。<br>このメールアドレスへの通知をいつでも解除できます（各通知メール内のリンクから）。</p>`);
};
