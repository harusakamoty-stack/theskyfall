// Resend (https://resend.com) のREST APIを直接fetchで呼び出す。
// SDK依存を増やさず、APIキーは環境変数からのみ読み込む（コードやリポジトリには一切含めない）。
export async function sendEmail({ to, subject, html }){
  const apiKey = process.env.RESEND_API_KEY;
  if(!apiKey) throw new Error('RESEND_API_KEY is not set');
  const from = process.env.SENDER_EMAIL || 'onboarding@resend.dev';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });

  if(!res.ok){
    const text = await res.text().catch(()=> '');
    throw new Error(`Resend API error (${res.status}): ${text}`);
  }
  return res.json();
}
