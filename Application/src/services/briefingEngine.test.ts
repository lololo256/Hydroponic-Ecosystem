import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  evaluateFarm,
  buildBriefingPrompt,
  validateBriefing,
  generateFallbackBriefing,
  buildUserContext,
  computeFactsHash,
  decideBriefingMode,
  trackAppOpen,
  generateBriefing,
  recordFarmAction,
  resolvePendingActions,
  getRelevantMemory,
  setBriefingStorage,
  getCachedBriefing,
  clearBriefingCache,
  calculatePlantDays,
  type UserSession,
  type BriefingStorage,
} from './briefingEngine.ts';
import { analyzeDiurnalPattern } from './diurnalPredictor.ts';

describe('AI Briefing Engine & Smart Greeting Unit Tests', () => {
  // ── Part 1: Smart Evaluation & Guardrails ──
  it('1. evaluateFarm() accurately flags EC=1.16 and TDS=580 as low without hallucination', () => {
    const facts = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current: {
        pH: 6.0,
        ec: 1.16,
        tds: 580,
        tempC: 25.0,
      },
      targets: {
        phMin: 5.8,
        phMax: 6.5,
        ecMin: 1.4,
        ecMax: 1.8,
        tempMin: 22.0,
        tempMax: 28.0,
      },
      isOnline: true,
    });

    assert.strictEqual(facts.sensors.ec.status, 'low', 'EC 1.16 should be evaluated as low');
    assert.strictEqual(facts.overallStatus, 'warning', 'Overall status should be warning');
    assert.ok(facts.criticalIssues.length > 0, 'Should have critical issues');
    assert.ok(
      facts.criticalIssues.some((issue) => issue.includes('EC=1.16')),
      'Should mention EC=1.16 in critical issues'
    );
  });

  it('2. validateBriefing() rejects hallucinated "สภาพน้ำสมบูรณ์" when EC is low and returns fallback mentioning EC', () => {
    const facts = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current: {
        pH: 6.0,
        ec: 1.16,
        tds: 580,
        tempC: 25.0,
      },
      targets: {
        phMin: 5.8,
        phMax: 6.5,
        ecMin: 1.4,
        ecMax: 1.8,
      },
      isOnline: true,
    });

    const faultyAiOutput =
      'สวัสดีตอนบ่ายครับหัวหน้า! แดดเริ่มร่มลงแล้ว แปลง กรีนโอ๊ค กำลังดูดซึมธาตุอาหารไปสะสมในลำต้น สภาพน้ำสมบูรณ์พร้อมเข้าสู่รอบค่ำครับ';

    const result = validateBriefing(faultyAiOutput, facts);

    assert.strictEqual(result.isValid, false, 'Validator must reject positive text when EC is low');
    assert.strictEqual(result.fallbackUsed, true, 'Validator must trigger fallback template');
    assert.ok(!result.text.includes('สมบูรณ์'), 'Resulting text MUST NOT contain word "สมบูรณ์"');
    assert.ok(result.text.includes('EC'), 'Resulting text MUST mention "EC"');
    assert.ok(result.text.includes('1.16'), 'Resulting text MUST state actual value 1.16');
  });

  // ── Part 2: Smart Greeting (buildUserContext) ──
  it('3. buildUserContext() covers morning, late night, recent return (<1h), and away long (>=24h)', () => {
    // 3.1 เช้า (07:30)
    const morningDate = new Date('2026-11-15T07:30:00');
    const ctxMorning = buildUserContext({ now: morningDate });
    assert.strictEqual(ctxMorning.timeOfDay, 'morning');
    assert.strictEqual(ctxMorning.timeOfDayGreeting, 'สวัสดีตอนเช้าครับ');

    // 3.2 ดึก (23:45)
    const lateNightDate = new Date('2026-11-15T23:45:00');
    const ctxLateNight = buildUserContext({ now: lateNightDate });
    assert.strictEqual(ctxLateNight.timeOfDay, 'late_night');
    assert.strictEqual(ctxLateNight.timeOfDayGreeting, 'สวัสดีรอบดึกครับ');

    // 3.3 เปิดซ้ำใน 1 ชม. (เช่น 15 นาทีที่แล้ว)
    const nowMs = Date.now();
    const ctxRecent = buildUserContext({
      now: new Date(nowMs),
      lastOpenAt: nowMs - 15 * 60 * 1000,
    });
    assert.strictEqual(ctxRecent.isRecentReturn, true, 'isRecentReturn should be true for 15 mins');
    assert.strictEqual(ctxRecent.isAwayLong, false);

    // 3.4 หายไปหลายวัน (เช่น 48 ชม.)
    const ctxAwayLong = buildUserContext({
      now: new Date(nowMs),
      lastOpenAt: nowMs - 48 * 60 * 60 * 1000,
    });
    assert.strictEqual(ctxAwayLong.isAwayLong, true, 'isAwayLong should be true for 48 hours');
    assert.strictEqual(ctxAwayLong.isRecentReturn, false);
  });

  // ── Part 3: Facts Hashing without Jitter ──
  it('4. computeFactsHash() produces identical hash when sensor numbers vary slightly within optimal range', () => {
    const factsA = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current: { pH: 6.0, ec: 1.50, tds: 750, tempC: 25.0 },
      targets: { phMin: 5.8, phMax: 6.5, ecMin: 1.4, ecMax: 1.8 },
      isOnline: true,
    });

    const factsB = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current: { pH: 6.05, ec: 1.53, tds: 765, tempC: 25.2 }, // Minor jitter, still optimal
      targets: { phMin: 5.8, phMax: 6.5, ecMin: 1.4, ecMax: 1.8 },
      isOnline: true,
    });

    const hashA = computeFactsHash(factsA);
    const hashB = computeFactsHash(factsB);

    assert.strictEqual(hashA, hashB, 'Hash must be identical when statuses remain optimal despite small jitter');
  });

  it('5. computeFactsHash() changes when a sensor status shifts from optimal to low/high', () => {
    const factsOptimal = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current: { pH: 6.0, ec: 1.50, tds: 750, tempC: 25.0 },
      targets: { phMin: 5.8, phMax: 6.5, ecMin: 1.4, ecMax: 1.8 },
      isOnline: true,
    });

    const factsLow = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current: { pH: 6.0, ec: 1.16, tds: 580, tempC: 25.0 }, // Dropped to low
      targets: { phMin: 5.8, phMax: 6.5, ecMin: 1.4, ecMax: 1.8 },
      isOnline: true,
    });

    const hashOptimal = computeFactsHash(factsOptimal);
    const hashLow = computeFactsHash(factsLow);

    assert.notStrictEqual(hashOptimal, hashLow, 'Hash must change when status shifts to low');
  });

  // ── Part 4: decideBriefingMode() Decision Logic ──
  it('6. decideBriefingMode() correctly returns "reuse", "delta", and "full"', () => {
    const now = Date.now();
    const currentHash = 'กรีนโอ๊ค|vegetative|online|optimal|ph:optimal|ec:optimal|tds:optimal|temp:optimal';

    // 6.1 reuse: เปิดซ้ำใน 15 นาที และ hash เท่าเดิม
    const sessionReuse: UserSession = {
      lastOpenAt: now - 5 * 60 * 1000, // 5 mins ago
      lastBriefingAt: now - 5 * 60 * 1000,
      lastFactsHash: currentHash,
    };
    assert.strictEqual(
      decideBriefingMode(sessionReuse, currentHash, now),
      'reuse',
      'Should reuse when within 15 mins and hash unchanged'
    );

    // 6.2 delta: hash เปลี่ยน แม้เปิดซ้ำใน 5 นาที
    const sessionHashChanged: UserSession = {
      lastOpenAt: now - 5 * 60 * 1000,
      lastBriefingAt: now - 5 * 60 * 1000,
      lastFactsHash: 'different_hash_ec_low',
    };
    assert.strictEqual(
      decideBriefingMode(sessionHashChanged, currentHash, now),
      'delta',
      'Should use delta mode when hash changed'
    );

    // 6.3 delta: hash เท่าเดิม แต่เวลาผ่านไปเกิน 15 นาที (เช่น 30 นาที)
    const sessionTimeExceeded: UserSession = {
      lastOpenAt: now - 30 * 60 * 1000,
      lastBriefingAt: now - 30 * 60 * 1000,
      lastFactsHash: currentHash,
    };
    assert.strictEqual(
      decideBriefingMode(sessionTimeExceeded, currentHash, now),
      'delta',
      'Should use delta mode when between 15 mins and 6 hours'
    );

    // 6.4 full: หายไปเกิน 6 ชม. (เช่น 7 ชม.)
    const sessionAwayLong: UserSession = {
      lastOpenAt: now - 7 * 60 * 60 * 1000,
      lastBriefingAt: now - 7 * 60 * 60 * 1000,
      lastFactsHash: currentHash,
    };
    assert.strictEqual(
      decideBriefingMode(sessionAwayLong, currentHash, now),
      'full',
      'Should use full mode when away for > 6 hours'
    );

    // 6.5 full: ผู้ใช้เปิดแอปครั้งแรก (ไม่มี session)
    assert.strictEqual(
      decideBriefingMode(null, currentHash, now),
      'full',
      'Should use full mode when no session exists'
    );
  });

  // ── Part 5: New Advanced Verification Tests (T7 - T19) ──

  it('7. (T7) EC=1.16, TDS=580 ต่ำพร้อมกัน -> issues มี 1 กลุ่ม nutrient_concentration และข้อความมีทั้ง "EC" และ "TDS" พร้อมตัวเลข', () => {
    const facts = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current: { pH: 6.0, ec: 1.16, tds: 580, tempC: 25.0 },
      targets: { ecMin: 1.4, ecMax: 1.8, phMin: 5.5, phMax: 6.5 },
    });
    assert.strictEqual(facts.issues.length, 1);
    assert.strictEqual(facts.issues[0].group, 'nutrient_concentration');
    assert.ok(facts.issues[0].text.includes('EC=1.16'));
    assert.ok(facts.issues[0].text.includes('TDS=580'));
  });

  it('8. (T8) EC ต่ำ + pH สูง -> 2 กลุ่ม และ validateBriefing ปฏิเสธข้อความ AI ที่พูดถึงแค่ EC', () => {
    const facts = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current: { pH: 7.2, ec: 1.16, tds: 580, tempC: 25.0 },
      targets: { ecMin: 1.4, ecMax: 1.8, phMin: 5.5, phMax: 6.5 },
    });
    assert.strictEqual(facts.issues.length, 2);
    const groups = facts.issues.map((i) => i.group);
    assert.ok(groups.includes('nutrient_concentration'));
    assert.ok(groups.includes('ph'));

    // AI พูดถึงแค่ EC และลืม pH
    const partialAiOutput = 'สวัสดีตอนเช้าครับหัวหน้า ตอนนี้แปลงกรีนโอ๊คค่า EC อยู่ที่ 1.16 mS/cm ต่ำกว่าเกณฑ์ แนะนำเติมปุ๋ยครับ';
    const val = validateBriefing(partialAiOutput, facts);
    assert.strictEqual(val.isValid, false, 'Should reject partial issue mention');
    assert.strictEqual(val.fallbackUsed, true);
  });

  it('9. (T9) AI ตอบ "สภาพน้ำสมบูรณ์" ขณะ EC ต่ำ -> fallback ไม่มีคำว่า "สมบูรณ์"', () => {
    const facts = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current: { pH: 6.0, ec: 1.16, tds: 580, tempC: 25.0 },
      targets: { ecMin: 1.4, ecMax: 1.8, phMin: 5.5, phMax: 6.5 },
    });
    const faultyText = 'สวัสดีครับ สภาพน้ำสมบูรณ์พร้อมเข้าสู่รอบค่ำครับ แปลงกรีนโอ๊คโตดี';
    const val = validateBriefing(faultyText, facts);
    assert.strictEqual(val.fallbackUsed, true);
    assert.ok(!val.text.includes('สมบูรณ์'));
  });

  it('10. (T10) AI แต่งตัวเลขที่ไม่มีใน facts (เช่น EC 1.9) -> fallback', () => {
    const facts = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current: { pH: 6.0, ec: 1.16, tds: 580, tempC: 25.0 },
      targets: { ecMin: 1.4, ecMax: 1.8, phMin: 5.5, phMax: 6.5 },
    });
    // AI กุตัวเลข 1.9 ขึ้นมาเอง
    const hallucinatedNumberText = 'สวัสดีครับหัวหน้า ตรวจพบค่า EC 1.9 mS/cm และ TDS 580 ppm ในแปลง แนะนำตรวจเช็กครับ';
    const val = validateBriefing(hallucinatedNumberText, facts);
    assert.strictEqual(val.fallbackUsed, true, 'Should reject hallucinated number 1.9');
  });

  it('11. (T11) ทุกค่า optimal แต่ AI เขียนว่า "EC ต่ำกว่าเกณฑ์" -> fallback', () => {
    const facts = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current: { pH: 6.0, ec: 1.50, tds: 750, tempC: 25.0 },
      targets: { ecMin: 1.4, ecMax: 1.8, phMin: 5.5, phMax: 6.5 },
    });
    assert.strictEqual(facts.overallStatus, 'optimal');
    const falseAlarmText = 'สวัสดีตอนเช้าครับหัวหน้า ตรวจพบค่า EC ต่ำกว่าเกณฑ์ในแปลงกรีนโอ๊ค แนะนำเติมปุ๋ยครับ';
    const val = validateBriefing(falseAlarmText, facts);
    assert.strictEqual(val.fallbackUsed, true, 'Should reject false negative alarm when all optimal');
  });

  it('12. (T12) buildUserContext เปิดครั้งแรก -> isFirstOpen=true, isAwayLong=false, ข้อความ fallback ไม่มี "24 ชม."', () => {
    const ctx = buildUserContext({ lastOpenAt: null });
    assert.strictEqual(ctx.isFirstOpen, true);
    assert.strictEqual(ctx.isAwayLong, false);
    assert.strictEqual(ctx.hoursSinceLastOpen, null);

    const facts = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current: { pH: 6.0, ec: 1.50, tds: 750, tempC: 25.0 },
      targets: { ecMin: 1.4, ecMax: 1.8, phMin: 5.5, phMax: 6.5 },
    });
    const fallback = generateFallbackBriefing(facts, ctx);
    assert.ok(!fallback.includes('24 ชม.'));
  });

  it('13. (T13) หายไป 50 ชม. -> fallback ระบุ "2 วัน" หรือ "50 ชม." ตามจริง', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    const lastOpenAt = now.getTime() - 50 * 60 * 60 * 1000;
    const ctx = buildUserContext({ now, lastOpenAt });
    assert.strictEqual(ctx.isAwayLong, true);

    const facts = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current: { pH: 6.0, ec: 1.50, tds: 750, tempC: 25.0 },
      targets: { ecMin: 1.4, ecMax: 1.8, phMin: 5.5, phMax: 6.5 },
      now,
    });
    const fallback = generateFallbackBriefing(facts, ctx);
    assert.ok(fallback.includes('2 วัน') || fallback.includes('50 ชม.'));
    assert.ok(!fallback.includes('24 ชม.'));
  });

  it('14. (T14) trackAppOpen คืน previousOpenAt เป็นเวลาครั้งก่อน ไม่ใช่เวลาปัจจุบัน', () => {
    const testMap = new Map<string, string>();
    const mockStorage: BriefingStorage = {
      getItem: (k) => testMap.get(k) ?? null,
      setItem: (k, v) => { testMap.set(k, String(v)); },
      removeItem: (k) => { testMap.delete(k); },
    };
    setBriefingStorage(mockStorage);

    const t1 = 1700000000000;
    const res1 = trackAppOpen(t1);
    assert.strictEqual(res1.previousOpenAt, null, 'First open should have null previousOpenAt');

    const t2 = 1700003600000;
    const res2 = trackAppOpen(t2);
    assert.strictEqual(res2.previousOpenAt, t1, 'Second open should return previousOpenAt t1');

    setBriefingStorage(null);
  });

  it('15. (T15) hash เปลี่ยนเมื่อ diurnal เจอ night_leak ทั้งที่สถานะเซนเซอร์เท่าเดิม', () => {
    const current = { pH: 6.0, ec: 1.50, tds: 750, tempC: 25.0 };
    const targets = { ecMin: 1.4, ecMax: 1.8, phMin: 5.5, phMax: 6.5 };

    const factsNormal = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current,
      targets,
    });

    const fakeDiurnalLeak: any = {
      currentPhase: { key: 'night_dormancy', label: 'กลางคืน' },
      anomalyDetected: true,
      anomalyType: 'night_leak',
      waterLevelDropRatePerHour: 5.0,
    };

    const factsLeak = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current,
      targets,
      diurnal: fakeDiurnalLeak,
    });

    assert.notStrictEqual(factsNormal.dataHash, factsLeak.dataHash, 'Hash must change when night_leak is detected');
  });

  it('16. (T16) diurnalPredictor: EC=1.16 ด้วย target ชุดเดียวกัน ต้อง anomalyType="ec_dilution" และข้อความของทุกเคสปกติต้องไม่มีคำว่า สมบูรณ์/สมดุลดีมาก/ปลอดภัย 100%', () => {
    const metrics = analyzeDiurnalPattern(
      [],
      { pH: 6.0, ec: 1.16, tempC: 25.0 },
      'กรีนโอ๊ค',
      1.4, 1.8, 5.5, 6.5
    );
    assert.strictEqual(metrics.anomalyType, 'ec_dilution');

    // ตรวจสอบข้อความ 4 ช่วงเวลาในโหมดปกติ
    const times = [
      new Date('2026-11-15T08:00:00'), // morning
      new Date('2026-11-15T12:00:00'), // peak sun
      new Date('2026-11-15T16:30:00'), // afternoon
      new Date('2026-11-15T21:00:00'), // night
    ];

    for (const time of times) {
      const normalMetrics = analyzeDiurnalPattern(
        [],
        { pH: 6.0, ec: 1.50, tempC: 25.0 },
        'กรีนโอ๊ค',
        1.4, 1.8, 5.5, 6.5,
        undefined,
        time
      );
      assert.strictEqual(normalMetrics.anomalyType, 'none');
      const combinedText = `${normalMetrics.briefingMessage} ${normalMetrics.detailedAnalysis}`;
      assert.ok(!combinedText.includes('สมบูรณ์'), `Time ${time} must not have "สมบูรณ์"`);
      assert.ok(!combinedText.includes('สมดุลดีมาก'), `Time ${time} must not have "สมดุลดีมาก"`);
      assert.ok(!combinedText.includes('ปลอดภัย 100%'), `Time ${time} must not have "ปลอดภัย 100%"`);
      assert.ok(!combinedText.includes('ปราศจากสิ่งผิดปกติ'), `Time ${time} must not have "ปราศจากสิ่งผิดปกติ"`);
      assert.ok(!combinedText.includes('นอนหลับสบายใจ'), `Time ${time} must not have "นอนหลับสบายใจ"`);
    }
  });

  it('17. (T17) generateBriefing: mock callAI ให้ throw -> source="fallback" และข้อความยังพูดถึง EC', async () => {
    const result = await generateBriefing({
      sensors: { pH: 6.0, ec: 1.16, tds: 580, tempC: 25.0 },
      targets: { ecMin: 1.4, ecMax: 1.8, phMin: 5.5, phMax: 6.5 },
      callAI: async () => {
        throw new Error('AI Service Down');
      },
      previousOpenAt: null,
    });

    assert.strictEqual(result.source, 'fallback');
    assert.ok(result.text.includes('EC'));
    assert.ok(result.text.includes('1.16'));
  });

  it('18. (T18) generateBriefing: เรียกซ้ำใน 5 นาทีด้วยข้อมูลสถานะเดิม -> source="cache" และ callAI ถูกเรียกครั้งเดียว', async () => {
    let callCount = 0;
    const mockCallAI = async () => {
      callCount++;
      return 'แปลงกรีนโอ๊คสภาพน้ำทั้งหมดอยู่ในเกณฑ์เป้าหมาย พืชเจริญเติบโตได้ดีครับ';
    };

    const now1 = new Date('2026-11-15T10:00:00');
    const res1 = await generateBriefing({
      sensors: { pH: 6.0, ec: 1.50, tds: 750, tempC: 25.0 },
      targets: { ecMin: 1.4, ecMax: 1.8, phMin: 5.5, phMax: 6.5 },
      callAI: mockCallAI,
      now: now1,
      previousOpenAt: null,
    });
    assert.strictEqual(callCount, 1);

    // เรียกซ้ำใน 5 นาที
    const now2 = new Date('2026-11-15T10:05:00');
    const res2 = await generateBriefing({
      sensors: { pH: 6.0, ec: 1.52, tds: 760, tempC: 25.1 }, // slight jitter, same optimal hash
      targets: { ecMin: 1.4, ecMax: 1.8, phMin: 5.5, phMax: 6.5 },
      callAI: mockCallAI,
      now: now2,
      previousOpenAt: now1.getTime(),
    });

    assert.strictEqual(res2.source, 'cache');
    assert.strictEqual(callCount, 1, 'callAI should not be called second time due to cache reuse');
  });

  it('19. (T19) resolvePendingActions: บันทึก action ตอน EC ต่ำ แล้ว EC กลับปกติ -> เกิด FarmMemoryItem พร้อม outcomeResult', () => {
    const testMap = new Map<string, string>();
    const mockStorage: BriefingStorage = {
      getItem: (k) => testMap.get(k) ?? null,
      setItem: (k, v) => { testMap.set(k, String(v)); },
      removeItem: (k) => { testMap.delete(k); },
    };
    setBriefingStorage(mockStorage);

    // บันทึก action ตอน EC ต่ำ
    recordFarmAction('ec_low', 'เติมปุ๋ย A+B 50ml');

    // เมื่อ EC กลับมา optimal
    const factsRecovered = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current: { pH: 6.0, ec: 1.50, tds: 750, tempC: 25.0 },
      targets: { ecMin: 1.4, ecMax: 1.8, phMin: 5.5, phMax: 6.5 },
    });

    resolvePendingActions(factsRecovered);

    const memories = getRelevantMemory(['ec_low']);
    assert.strictEqual(memories.length, 1);
    assert.strictEqual(memories[0].actionTaken, 'เติมปุ๋ย A+B 50ml');
    assert.ok(memories[0].outcomeResult.includes('กลับเข้าเกณฑ์'));

    setBriefingStorage(null);
  });

  it('20. (T20) delta mode with resolved connectivity and ongoing low EC -> uses Thai label without brackets and mentions active EC issue', () => {
    const facts = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current: { pH: 6.07, ec: 1.18, tds: 590, tempC: 25.0 },
      targets: { ecMin: 1.2, ecMax: 1.8, phMin: 5.5, phMax: 6.5 },
    });
    const userCtx = buildUserContext({ lastOpenAt: Date.now() - 10 * 60 * 1000 }); // recent return
    const delta = {
      newIssues: [],
      resolvedIssues: ['connectivity'],
      ongoing: ['nutrient_concentration'],
    };

    const text = generateFallbackBriefing(facts, userCtx, 'delta', delta);
    // ต้องไม่มี [ ] และไม่มีคำว่า connectivity ภาษาอังกฤษดิบ
    assert.strictEqual(text.includes('[connectivity]'), false, 'Should not contain raw [connectivity]');
    assert.ok(text.includes('การเชื่อมต่ออุปกรณ์'), 'Should translate connectivity to การเชื่อมต่ออุปกรณ์');
    assert.ok(text.includes('แก้ไขกลับเข้าเกณฑ์แล้ว'), 'Should mention resolved status');
    assert.ok(text.includes('EC=1.18'), 'Should also mention active EC issue');
    assert.ok(text.includes('แนะนำเติมสารละลายแม่ปุ๋ย A และ B'), 'Should provide recommendation for ongoing issue');
  });

  it('21. (T21) getCachedBriefing rejects and deletes corrupted cache containing raw brackets or connectivity', () => {
    const testMap = new Map<string, string>();
    const mockStorage: BriefingStorage = {
      getItem: (k) => testMap.get(k) ?? null,
      setItem: (k, v) => { testMap.set(k, String(v)); },
      removeItem: (k) => { testMap.delete(k); },
    };
    setBriefingStorage(mockStorage);

    // จำลองเคสแคชเก่าที่บันทึกข้อความผิดพลาดตกค้างไว้
    const corruptedCached = {
      dataHash: 'test-hash-123',
      message: 'กลับมาตรวจแปลงอีกรอบนะครับหัวหน้า! ปัญหา [connectivity] ได้รับการแก้ไขกลับเข้าเกณฑ์แล้ว ครับ',
      headline: 'สถานะการเชื่อมต่อ',
      severity: 'optimal' as const,
      timestamp: Date.now(),
    };
    mockStorage.setItem('smartfarm_briefing_cache_v4', JSON.stringify(corruptedCached));

    const result = getCachedBriefing('test-hash-123');
    assert.strictEqual(result, null, 'Must reject cached briefing containing raw brackets/connectivity');
    assert.strictEqual(mockStorage.getItem('smartfarm_briefing_cache_v4'), null, 'Must delete corrupted cache key from storage');

    setBriefingStorage(null);
  });

  it('22. (T22) calculatePlantDays correctly calculates 1-based plant age uniformly', () => {
    const baseDate = new Date('2026-11-13T10:00:00Z');
    const startMs = baseDate.getTime();

    // วันที่เริ่มปลูก (ชั่วโมงที่ 0) -> วันที่ 1 (D1)
    assert.strictEqual(calculatePlantDays(startMs, baseDate), 1);

    // 12 ชั่วโมงหลังเริ่มปลูก -> วันที่ 1 (D1)
    const after12h = new Date(startMs + 12 * 3600 * 1000);
    assert.strictEqual(calculatePlantDays(startMs, after12h), 1);

    // 24 ชั่วโมงหลังเริ่มปลูก -> วันที่ 2 (D2)
    const after24h = new Date(startMs + 24 * 3600 * 1000);
    assert.strictEqual(calculatePlantDays(startMs, after24h), 2);

    // 48 ชั่วโมงหลังเริ่มปลูก (เข้าสู่วันที่ 3) -> วันที่ 3 (D3)
    const after48h = new Date(startMs + 48 * 3600 * 1000);
    assert.strictEqual(calculatePlantDays(startMs, after48h), 3);

    // 50 ชั่วโมงหลังเริ่มปลูก (2 วันกว่าๆ) -> วันที่ 3 (D3) ไม่ใช่ 2!
    const after50h = new Date(startMs + 50 * 3600 * 1000);
    assert.strictEqual(calculatePlantDays(startMs, after50h), 3);
  });
});

