// ------------------------------------------------------------------
// 実データに基づく降雹ポテンシャル指数の更新バッチ（Netlify Background Function）。
//
// スケジュール実行の update-risk-data-trigger.mjs から呼び出され、以下を行う:
//   1. JMAのエリアマスター(area.json)を取得し、都道府県⇔気象台、市区町村⇔二次細分区域
//      の対応表を構築する（lib/jma-area.mjs）。
//   2. 対応する気象台ごとに天気予報JSON・警報注意報JSONを取得する（lib/jma-fetch.mjs）。
//   3. 都道府県庁所在地の代表地点について、雷ナウキャスト（lib/lightning.mjs）と
//      高解像度降水ナウキャスト（lib/precip-nowcast.mjs）の実況を判定する。
//   3.5. 同じ代表地点についてOpen-Meteo（lib/open-meteo.mjs）からCAPE・Lifted
//      Index・CIN・0℃高度等を取得する。気象庁は無償でこれらの数値を公開して
//      いないための代替データ源。予報モデル由来のため4日分すべての日・スロットで
//      使える点がJMAの警報・雷ナウキャスト（"now"のみ）と異なる。
//   4. 上記を組み合わせて、都道府県・市区町村 × 4日分 × 5時間帯の指数を算出する
//      （lib/risk-scoring-v2.mjs）。
//   5. 結果を Netlify Blobs に保存し、フロントエンド・アラート判定の両方から
//      参照できるようにする。
//
// Background Function（ファイル名に -background サフィックス）として実行することで、
// 通常の同期関数(60秒)やScheduled Function(30秒)の制限を超え、最大15分の実行時間を使える。
// 実際に外部（jma.go.jp）へ100件以上のリクエストを送るため、この余裕が必要。
//
// 【失敗時の扱い】
// このバッチが何らかの理由で失敗しても、フロントエンド・check-and-alertは
// 「最新の保存済みデータがなければv1の静的推定式にフォールバックする」設計のため、
// アプリ自体が止まることはない。ただし失敗が続くとデータが古くなるため、
// 診断情報（diagnostics）を必ず保存し、後から確認できるようにしている。
// ------------------------------------------------------------------

import { getStore } from '@netlify/blobs';
import { getAreaMaster, officesByPrefecture, matchMunicipalitiesToClass20 } from './lib/jma-area.mjs';
import { fetchOfficeData, addDaysToDateKey } from './lib/jma-fetch.mjs';
import { lookupPopAndThunder } from './lib/jma-fetch.mjs';
import { getLightningLevel } from './lib/lightning.mjs';
import { getPrecipNowcastLevel } from './lib/precip-nowcast.mjs';
import { fetchInstabilityData, lookupInstability, computeInstabilityScore, computePressureTrend } from './lib/open-meteo.mjs';
import { computeAreaScore } from './lib/risk-scoring-v2.mjs';
import { PREFS, SLOTS, currentSlotIndexJST, currentJstDateKey, currentJstHour } from './lib/scoring.mjs';
import { PREF_CAPITAL_COORDS } from './lib/pref-coords.mjs';
import { MUNI_LIST } from './lib/muni-list.mjs';

const DAY_COUNT = 4;
const CONCURRENCY = 6;
const RISK_STORE = 'hail-risk-data';
const RISK_KEY = 'latest';

