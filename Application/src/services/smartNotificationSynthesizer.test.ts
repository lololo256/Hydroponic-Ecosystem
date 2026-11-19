import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isQuietHour,
  shouldSuppressNotification,
  calculateProgressiveBackoff,
  shouldThrottleIssue,
  synthesizeAlertBatch,
  setupNativeNotificationChannels,
  NOTIFICATION_CHANNELS,
  type RawAlertEvent,
} from './smartNotificationSynthesizer.ts';

describe('Smart Notification Synthesizer & Bundler Tests', () => {
  // ── 1. Quiet Hours Detection ──
  it('1. isQuietHour correctly identifies 22:00 - 05:59 as quiet hours and 06:00 - 21:59 as active hours', () => {
    const night2AM = new Date('2026-11-15T02:00:00');
    assert.strictEqual(isQuietHour(night2AM), true, '2:00 AM must be quiet hour');

    const night11PM = new Date('2026-11-15T23:30:00');
    assert.strictEqual(isQuietHour(night11PM), true, '23:30 PM must be quiet hour');

    const morning7AM = new Date('2026-11-15T07:00:00');
    assert.strictEqual(isQuietHour(morning7AM), false, '07:00 AM must not be quiet hour');

    const noon12PM = new Date('2026-11-15T12:00:00');
    assert.strictEqual(isQuietHour(noon12PM), false, '12:00 PM must not be quiet hour');
  });

  // ── 2. Smart Notification Suppression ──
  it('2. shouldSuppressNotification silences normal warning at 2:00 AM', () => {
    const night2AM = new Date('2026-11-15T02:00:00');
    const isSuppressed = shouldSuppressNotification({
      level: 'warning',
      category: 'ec',
      date: night2AM,
    });
    assert.strictEqual(isSuppressed, true, 'EC warning at 2 AM must be suppressed');
  });

  it('3. shouldSuppressNotification allows critical leak or offline alert at 2:00 AM (P0 Safety)', () => {
    const night2AM = new Date('2026-11-15T02:00:00');
    const leakSuppressed = shouldSuppressNotification({
      level: 'critical',
      category: 'leak',
      date: night2AM,
    });
    assert.strictEqual(leakSuppressed, false, 'Critical water leak at 2 AM must NOT be suppressed');

    const offlineSuppressed = shouldSuppressNotification({
      level: 'critical',
      category: 'connectivity_offline',
      date: night2AM,
    });
    assert.strictEqual(offlineSuppressed, false, 'Critical offline alert at 2 AM must NOT be suppressed');
  });

  // ── 3. Notification Bundler & Batching ──
  it('4. synthesizeAlertBatch combines bouncing offline + online in same window into stable connection alert', () => {
    const events: RawAlertEvent[] = [
      {
        level: 'critical',
        category: 'connectivity_offline',
        title: 'อุปกรณ์ออฟไลน์',
        message: 'อุปกรณ์ FARM-DEMO-01 ขาดการเชื่อมต่อ',
        farmName: 'FARM-DEMO-01',
        timestamp: Date.now() - 5000,
        debounceKey: 'offline',
      },
      {
        level: 'info',
        category: 'connectivity_online',
        title: 'อุปกรณ์ออนไลน์แล้ว',
        message: 'อุปกรณ์ FARM-DEMO-01 เชื่อมต่อกลับเข้าระบบเรียบร้อย',
        farmName: 'FARM-DEMO-01',
        timestamp: Date.now(),
        debounceKey: 'online',
      },
    ];

    const result = synthesizeAlertBatch(events);
    assert.ok(result);
    assert.strictEqual(result.level, 'info');
    assert.ok(result.title.includes('สัญญาณเชื่อมต่อเสถียรแล้ว'));
    assert.strictEqual(result.channelId, 'smartfarm_general');
  });

  it('5. synthesizeAlertBatch bundles online restored + EC low into a single concise notification (matches user screenshot scenario)', () => {
    const events: RawAlertEvent[] = [
      {
        level: 'critical',
        category: 'connectivity_offline',
        title: 'อุปกรณ์ออฟไลน์',
        message: 'อุปกรณ์ FARM-DEMO-01 ขาดการเชื่อมต่อ',
        farmName: 'FARM-DEMO-01',
        timestamp: Date.now() - 4000,
        debounceKey: 'offline',
      },
      {
        level: 'info',
        category: 'connectivity_online',
        title: 'อุปกรณ์ออนไลน์แล้ว',
        message: 'อุปกรณ์ FARM-DEMO-01 เชื่อมต่อกลับเข้าระบบเรียบร้อย',
        farmName: 'FARM-DEMO-01',
        timestamp: Date.now() - 2000,
        debounceKey: 'online',
      },
      {
        level: 'warning',
        category: 'ec',
        title: 'แจ้งเตือนค่า EC สารอาหาร',
        message: 'ค่า EC ของ FARM-DEMO-01 อยู่ที่ 1.18 mS/cm',
        farmName: 'FARM-DEMO-01',
        metric: 'ec',
        value: 1.18,
        timestamp: Date.now(),
        debounceKey: 'ec_warn',
      },
    ];

    const result = synthesizeAlertBatch(events);
    assert.ok(result);
    // ต้องรวมเป็นก้อนเดียว ไม่แยกส่ง 3 อัน
    assert.ok(result.title.includes('ออนไลน์แล้ว & สารละลายเบี่ยงเบน'));
    assert.ok(result.body.includes('1.18 mS/cm'));
    assert.strictEqual(result.sound, undefined);
  });

  it('6. synthesizeAlertBatch combines multiple nutrient deviations (EC + pH) into one unified alert', () => {
    const events: RawAlertEvent[] = [
      {
        level: 'warning',
        category: 'ec',
        title: 'ค่า EC เบี่ยงเบน',
        message: 'ค่า EC ต่ำ',
        farmName: 'FARM-DEMO-01',
        metric: 'ec',
        value: 1.15,
        timestamp: Date.now(),
        debounceKey: 'ec_warn',
      },
      {
        level: 'warning',
        category: 'ph',
        title: 'ค่า pH เบี่ยงเบน',
        message: 'ค่า pH สูง',
        farmName: 'FARM-DEMO-01',
        metric: 'ph',
        value: 7.2,
        timestamp: Date.now(),
        debounceKey: 'ph_warn',
      },
    ];

    const result = synthesizeAlertBatch(events);
    assert.ok(result);
    assert.ok(result.title.includes('ค่าน้ำเบี่ยงเบนหลายตัว'));
    assert.ok(result.body.includes('EC=1.15'));
    assert.ok(result.body.includes('pH=7.20'));
  });

  // ── 4. Progressive Backoff & Throttling ──
  it('7. calculateProgressiveBackoff returns 0 for 1st, 2 hours for 2nd, and 6 hours for 3rd alert', () => {
    assert.strictEqual(calculateProgressiveBackoff(1), 0);
    assert.strictEqual(calculateProgressiveBackoff(2), 2 * 60 * 60 * 1000);
    assert.strictEqual(calculateProgressiveBackoff(3), 6 * 60 * 60 * 1000);
  });

  it('8. shouldThrottleIssue prevents repetitive alert within 2-hour backoff window and allows after 2 hours', () => {
    const now = Date.now();
    const record = {
      count: 1, // เคยเตือนไปแล้ว 1 ครั้ง
      lastAlertTs: now - 30 * 60 * 1000, // ผ่านไป 30 นาที (ยังไม่ถึง 2 ชม.)
    };

    assert.strictEqual(
      shouldThrottleIssue(record, now),
      true,
      'Should throttle repetitive alert at 30 minutes'
    );

    const recordExpired = {
      count: 1,
      lastAlertTs: now - 125 * 60 * 1000, // ผ่านไป 125 นาที (> 2 ชม.)
    };
    assert.strictEqual(
      shouldThrottleIssue(recordExpired, now),
      false,
      'Should allow alert after 2 hours'
    );
  });

  // ── 5. Notification Channel & Native Sound Setup ──
  it('9. setupNativeNotificationChannels calls createChannel with default system sound', async () => {
    const createdChannels: any[] = [];
    const mockLocalPlugin = {
      createChannel: async (ch: any) => {
        createdChannels.push(ch);
      },
    };

    await setupNativeNotificationChannels(mockLocalPlugin);
    assert.strictEqual(createdChannels.length, 2);
    assert.strictEqual(createdChannels[0].id, NOTIFICATION_CHANNELS.CRITICAL.id);
    assert.strictEqual(createdChannels[0].sound, undefined);
    assert.strictEqual(createdChannels[1].id, NOTIFICATION_CHANNELS.GENERAL.id);
    assert.strictEqual(createdChannels[1].sound, undefined);
  });
});