describe('Honest no-data / unknown-value behaviour', () => {
  it('ND1. online with pH/EC/TDS/temp all null -> overallStatus no_data and never "in range"', () => {
    const facts = evaluateFarm({
      plantType: 'กรีนโอ๊ค',
      current: { pH: null, ec: null, tds: null, tempC: null },
      targets: { phMin: 5.8, phMax: 6.5, ecMin: 1.4, ecMax: 1.8 },
      isOnline: true,
    });
    assert.strictEqual(facts.overallStatus, 'no_data');
    assert.strictEqual(facts.issues.length, 0);
    const text = generateFallbackBriefing(facts, buildUserContext({}), 'full');
    assert.ok(!text.includes('อยู่ในเกณฑ์'), `must not claim in range: ${text}`);
    assert.ok(text.includes('ยังไม่ได้รับค่า'), `must say no readings: ${text}`);
    assert.ok(!text.includes('หัวหน้า'), 'no persona call name by default');
    // AI output is never trusted when there is no data to check it against
    const v = validateBriefing('สวัสดีครับ ตอนนี้ทุกค่าอยู่ในเกณฑ์ปกติดีมากครับผม', facts, buildUserContext({}), 'full');
    assert.strictEqual(v.fallbackUsed, true);
  });

  it('ND2. unknown harvest cycle -> harvestDaysRemaining null (UI shows --), known cycle -> number', () => {
    const base = {
      plantType: 'กรีนโอ๊ค',
      current: { pH: 6.0, ec: 1.5, tds: 750, tempC: 25 },
      targets: { phMin: 5.8, phMax: 6.5, ecMin: 1.4, ecMax: 1.8 },
      plantStartDate: Date.now() - 5 * 86400000,
    };
    assert.strictEqual(evaluateFarm(base).harvestDaysRemaining, null);
    const known = evaluateFarm({ ...base, expectedHarvestDays: 45 });
    assert.strictEqual(typeof known.harvestDaysRemaining, 'number');
  });

  it('ND3. diurnal: fewer than 2 history points -> null EC rate; no water-drop output', () => {
    const m = analyzeDiurnalPattern([], { pH: 6.0, ec: 1.5, tempC: 25 }, 'กรีนโอ๊ค', 1.4, 1.8, 5.5, 6.5);
    assert.strictEqual(m.ecConsumptionRatePerHour, null);
    assert.ok(!('waterLevelDropRatePerHour' in m), 'no level sensor -> no water-drop rate');
    assert.ok(!m.briefingMessage.includes('หัวหน้า'));
  });
});
