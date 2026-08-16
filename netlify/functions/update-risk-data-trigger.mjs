// ------------------------------------------------------------------
// 15分おきに実行される軽量な起爆スケジュール関数。
// Scheduled Functionの実行時間制限（30秒）に収まるよう、実際の重い処理
// （気象庁データの取得・雷ナウキャスト解析・指数算出）は行わず、
// Background Function（update-risk-data-background.mjs, 最大15分）を
// 呼び出すだけに徹する。
// ------------------------------------------------------------------

export default async () => {
  const base = process.env.URL || process.env.DEPLOY_URL || '';
  if(!base){
    return new Response(JSON.stringify({ ok: false, error: 'no-base-url' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try{
    // Background Functionは呼び出すと即座に202を返し、裏側で処理が継続する。
    await fetch(`${base}/.netlify/functions/update-risk-data-background`, { method: 'POST' });
    return new Response(JSON.stringify({ ok: true, triggered: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }catch(e){
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { schedule: '*/15 * * * *' };
