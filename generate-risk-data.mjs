// ------------------------------------------------------------------
// GitHub Actions（.github/workflows/update-risk-data.yml）から15分おきに実行される
// エントリポイント。実際のデータ取得・指数計算は netlify/functions/update-risk-data-
// background.mjs の computeRiskData() に委譲し、ここでは結果を data/risk-data.json
// に書き出すことだけを行う。
//
// 元々（Netlify運用時）は計算結果をNetlify Blobsに保存していたが、Netlifyの利用制限に
// 達したため、リポジトリ内の静的JSONファイルへ直接コミットする方式に変更した。
// フロントエンド（index.html）は、GitHub Pagesで公開されるこのJSONファイルを
// 直接fetchして表示する。
//
// 【失敗時の扱い】
// computeRiskData()が失敗した場合（area.json自体が取れない等の致命的なエラー時）は、
// 既存のdata/risk-data.jsonを上書きしない（＝直前の正常なデータがそのまま残り、
// フロントエンドはそれを使い続ける）。isExistingNewer()による重複実行時の
// 上書き防止ロジックも、Netlify運用時から引き続き使っている。
// ------------------------------------------------------------------

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeRiskData, isExistingNewer } from '../netlify/functions/update-risk-data-background.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(REPO_ROOT, 'data', 'risk-data.json');

async function readExisting(){
  try{
    const raw = await readFile(OUT_PATH, 'utf8');
    return JSON.parse(raw);
  }catch(e){
    return null; // 初回実行やファイルが無い場合はnull（=常に書き込みを許可）
  }
}

async function main(){
  const existing = await readExisting();
  const result = await computeRiskData();

  if(!result.ok){
    console.error('[generate-risk-data] computeRiskData failed:', result.diagnostics?.fatalError);
    console.error('[generate-risk-data] 既存のdata/risk-data.jsonは上書きせず、処理を終了します。');
    process.exitCode = 1;
    return;
  }

  // 既存ファイルの方が新しい生成時刻を持つ場合はスキップする
  // （手動実行と定期実行が重なった場合の保護。通常はまず発生しない）。
  const existingAsResult = existing ? { ok: existing.available, generatedAt: existing.generatedAt } : null;
  if(isExistingNewer(existingAsResult, result)){
    console.log('[generate-risk-data] 既存データの方が新しいためスキップしました。generatedAt=', existing?.generatedAt);
    return;
  }

  const payload = {
    available: true,
    generatedAt: result.generatedAt,
    currentSlotIdx: result.currentSlotIdx,
    dateKeys: result.dateKeys,
    prefScores: result.prefScores,
    cityScores: result.cityScores,
    nowContextByPref: result.nowContextByPref,
    matchStats: result.diagnostics?.matchStats || null,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(payload), 'utf8');

  const d = result.diagnostics || {};
  console.log('[generate-risk-data] wrote', OUT_PATH);
  console.log('[generate-risk-data] generatedAt=', result.generatedAt, 'durationMs=', d.durationMs);
  console.log('[generate-risk-data] officeErrors=', d.officeErrors?.length ?? 0,
    'lightningErrors=', d.lightningErrors?.length ?? 0,
    'precipNowcastErrors=', d.precipNowcastErrors?.length ?? 0,
    'instabilityErrors=', d.instabilityErrors?.length ?? 0);
  console.log('[generate-risk-data] cityRealCount=', d.cityRealCount, 'cityFallbackCount=', d.cityFallbackCount);
}

main().catch(e => {
  console.error('[generate-risk-data] unexpected error:', e);
  process.exitCode = 1;
});
