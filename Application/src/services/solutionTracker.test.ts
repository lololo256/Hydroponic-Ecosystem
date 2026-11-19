import { test } from 'node:test';
import assert from 'node:assert';
import {
  applyFlowCalibration,
  applyRefill,
  computeTankLevel,
  parseSolutionTanks,
  type TankRecord,
} from './solutionTracker.ts';

const rec = (over: Partial<TankRecord> = {}): TankRecord => ({
  capacityMl: 1000,
  volumeMl: 800,
  runAtRefillS: 100,
  refilledAt: 1_700_000_000_000,
  flowMlPerS: 1.5,
  flowMeasuredAt: 1_700_000_000_000,
  ...over,
});

test('remaining = refill volume - run-time since refill x measured flow (manual + AUTO runs counted by the board)', () => {
  // 100 s at refill, board now reports 140 s -> 40 s of pumping x 1.5 ml/s = 60 ml used
  const lvl = computeTankLevel(rec(), 140);
  assert.strictEqual(lvl.status, 'ok');
  assert.strictEqual(lvl.usedMl, 60);
  assert.strictEqual(lvl.remainingMl, 740);
  assert.strictEqual(lvl.pct, 74);
  assert.strictEqual(lvl.isLow, false);
});

test('never below zero; low warning at <=20% or <=100 ml', () => {
  assert.strictEqual(computeTankLevel(rec(), 100 + 1000).remainingMl, 0);
  assert.strictEqual(computeTankLevel(rec(), 100 + 400).isLow, true); // 800-600 = 200 ml = 20%
  assert.strictEqual(computeTankLevel(rec({ capacityMl: 5000, volumeMl: 150 }), 100 + 40).isLow, true); // 90 ml
});

test('no fake numbers: unknown inputs give unknown output', () => {
  assert.strictEqual(computeTankLevel(undefined, 50).status, 'not_set');
  assert.strictEqual(computeTankLevel(undefined, 50).remainingMl, null);
  const noFlow = computeTankLevel(rec({ flowMlPerS: null }), 140);
  assert.deepStrictEqual([noFlow.status, noFlow.remainingMl, noFlow.pct], ['needs_flow', null, null]);
  const noRuntime = computeTankLevel(rec(), null);
  assert.deepStrictEqual([noRuntime.status, noRuntime.remainingMl], ['waiting_runtime', null]);
  const noBaseline = computeTankLevel(rec({ runAtRefillS: null }), 140);
  assert.strictEqual(noBaseline.status, 'waiting_runtime');
});

test('board counter reset (factory reset) is detected instead of producing a wrong level', () => {
  assert.strictEqual(computeTankLevel(rec(), 5).status, 'counter_reset');
});

test('refill adds to the calculated remaining volume, capped at capacity, and re-bases the counter', () => {
  const r = rec();
  const lvl = computeTankLevel(r, 140); // 740 ml left
  const next = applyRefill(r, lvl, 200, 1000, 140, 42);
  assert.deepStrictEqual(next, { ...r, volumeMl: 940, runAtRefillS: 140, refilledAt: 42 });
  assert.strictEqual(applyRefill(r, lvl, 5000, 1000, 140, 42).volumeMl, 1000);
  // unknown current level (no flow yet) counts as empty, keeps no invented volume
  const unknown = computeTankLevel(rec({ flowMlPerS: null }), 140);
  assert.strictEqual(applyRefill(rec({ flowMlPerS: null }), unknown, 300, 1000, 140, 42).volumeMl, 300);
});

test('flow calibration: rate = measured ml / seconds, keeps the volume already used', () => {
  const r = rec({ flowMlPerS: null });
  const lvl = computeTankLevel(r, 140); // needs_flow
  // refilled at counter 100, calibration run brought it to 150: those 50 s are charged at the new rate
  const cal = applyFlowCalibration(r, lvl, 16, 10, 150, 99)!;
  assert.strictEqual(cal.flowMlPerS, 1.6);
  assert.strictEqual(cal.runAtRefillS, 150);
  assert.strictEqual(cal.volumeMl, 800 - 80);
  assert.strictEqual(computeTankLevel(cal, 160).remainingMl, 800 - 80 - 16);
  // re-calibrating keeps what was already calculated with the old rate
  const ok = rec();
  const before = computeTankLevel(ok, 140); // 740 left
  const recal = applyFlowCalibration(ok, before, 20, 10, 140, 99)!;
  assert.strictEqual(computeTankLevel(recal, 140).remainingMl, 740);
  assert.strictEqual(applyFlowCalibration(ok, before, 0, 10, 140), null);
  assert.strictEqual(applyFlowCalibration(ok, before, 999, 10, 140), null);
});

test('flow measured before the first refill is kept but shows no level', () => {
  const cal = applyFlowCalibration(undefined, computeTankLevel(undefined, 10), 15, 10, 10, 5)!;
  const lvl = computeTankLevel(cal, 20);
  assert.deepStrictEqual([lvl.status, lvl.remainingMl, lvl.flowMlPerS], ['not_set', null, 1.5]);
  const after = applyRefill(cal, lvl, 500, 1000, 20, 6);
  assert.strictEqual(after.flowMlPerS, 1.5);
  assert.strictEqual(computeTankLevel(after, 30).remainingMl, 485);
});

test('parseSolutionTanks accepts object or JSON string and drops malformed records', () => {
  const good = { fertA: rec(), phUp: { capacityMl: -1, volumeMl: 1, refilledAt: 1 } };
  assert.deepStrictEqual(Object.keys(parseSolutionTanks(good)), ['fertA']);
  assert.deepStrictEqual(Object.keys(parseSolutionTanks(JSON.stringify(good))), ['fertA']);
  assert.deepStrictEqual(parseSolutionTanks('not json'), {});
  assert.strictEqual(parseSolutionTanks({ fertB: { ...rec(), flowMlPerS: 9999 } }).fertB!.flowMlPerS, null);
});
