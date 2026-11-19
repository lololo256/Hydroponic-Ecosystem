import { test } from 'node:test';
import assert from 'node:assert';
import { evaluateAlertConditions, trackAlerts, type AlertRuleInput } from './alertRules.ts';

const T = { phMin: 5.8, phMax: 6.5, ecMin: 1.2, ecMax: 2.0, tempMin: 22, tempMax: 28 };
const input = (over: Partial<AlertRuleInput> = {}): AlertRuleInput => ({
  freshness: 'live',
  current: { pH: 6.1, ec: 1.5, tempC: 25 },
  targets: T,
  mainTankOk: true,
  ...over,
});
const keys = (i: AlertRuleInput) => evaluateAlertConditions(i).map((c) => c.key);

test('all in range -> nothing to alert', () => {
  assert.deepStrictEqual(keys(input()), []);
});

test('out-of-range readings alert with severity by distance', () => {
  const c = evaluateAlertConditions(input({ current: { pH: 6.7, ec: 0.6, tempC: 31.5 } }));
  const by = Object.fromEntries(c.map((x) => [x.key, x.level]));
  assert.deepStrictEqual(by, { 'ph-range': 'warning', 'ec-range': 'critical', 'temp-range': 'critical' });
  assert.match(c[0].message, /6\.70 \(เป้าหมาย 5\.80-6\.50\)/);
});

test('missing values and stale data never raise range alerts (no guessing)', () => {
  assert.deepStrictEqual(keys(input({ current: { pH: null, ec: null, tempC: null } })), []);
  assert.deepStrictEqual(keys(input({ freshness: 'stale', current: { pH: 9, ec: 9, tempC: 40 } })), []);
});

test('offline, main tank low, solution low and sensor faults', () => {
  assert.deepStrictEqual(keys(input({ freshness: 'offline' })), ['device-offline']);
  assert.ok(keys(input({ mainTankOk: false })).includes('main-tank-low'));
  const low = { status: 'ok', isLow: true, remainingMl: 80, pct: 8 } as any;
  const unknown = { status: 'needs_flow', isLow: false, remainingMl: null, pct: null } as any;
  assert.deepStrictEqual(keys(input({ solutionLevels: { phDown: low, fertA: unknown } })), ['solution-low-phDown']);
  const chk = [
    { id: 'ph-flat', sensor: 'ph', level: 'warning', title: 'x', detail: 'd', advice: 'a' },
    { id: 'sys-sim', sensor: 'system', level: 'info', title: 's', detail: 'd' },
    { id: 'ec-ok', sensor: 'ec', level: 'ok', title: 'ok', detail: 'd' },
  ] as any;
  assert.deepStrictEqual(keys(input({ sensorChecks: chk })), ['sensor-ph-flat']);
});

test('smart policy: 5 min confirm, one reminder at 30 min, then quiet, then resolved', () => {
  const cond = evaluateAlertConditions(input({ current: { pH: 6.8, ec: 1.5, tempC: 25 } }));
  const MIN = 60_000;
  let r = trackAlerts({}, cond, 0, 'ฟาร์ม');
  assert.strictEqual(r.notify.length, 0, 'not on first sighting');
  r = trackAlerts(r.state, cond, 4 * MIN, 'ฟาร์ม');
  assert.strictEqual(r.notify.length, 0, 'not before 5 min');
  r = trackAlerts(r.state, cond, 5 * MIN, 'ฟาร์ม');
  assert.strictEqual(r.notify.length, 1);
  assert.strictEqual(r.notify[0].debounceKey, 'ph-range');
  r = trackAlerts(r.state, cond, 20 * MIN, 'ฟาร์ม');
  assert.strictEqual(r.notify.length, 0, 'no repeat');
  r = trackAlerts(r.state, cond, 30 * MIN, 'ฟาร์ม');
  assert.strictEqual(r.notify.length, 1, 'one reminder at 30 min');
  assert.ok(r.notify[0].message.startsWith('ยังไม่หาย 30 นาที'));
  r = trackAlerts(r.state, cond, 3 * 60 * MIN, 'ฟาร์ม');
  assert.strictEqual(r.notify.length, 0, 'quiet after the reminder');
  r = trackAlerts(r.state, [], 3 * 60 * MIN + 30_000, 'ฟาร์ม');
  assert.deepStrictEqual(r.resolved, ['ph-range']);
});

test('AUTO mode waits 15 min for pH (it doses itself); a fixed value never notifies', () => {
  const cond = evaluateAlertConditions(input({ current: { pH: 6.8, ec: 1.5, tempC: 25 } }));
  const MIN = 60_000;
  let r = trackAlerts({}, cond, 0, 'ฟาร์ม', { autoMode: true });
  r = trackAlerts(r.state, cond, 10 * MIN, 'ฟาร์ม', { autoMode: true });
  assert.strictEqual(r.notify.length, 0);
  r = trackAlerts(r.state, [], 12 * MIN, 'ฟาร์ม', { autoMode: true });
  assert.deepStrictEqual(r.resolved, [], 'never notified -> no resolved message');
  r = trackAlerts({}, cond, 0, 'ฟาร์ม', { autoMode: true });
  r = trackAlerts(r.state, cond, 15 * MIN, 'ฟาร์ม', { autoMode: true });
  assert.strictEqual(r.notify.length, 1);
});

test('a signal hiccup does not report a still-wrong value as resolved', () => {
  const cond = evaluateAlertConditions(input({ current: { pH: 6.8, ec: 1.5, tempC: 25 } }));
  const MIN = 60_000;
  let r = trackAlerts({}, cond, 0, 'ฟาร์ม');
  r = trackAlerts(r.state, cond, 5 * MIN, 'ฟาร์ม');
  assert.strictEqual(r.notify.length, 1);
  r = trackAlerts(r.state, [], 6 * MIN, 'ฟาร์ม', { holdMissing: true });
  assert.deepStrictEqual(r.resolved, []);
  assert.ok(r.state['ph-range'], 'kept while data is stale');
  r = trackAlerts(r.state, cond, 7 * MIN, 'ฟาร์ม');
  assert.strictEqual(r.notify.length, 0, 'same episode continues, no second first-alert');
});

test('main tank low notifies at once', () => {
  const r = trackAlerts({}, evaluateAlertConditions(input({ mainTankOk: false })), 5, 'ฟาร์ม');
  assert.deepStrictEqual(r.notify.map((n) => n.debounceKey), ['main-tank-low']);
});

test('offline notifies immediately (already confirmed by the 150 s threshold)', () => {
  const r = trackAlerts({}, evaluateAlertConditions(input({ freshness: 'offline' })), 5, 'ฟาร์ม');
  assert.strictEqual(r.notify.length, 1);
});
