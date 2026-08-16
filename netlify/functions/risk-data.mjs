// ------------------------------------------------------------------
// フロントエンド（index.html）が読み込む、実データに基づく最新の降雹指数を
// 返すだけのシンプルなGETエンドポイント。
//
// update-risk-data-background.mjs が15分おきに書き込んだ最新スナップショットを
// そのまま返す。まだ一度も更新バッチが走っていない場合や保存が空の場合は
// available:false を返し、フロントエンド側はv1の静的推定式にフォールバックする。
//
// レスポンスは軽量化のため、診断情報（diagnostics）は要約のみ含める
// （officeErrors/lightningErrorsの詳細配列はフロントエンドには不要なため省く）。
// ------------------------------------------------------------------

import { getStore } from '@netlify/blobs';

const RISK_STORE = 'hail-risk-data';
const RISK_KEY = 'latest';
const STALE_AFTER_MS = 60 * 60 * 1000; // 1時間以上更新が無ければ「古い」とフラグする

export default async () => {
  let stored = null;
  try{
    const store = getStore(RISK_STORE);
    stored = await store.get(RISK_KEY, { type: 'json' });
  }catch(e){
    return json({ available: false, reason: 'blob-read-failed' });
  }

  if(!stored || !stored.ok){
    return json({ available: false, reason: 'no-data-yet' });
  }

  const generatedAtMs = Date.parse(stored.generatedAt || '');
  const stale = !Number.isFinite(generatedAtMs) || (Date.now() - generatedAtMs) > STALE_AFTER_MS;

  return json({
    available: true,
    stale,
    generatedAt: stored.generatedAt,
    currentSlotIdx: stored.currentSlotIdx,
    dateKeys: stored.dateKeys,
    prefScores: stored.prefScores,
    cityScores: stored.cityScores,
    nowContextByPref: stored.nowContextByPref || null,
    matchStats: stored.diagnostics?.matchStats || null,
  });
};

function json(body){
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // 複数ユーザーが同時にアクセスしても毎回Blobsを読みに行かなくて済むよう、
      // CDN/ブラウザに短時間のキャッシュを許可する。更新バッチは15分間隔なので
      // 5分キャッシュでも実用上問題ない。
      'Cache-Control': 'public, max-age=300',
    },
  });
}
