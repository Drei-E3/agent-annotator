/**
 * @fileoverview 20-Case UI Bug Benchmark Gate Evaluator (`annotator benchmark`).
 *
 * Evaluates:
 *  - Zero-shot pass rate (`zero_shot`: fixed on first attempt)
 *  - 1-turn fix rate (`one_turn`: needed 1 follow-up clarification)
 *  - 2+ turn rate (`two_plus_turns`: needed 2 or more follow-ups)
 *  - Breakdown by component source presence (`hasComponentSource`) and annotation kind (`element` vs `region`).
 */

import fs from 'node:fs';

/**
 * @param {string} filePath
 */
export function evaluateBenchmark(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const cases = raw.cases || [];
  const thresholds = raw.gateThresholds || {
    minZeroShotPassRate: 0.65,
    maxTwoPlusTurnRate: 0.15,
  };

  const completed = cases.filter((c) =>
    ['zero_shot', 'one_turn', 'two_plus_turns'].includes(c.outcome)
  );
  const total = completed.length;

  if (total === 0) {
    console.log('No completed benchmark cases found.');
    return { passedGate: false, total: 0 };
  }

  const zeroShot = completed.filter((c) => c.outcome === 'zero_shot').length;
  const oneTurn = completed.filter((c) => c.outcome === 'one_turn').length;
  const twoPlus = completed.filter((c) => c.outcome === 'two_plus_turns').length;

  const zeroShotRate = zeroShot / total;
  const oneTurnRate = oneTurn / total;
  const twoPlusRate = twoPlus / total;

  const withSource = completed.filter((c) => c.hasComponentSource);
  const withoutSource = completed.filter((c) => !c.hasComponentSource);

  const withSourceZeroShotRate =
    withSource.length > 0
      ? withSource.filter((c) => c.outcome === 'zero_shot').length / withSource.length
      : 0;
  const withoutSourceZeroShotRate =
    withoutSource.length > 0
      ? withoutSource.filter((c) => c.outcome === 'zero_shot').length / withoutSource.length
      : 0;

  const passedGate =
    total >= 20 &&
    zeroShotRate >= thresholds.minZeroShotPassRate &&
    twoPlusRate <= thresholds.maxTwoPlusTurnRate;

  console.log('🎯 Agent Annotator — 20-Case UI Bug Benchmark Gate\n');
  console.log(`Total Evaluated Cases     : ${total} / ${cases.length}`);
  console.log(
    `1️⃣  Zero-Shot Fix Rate    : ${(zeroShotRate * 100).toFixed(1)}% (${zeroShot}/${total})  [Gate >= ${(
      thresholds.minZeroShotPassRate * 100
    ).toFixed(0)}%]`
  );
  console.log(
    `2️⃣  1-Turn Correction     : ${(oneTurnRate * 100).toFixed(1)}% (${oneTurn}/${total})`
  );
  console.log(
    `3️⃣  2+ Turns Required     : ${(twoPlusRate * 100).toFixed(1)}% (${twoPlus}/${total})  [Gate <= ${(
      thresholds.maxTwoPlusTurnRate * 100
    ).toFixed(0)}%]\n`
  );
  console.log('Breakdown by Component Source Location (React/Vue/Svelte fiber probe):');
  console.log(
    `  • With Source Location  : ${(withSourceZeroShotRate * 100).toFixed(1)}% zero-shot (${withSource.length} cases)`
  );
  console.log(
    `  • Selector Only         : ${(withoutSourceZeroShotRate * 100).toFixed(1)}% zero-shot (${withoutSource.length} cases)\n`
  );
  console.log(
    `Gate Status               : ${
      passedGate ? '✅ PASSED (Canonical formatter validated)' : '❌ FAILED (Tune formatter ordering/fields)'
    }`
  );

  return {
    passedGate,
    total,
    zeroShotRate,
    oneTurnRate,
    twoPlusRate,
    withSourceZeroShotRate,
    withoutSourceZeroShotRate,
  };
}