export async function mapWithConcurrency(items, limit, fn){
  const results = new Array(items.length);
  let idx = 0;
  async function worker(){
    while(idx < items.length){
      const cur = idx++;
      try{
        results[cur] = await fn(items[cur], cur);
      }catch(e){
        results[cur] = { __error: String(e) };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function slotKeyName(slotIdx){
  return SLOTS[slotIdx]?.key || 'noon';
}

// 実処理本体。Netlifyハンドラから分離し、単体テストから直接呼び出して
// 保存前の完全な結果（都道府県・市区町村ごとのスコア等）を検証できるようにしている。
export async function computeRiskData(){
  const startedAt = Date.now();
  const diagnostics = {
    startedAt: new Date(startedAt).toISOString(),
    steps: [],
    officeErrors: [],
    lightningErrors: [],
    precipNowcastErrors: [],
    instabilityErrors: [],
  };

  // --- 1. エリアマスターの取得とマッチング -------------------------------
  let area, matched, matchStats, class20Info, officesByPref;
  try{
    const areaResult = await getAreaMaster();
    area = areaResult.area;
    diagnostics.areaMasterFromCache = areaResult.fromCache;
    const matchResult = matchMunicipalitiesToClass20(area);
    matched = matchResult.matched;
    matchStats = matchResult.stats;
    class20Info = matchResult.class20Info;
    officesByPref = officesByPrefecture(area);
    diagnostics.steps.push('area-master-ok');
  }catch(e){
    diagnostics.steps.push('area-master-FAILED');
    diagnostics.fatalError = String(e);
    return { ok: false, diagnostics, generatedAt: new Date().toISOString() };
  }

  // --- 2. 気象台コードごとに天気予報・警報注意報を取得（重複排除して1回ずつ） ---
  const allOfficeCodes = [...new Set(Object.values(officesByPref).flat())];
  const officeDataList = await mapWithConcurrency(allOfficeCodes, CONCURRENCY, async (code) => {
    const data = await fetchOfficeData(code);
    if(data.forecastError) diagnostics.officeErrors.push({ code, type: 'forecast', error: data.forecastError });
    if(data.warningsError) diagnostics.officeErrors.push({ code, type: 'warnings', error: data.warningsError });
    return { code, data };
  });
  const officeDataByCode = {};
  for(const entry of officeDataList){
    if(entry?.code) officeDataByCode[entry.code] = entry.data;
  }
  diagnostics.steps.push(`office-fetch-done(${allOfficeCodes.length})`);

  // --- 3. 都道府県代表地点の雷ナウキャスト・高解像度降水ナウキャスト判定 -----
  // 同じ代表地点（県庁所在地）を使うため、2つのタイル取得をまとめて行う。
  const prefNames = PREFS.map(p => p[0]);
  const nowcastList = await mapWithConcurrency(prefNames, CONCURRENCY, async (prefName) => {
    const coord = PREF_CAPITAL_COORDS[prefName];
    if(!coord) return { prefName, lightning: { level: 0, ok: false, reason: 'no-coord' }, precip: { level: 0, ok: false, reason: 'no-coord' } };
    const [lightning, precip] = await Promise.all([
      getLightningLevel(coord[0], coord[1]),
      getPrecipNowcastLevel(coord[0], coord[1]),
    ]);
    if(!lightning.ok) diagnostics.lightningErrors.push({ prefName, reason: lightning.reason });
    if(!precip.ok) diagnostics.precipNowcastErrors.push({ prefName, reason: precip.reason });
    return { prefName, lightning, precip };
  });
  const lightningByPref = {};
  const precipNowcastByPref = {};
  for(const entry of nowcastList){
    lightningByPref[entry.prefName] = entry.lightning;
    precipNowcastByPref[entry.prefName] = entry.precip;
  }
  diagnostics.steps.push('nowcast-sampling-done(lightning+precip)');

  // --- 3.5. 都道府県代表地点のOpen-Meteo大気安定度データ取得 -----------------
  // JMAの警報・雷ナウキャストと違い、これは予報モデル由来のため4日分すべての
  // 日・スロットで使える（＝未来日の精度が上がる主な理由）。データ量が大きい
  // ため、都道府県代表地点のみ（市区町村ごとには取得しない）にとどめている。
  const instabilityList = await mapWithConcurrency(prefNames, CONCURRENCY, async (prefName) => {
    const coord = PREF_CAPITAL_COORDS[prefName];
    if(!coord) return { prefName, parsed: null, ok: false, reason: 'no-coord' };
    try{
      const parsed = await fetchInstabilityData(coord[0], coord[1]);
      return { prefName, parsed, ok: true };
    }catch(e){
      diagnostics.instabilityErrors.push({ prefName, reason: String(e) });
      return { prefName, parsed: null, ok: false, reason: String(e) };
    }
  });
  const instabilityByPref = {};
  for(const entry of instabilityList) instabilityByPref[entry.prefName] = entry.parsed;
  diagnostics.steps.push('instability-fetch-done(open-meteo)');

  // --- 4. 日付・時間帯の準備 ----------------------------------------------
  const now = new Date();
  const currentSlotIdx = currentSlotIndexJST(now);
  const currentHour = currentJstHour(now);
  const today = currentJstDateKey(now);
  const dateKeys = Array.from({ length: DAY_COUNT }, (_, i) => addDaysToDateKey(today, i));

  // 都道府県代表地点のOpen-Meteo/降水ナウキャストデータから、指定の日・スロット
  // 向けの補助シグナルをまとめて取り出すヘルパー。都道府県・市区町村どちらの
  // スコア算出でも同じ代表地点のデータを使うため、両ループから共通で呼び出す。
  function computeAuxSignals(prefName, dateKey, slotIdx, includeNowSignals){
    const parsed = instabilityByPref[prefName];
    let instabilityScore = null;
    let pressureTrendHpaPer3h = null;
    if(parsed){
      const inst = lookupInstability(parsed, dateKey, slotKeyName(slotIdx));
      instabilityScore = computeInstabilityScore({
        cape: inst.cape, li: inst.li, cin: inst.cin, freezingLevelM: inst.freezingLevelM,
      });
      if(includeNowSignals){
        // 気圧トレンドは5区分のslotではなく実際の現在時刻を基準にする
        // （"now"スロットの時だけ意味を持つ補助シグナルのため）。
        pressureTrendHpaPer3h = computePressureTrend(parsed, dateKey, currentHour);
      }
    }
    // 高解像度降水ナウキャストは実況シグナルなので"now"スロット以外では使わない
    // （lightningLevel・警報注意報と同じ扱い）。
    const precipNowcastLevel = includeNowSignals ? (precipNowcastByPref[prefName]?.level ?? 0) : null;
    return { instabilityScore, precipNowcastLevel, pressureTrendHpaPer3h };
  }

  // class10コード -> その配下にあるclass20コード一覧（都道府県代表スコアの警報を、
  // 降水確率と同じ「代表class10」の範囲だけに絞り込むために使用する。これをしないと、
  // 例えば東京都のような離島を含む広い予報区で、本土から遠く離れた離島だけに出ている
  // 注意報が都道府県タイル全体のスコアを引き上げてしまう）。
  const class20CodesByClass10 = {};
  for(const [code, info] of Object.entries(class20Info)){
    if(!info.class10Code) continue;
    if(!class20CodesByClass10[info.class10Code]) class20CodesByClass10[info.class10Code] = [];
    class20CodesByClass10[info.class10Code].push(code);
  }

  // --- 5. 都道府県レベルのスコア算出（市区町村がマッチしなかった場合の
  //        フォールバック、および都道府県タイル表示に使用） -----------------
  const prefScores = {}; // prefName -> dayIdx -> slotIdx -> {score, dataAvailable}
  for(const prefName of prefNames){
    prefScores[prefName] = {};
    const officeCode = officesByPref[prefName]?.[0]; // 代表として先頭の気象台を使用
    const officeData = officeCode ? officeDataByCode[officeCode] : null;
    const lightning = lightningByPref[prefName];

    // 都道府県代表として使うclass10コード（降水確率・天気文・警報のすべてで
    // 同じ代表地域を参照することで、広域予報区内での地域スコープのずれを防ぐ）
    const repClass10 = officeData?.forecast
      ? (Object.keys(officeData.forecast.short)[0] || Object.keys(officeData.forecast.weekly)[0])
      : null;

    for(let dayIdx = 0; dayIdx < DAY_COUNT; dayIdx++){
      prefScores[prefName][dayIdx] = {};
      for(let slotIdx = 0; slotIdx < SLOTS.length; slotIdx++){
        const includeNowSignals = dayIdx === 0 && slotIdx === currentSlotIdx;
        let pop = null, hasThunder = false;
        if(officeData?.forecast && repClass10){
          const r = lookupPopAndThunder(officeData.forecast, repClass10, dateKeys[dayIdx], slotKeyName(slotIdx));
          pop = r.pop; hasThunder = r.hasThunder;
        }
        // 警報も、降水確率と同じ代表class10配下のclass20群だけに限定する
        // （office全体を対象にすると、離島など離れた地域の警報で都道府県全体の
        //   スコアが不当に引き上がってしまうため）。
        const warningCodesAll = new Set();
        if(officeData?.warnings && repClass10){
          const relevantClass20s = class20CodesByClass10[repClass10] || [];
          for(const code of relevantClass20s){
            const set = officeData.warnings.class20Warnings?.[code];
            if(set) for(const c of set) warningCodesAll.add(c);
          }
        }
        const { instabilityScore, precipNowcastLevel, pressureTrendHpaPer3h } =
          computeAuxSignals(prefName, dateKeys[dayIdx], slotIdx, includeNowSignals);
        const { score, dataAvailable: computedDataAvailable, usedNowSignals } = computeAreaScore({
          pop, hasThunder,
          warningCodes: warningCodesAll,
          lightningLevel: lightning?.level ?? 0,
          includeNowSignals,
          prefName,
          slotIdx,
          instabilityScore,
          precipNowcastLevel,
          pressureTrendHpaPer3h,
        });
        // dataAvailableは「降水確率(JMA予報) または CAPE等(Open-Meteo)のどちらかが
        // 取れたか」（computeAreaScore内部の判定、popだけを見ていた旧dataAvailable
        // より広い）。それに加えて警報・雷ナウキャスト・降水ナウキャストという
        // "now"限定の実況シグナルが実際に反映されたかも合わせて見る。
        // どちらも無い（＝中立値の水増しだけ）場合のみ、フロントエンド側で
        // v1フォールバックに切り替えるべきと判断できるようにする。
        const hasRealSignal = computedDataAvailable || usedNowSignals;
        prefScores[prefName][dayIdx][slotIdx] = { score, dataAvailable: computedDataAvailable, hasRealSignal };
      }
    }
  }
  diagnostics.steps.push('pref-scores-done');

  // --- 5.5. 「現在」の詳細情報（表示用）をまとめる ---------------------------
  // メインのゲージには使わず、詳細パネルで「なぜこの指数なのか」の参考情報
  // として見せるための、都道府県代表地点における"now"時点の生データ。
  // CAPE等の数値をそのまま出すと専門的すぎるため、フロントエンド側で
  // 簡単な日本語の説明に変換して表示する想定。
  const nowContextByPref = {};
  for(const prefName of prefNames){
    const parsed = instabilityByPref[prefName];
    const inst = parsed ? lookupInstability(parsed, today, slotKeyName(currentSlotIdx)) : null;
    nowContextByPref[prefName] = {
      cape: inst?.cape ?? null,
      liftedIndex: inst?.li ?? null,
      freezingLevelM: inst?.freezingLevelM ?? null,
      pressureMsl: inst?.pressureMsl ?? null,
      pressureTrendHpaPer3h: parsed ? computePressureTrend(parsed, today, currentHour) : null,
      precipNowcastLevel: precipNowcastByPref[prefName]?.level ?? 0,
      lightningLevel: lightningByPref[prefName]?.level ?? 0,
    };
  }
  diagnostics.steps.push('now-context-done');

  // --- 6. 市区町村レベルのスコア算出（マッチできた場合のみ実データ、
  //        できなければ都道府県スコアを流用） ------------------------------
  const cityScores = {};
  let cityRealCount = 0, cityFallbackCount = 0;

  for(const prefName of prefNames){
    cityScores[prefName] = {};
    const cities = MUNI_LIST[prefName] || [];
    for(const city of cities){
      const class20Code = matched[prefName]?.[city] || null;
      const info = class20Code ? class20Info[class20Code] : null;
      const officeCode = info?.officeCode;
      const officeData = officeCode ? officeDataByCode[officeCode] : null;

      if(!info || !officeData){
        // マッチしなかった/データが無い場合は都道府県スコアをそのまま使う
        cityScores[prefName][city] = { fallback: 'pref', days: prefScores[prefName] };
        cityFallbackCount++;
        continue;
      }

      const lightning = lightningByPref[prefName];
      const warningSetForThisCity = officeData.warnings?.class20Warnings?.[class20Code] || new Set();
      const days = {};
      for(let dayIdx = 0; dayIdx < DAY_COUNT; dayIdx++){
        days[dayIdx] = {};
        for(let slotIdx = 0; slotIdx < SLOTS.length; slotIdx++){
          const includeNowSignals = dayIdx === 0 && slotIdx === currentSlotIdx;
          let pop = null, hasThunder = false;
          if(officeData.forecast && info.class10Code){
            const r = lookupPopAndThunder(officeData.forecast, info.class10Code, dateKeys[dayIdx], slotKeyName(slotIdx));
            pop = r.pop; hasThunder = r.hasThunder;
          }
          const { instabilityScore, precipNowcastLevel, pressureTrendHpaPer3h } =
            computeAuxSignals(prefName, dateKeys[dayIdx], slotIdx, includeNowSignals);
          const { score, dataAvailable: computedDataAvailable, usedNowSignals } = computeAreaScore({
            pop, hasThunder,
            warningCodes: includeNowSignals ? warningSetForThisCity : new Set(),
            lightningLevel: lightning?.level ?? 0,
            includeNowSignals,
            prefName,
            slotIdx,
            instabilityScore,
            precipNowcastLevel,
            pressureTrendHpaPer3h,
          });
          days[dayIdx][slotIdx] = { score, dataAvailable: computedDataAvailable, hasRealSignal: computedDataAvailable || usedNowSignals };
        }
      }
      cityScores[prefName][city] = { fallback: null, days };
      cityRealCount++;
    }
  }
  diagnostics.steps.push('city-scores-done');
  diagnostics.matchStats = matchStats;
  diagnostics.cityRealCount = cityRealCount;
  diagnostics.cityFallbackCount = cityFallbackCount;
  diagnostics.durationMs = Date.now() - startedAt;

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    currentSlotIdx,
    dateKeys,
    prefScores,
    cityScores,
    lightningByPref,
    precipNowcastByPref,
    nowContextByPref,
    diagnostics,
  };
}

// 実行に時間がかかった回（外部APIの遅延等）と、その後にスケジュール起動された
// 次の回が重なって同時に走った場合、後から完了した方が「古い」結果で上書きして
// しまう可能性がある（Background Functionは最大15分、トリガーは15分間隔のため、
// 理論上は重なりうる）。この判定ロジックだけを純粋関数として切り出し、
// Netlify Blobsを実際に使わなくても単体テストできるようにしている。
// 「既存データの方が新しい（＝自分より後に開始した別の実行が先に書き込み済み）」
// と確実に判定できた場合だけtrueを返す。日時が不正/欠損している等、判定できない
// 場合は false（＝安全側に倒して書き込みを許可する）にする。
export function isExistingNewer(existing, result){
  if(!existing?.ok) return false;
  const existingMs = Date.parse(existing?.generatedAt || '');
  const newMs = Date.parse(result?.generatedAt || '');
  if(!Number.isFinite(existingMs) || !Number.isFinite(newMs)) return false;
  return existingMs > newMs;
}

async function saveResult(result){
  try{
    const store = getStore(RISK_STORE);
    if(result.ok){
      const existing = await store.get(RISK_KEY, { type: 'json' }).catch(() => null);
      if(isExistingNewer(existing, result)){
        // 既存の保存データの方が新しい＝自分より後に開始した別の実行が先に書き込み済み。
        // 古いデータで上書きしないようスキップする
        // （＝常に「最後に完了した回」ではなく「最も新しく生成された回」が残るようにする）。
        return { saved: false, skippedAsStale: true };
      }
    }
    await store.setJSON(RISK_KEY, result);
    return { saved: true };
  }catch(e){
    // Blobsへの保存自体が失敗した場合はログに残す術がないため、
    // 少なくとも例外で落ちないようにだけしておく（次回実行に賭ける）。
    return { saved: false, error: String(e) };
  }
}

// Netlify Background Function のエントリポイント。
// 実処理は computeRiskData() に委譲し、ここでは保存とレスポンス整形のみ行う。
export default async () => {
  const result = await computeRiskData();
  const saveOutcome = await saveResult(result);

  if(!result.ok){
    return new Response(JSON.stringify({ ok: false, error: 'area-master-failed', detail: result.diagnostics?.fatalError }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    ok: true,
    saved: saveOutcome.saved,
    skippedAsStale: saveOutcome.skippedAsStale ?? false,
    durationMs: result.diagnostics?.durationMs,
    matchStats: result.diagnostics?.matchStats,
    officeErrorCount: result.diagnostics?.officeErrors?.length ?? 0,
    lightningErrorCount: result.diagnostics?.lightningErrors?.length ?? 0,
    precipNowcastErrorCount: result.diagnostics?.precipNowcastErrors?.length ?? 0,
    instabilityErrorCount: result.diagnostics?.instabilityErrors?.length ?? 0,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
