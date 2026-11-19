import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  normalizePlantName,
  validatePlantProfile,
  mergePlantTargets,
  getPlantProfile,
  getPlantLock,
  setPlantLock,
  cancelPlantLockInGrace,
  isPlantLockedForNewAI,
  setPlantStorage,
  PlantLockedError,
  type PlantStorage,
  type PlantProfile,
} from './plantProfileService.ts';

describe('Plant Profile AI Service & Quota Lock Tests', () => {
  let memoryStore: Map<string, string>;
  let mockStorage: PlantStorage;

  beforeEach(() => {
    memoryStore = new Map<string, string>();
    mockStorage = {
      getItem: (k) => memoryStore.get(k) ?? null,
      setItem: (k, v) => { memoryStore.set(k, String(v)); },
      removeItem: (k) => { memoryStore.delete(k); },
    };
    setPlantStorage(mockStorage);
  });

  // ── 1. normalizePlantName ──
  it('1. normalizePlantName handles Thai/English aliases, spaces, and cases', () => {
    assert.strictEqual(normalizePlantName('  Green Oak  '), 'กรีนโอ๊ค');
    assert.strictEqual(normalizePlantName('COS'), 'สลัดคอส');
    assert.strictEqual(normalizePlantName('ขึ้นฉ่าย'), 'คื่นฉ่าย');
    assert.strictEqual(normalizePlantName('Strawberry'), 'สตรอเบอร์รี่');
    assert.strictEqual(normalizePlantName('เมล่อน'), 'เมลอน');
    assert.strictEqual(normalizePlantName('พืชสมุนไพรแปลก'), 'พืชสมุนไพรแปลก');
  });

  // ── 2. validatePlantProfile ──
  it('2. validatePlantProfile rejects values exceeding safety ceilings', () => {
    // 2.1 pH ต่ำกว่า 4.5
    assert.throws(() => {
      validatePlantProfile({
        recognized: true,
        canonical_name_th: 'พืชทดสอบ',
        ph: { min: 4.2, max: 6.0 },
        ec_ms_cm: { min: 1.2, max: 1.8 },
        water_temp_c: { min: 20, max: 25 },
        harvest_days: { min: 30, max: 40 },
      });
    }, /pH range out of safety ceilings/);

    // 2.2 EC เกิน 4.0
    assert.throws(() => {
      validatePlantProfile({
        recognized: true,
        canonical_name_th: 'พืชทดสอบ',
        ph: { min: 5.5, max: 6.5 },
        ec_ms_cm: { min: 1.2, max: 4.5 },
        water_temp_c: { min: 20, max: 25 },
        harvest_days: { min: 30, max: 40 },
      });
    }, /EC range out of safety ceilings/);

    // 2.3 min >= max
    assert.throws(() => {
      validatePlantProfile({
        recognized: true,
        canonical_name_th: 'พืชทดสอบ',
        ph: { min: 6.5, max: 5.5 },
        ec_ms_cm: { min: 1.2, max: 1.8 },
        water_temp_c: { min: 20, max: 25 },
        harvest_days: { min: 30, max: 40 },
      });
    }, /pH range out of safety ceilings/);

    // 2.4 ค่าถูกต้องผ่านฉลุย
    const valid = validatePlantProfile({
      recognized: true,
      canonical_name_th: 'เมลอน',
      canonical_name_en: 'Melon',
      hydroponic_suitable: true,
      ph: { min: 6.0, max: 6.8 },
      ec_ms_cm: { min: 2.0, max: 2.5 },
      water_temp_c: { min: 24.0, max: 28.0 },
      harvest_days: { min: 75, max: 85 },
      confidence: 'high',
      notes: 'ต้องการน้ำสม่ำเสมอ',
    });
    assert.strictEqual(valid.canonical_name_th, 'เมลอน');
    assert.strictEqual(valid.confidence, 'high');
  });

  // ── 3. mergePlantTargets: ซ้อนทับกันได้ ──
  it('3. mergePlantTargets calculates proper overlapping intersection', () => {
    const greenOak: PlantProfile = {
      recognized: true,
      canonical_name_th: 'กรีนโอ๊ค',
      canonical_name_en: 'Green Oak',
      hydroponic_suitable: true,
      harvest_days: { min: 40, max: 45 },
      ph: { min: 5.8, max: 6.5 },
      ec_ms_cm: { min: 1.4, max: 1.8 },
      water_temp_c: { min: 22.0, max: 26.0 },
      confidence: 'high',
      notes: '',
    };

    const cos: PlantProfile = {
      recognized: true,
      canonical_name_th: 'สลัดคอส',
      canonical_name_en: 'Cos',
      hydroponic_suitable: true,
      harvest_days: { min: 45, max: 50 },
      ph: { min: 6.0, max: 6.8 },
      ec_ms_cm: { min: 1.5, max: 2.0 },
      water_temp_c: { min: 22.0, max: 26.0 },
      confidence: 'high',
      notes: '',
    };

    const merged = mergePlantTargets([greenOak, cos]);
    assert.strictEqual(merged.conflict, false);
    // Intersection: max(min) .. min(max)
    assert.strictEqual(merged.phMin, 6.0);
    assert.strictEqual(merged.phMax, 6.5);
    assert.strictEqual(merged.ecMin, 1.5);
    assert.strictEqual(merged.ecMax, 1.8);
    assert.strictEqual(merged.harvestDays, 50);
    assert.strictEqual(merged.disadvantagedPlants.length, 0);
  });

  // ── 4. mergePlantTargets: เกิด Conflict ไม่ซ้อนทับกัน ──
  it('4. mergePlantTargets detects conflict and recommends separate tanks', () => {
    const greenOak: PlantProfile = {
      recognized: true,
      canonical_name_th: 'กรีนโอ๊ค',
      canonical_name_en: 'Green Oak',
      hydroponic_suitable: true,
      harvest_days: { min: 40, max: 45 },
      ph: { min: 5.8, max: 6.5 },
      ec_ms_cm: { min: 1.4, max: 1.8 }, // 1.4 - 1.8
      water_temp_c: { min: 22.0, max: 26.0 },
      confidence: 'high',
      notes: '',
    };

    const strawberry: PlantProfile = {
      recognized: true,
      canonical_name_th: 'สตรอเบอร์รี่',
      canonical_name_en: 'Strawberry',
      hydroponic_suitable: true,
      harvest_days: { min: 70, max: 90 },
      ph: { min: 5.5, max: 6.2 },
      ec_ms_cm: { min: 0.8, max: 1.2 }, // 0.8 - 1.2 ไม่ซ้อนทับกับ 1.4 - 1.8
      water_temp_c: { min: 18.0, max: 22.0 },
      confidence: 'high',
      notes: '',
    };

    const merged = mergePlantTargets([greenOak, strawberry]);
    assert.strictEqual(merged.conflict, true);
    assert.ok(merged.warning?.includes('แนะนำแยกถัง'));
    assert.ok(merged.disadvantagedPlants.length > 0);
  });

  // ── 5. Cache hit ไม่เรียก AI ──
  it('5. getPlantProfile uses cache and does not call AI on second request', async () => {
    let aiCallCount = 0;
    const mockCallAI = async () => {
      aiCallCount++;
      return JSON.stringify({
        recognized: true,
        canonical_name_th: 'เมลอนสีทอง',
        canonical_name_en: 'Golden Melon',
        hydroponic_suitable: true,
        harvest_days: { min: 70, max: 80 },
        ph: { min: 5.8, max: 6.5 },
        ec_ms_cm: { min: 2.0, max: 3.0 },
        water_temp_c: { min: 22, max: 26 },
        confidence: 'high',
        notes: 'ผลดก',
      });
    };

    // ครั้งแรก: ยิง AI
    const p1 = await getPlantProfile('เมลอนสีทอง', mockCallAI);
    assert.strictEqual(aiCallCount, 1);
    assert.strictEqual(p1.canonical_name_th, 'เมลอนสีทอง');

    // ครั้งที่ 2: ดึงจาก Cache ทันที ไม่ยิง AI
    const p2 = await getPlantProfile('เมลอนสีทอง', mockCallAI);
    assert.strictEqual(aiCallCount, 1, 'AI must not be called again on cache hit');
    assert.strictEqual(p2.isFromCache, true);
  });

  // ── 6. ก่อนยืนยันไม่ล็อก ──
  it('6. PlantLock is not active before user confirms planting', () => {
    assert.strictEqual(getPlantLock(), null);
    assert.strictEqual(isPlantLockedForNewAI(), false);
  });

  // ── 7. อยู่ใน Grace 10 นาทีแรก แก้ไขได้ ──
  it('7. Within 10-minute grace period user can cancel lock', () => {
    const t0 = new Date('2026-11-15T10:00:00Z');
    setPlantLock(['กรีนโอ๊ค'], t0);

    // ตรวจสอบที่เวลา 5 นาทีถัดมา (ยังอยู่ใน Grace)
    const t5 = new Date('2026-11-15T10:05:00Z');
    assert.strictEqual(isPlantLockedForNewAI(t5), false, 'Should not lock AI within grace period');

    // ยกเลิกได้สำเร็จ
    const cancelled = cancelPlantLockInGrace(t5);
    assert.strictEqual(cancelled, true);
    assert.strictEqual(getPlantLock(t5), null);
  });

  // ── 8. หลัง Grace ล็อกจริง และปฏิเสธการเรียก AI ใหม่ ──
  it('8. After grace period, calling AI throws PlantLockedError', async () => {
    const t0 = new Date('2026-11-15T10:00:00Z');
    setPlantLock(['กรีนโอ๊ค'], t0);

    // ตรวจสอบที่เวลา 15 นาทีถัดมา (พ้น Grace 10 นาทีแล้ว)
    const t15 = new Date('2026-11-15T10:15:00Z');
    assert.strictEqual(isPlantLockedForNewAI(t15), true);

    await assert.rejects(async () => {
      await getPlantProfile(
        'พืชใหม่แปลกตา',
        async () => 'some json',
        t15
      );
    }, PlantLockedError);
  });

  // ── 9. ตอนล็อกอยู่ Cache Hit และ Builtin Hit ยังผ่านได้ ──
  it('9. Builtin and Cached plants can still be retrieved when locked', async () => {
    const t0 = new Date('2026-11-15T10:00:00Z');
    setPlantLock(['กรีนโอ๊ค'], t0);

    const t15 = new Date('2026-11-15T10:15:00Z'); // พ้น grace แล้ว

    // 9.1 Builtin พืชในแอป ต้องผ่านได้
    const greenOak = await getPlantProfile('กรีนโอ๊ค', undefined, t15);
    assert.strictEqual(greenOak.canonical_name_th, 'กรีนโอ๊ค');

    // 9.2 Cache Hit ต้องผ่านได้
    mockStorage.setItem(
      'smartfarm_plant_profile_เมลอน',
      JSON.stringify({
        recognized: true,
        canonical_name_th: 'เมลอน',
        ph: { min: 6.0, max: 6.8 },
        ec_ms_cm: { min: 2.0, max: 3.0 },
        water_temp_c: { min: 24, max: 28 },
        harvest_days: { min: 75, max: 85 },
      })
    );
    const melon = await getPlantProfile('เมลอน', undefined, t15);
    assert.strictEqual(melon.canonical_name_th, 'เมลอน');
  });

  // ── 10. พ้น 00:00 น. วันถัดไปแล้วปลดล็อกอัตโนมัติ ──
  it('10. Lock automatically expires after next midnight (00:00)', () => {
    const t0 = new Date('2026-11-15T14:30:00');
    setPlantLock(['กรีนโอ๊ค'], t0);

    // เวลา 23:59: ยังล็อกอยู่
    const tSameDayLate = new Date('2026-11-15T23:59:00');
    assert.strictEqual(isPlantLockedForNewAI(tSameDayLate), true);

    // เวลา 00:01 วันถัดไป: ปลดล็อกแล้ว
    const tNextDay = new Date('2026-11-16T00:01:00');
    assert.strictEqual(isPlantLockedForNewAI(tNextDay), false);
    assert.strictEqual(getPlantLock(tNextDay), null);
  });

  // ── 11. กันการโกงเวลา: นาฬิกาย้อนหลังไม่ทำให้ปลดล็อก ──
  it('11. Rolling system clock backwards does not unlock before time', () => {
    const t0 = new Date('2026-11-15T15:00:00');
    setPlantLock(['กรีนโอ๊ค'], t0);

    // ระบบจำ lastSeenAt = 15:00
    // ผู้ใช้แอบหมุนนาฬิกาถอยหลังไป 09:00
    const tTampered = new Date('2026-11-15T09:00:00');
    const lock = getPlantLock(tTampered);

    assert.notStrictEqual(lock, null, 'Lock must remain active even if clock is rolled backwards');
  });

  // ── 12. Offline Fallback: เมื่อ AI Throw ไม่ทำให้แอปพัง แต่ใช้ Fail-Closed ──
  it('12. Falls back to safe default profile when AI fails/offline', async () => {
    const fallbackProfile = await getPlantProfile('พืชแปลกใหม่มากๆ', async () => {
      throw new Error('Network Offline');
    });

    assert.strictEqual(fallbackProfile.recognized, false);
    assert.strictEqual(fallbackProfile.hydroponic_suitable, false);
    assert.strictEqual(fallbackProfile.confidence, 'low');
    // the user is told the AI call failed (and why), not that the plant does not exist
    assert.ok(fallbackProfile.notes.includes('วิเคราะห์ด้วย AI ไม่สำเร็จ'));
    assert.ok(fallbackProfile.notes.includes('เชื่อมต่ออินเทอร์เน็ตไม่ได้'));
  });

  it('12b. Without an AI callback an unknown plant is reported as not in the app database', async () => {
    const p = await getPlantProfile('พืชแปลกใหม่อีกชนิด');
    assert.strictEqual(p.recognized, false);
    assert.ok(p.notes.includes('ไม่พบพืชนี้ในฐานข้อมูลพืชในแอป'));
  });

  it('12c. Bad key (HTTP 403) is explained without echoing the response body', async () => {
    const p = await getPlantProfile('พืชทดสอบคีย์', async () => {
      throw new Error('Gemini API Error (403): {"error":"API key not valid"}');
    });
    assert.ok(p.notes.includes('คีย์ AI ไม่ถูกต้องหรือถูกปิดใช้งาน'));
    assert.ok(!p.notes.includes('API key not valid'));
  });

  // ── 13. Gibberish & Sanity Filter: ป้องกันคำสุ่ม เช่น "ตตตต" ──
  it('13. Rejects gibberish names like ตตตต and prevents false-positive merging', async () => {
    const gibberishProfile = await getPlantProfile('ตตตต');
    assert.strictEqual(gibberishProfile.recognized, false);
    assert.strictEqual(gibberishProfile.hydroponic_suitable, false);

    const greenOak: PlantProfile = {
      recognized: true,
      canonical_name_th: 'กรีนโอ๊ค',
      canonical_name_en: 'Green Oak',
      hydroponic_suitable: true,
      ph: { min: 5.8, max: 6.5 },
      ec_ms_cm: { min: 1.4, max: 1.8 },
      water_temp_c: { min: 22.0, max: 26.0 },
      harvest_days: { min: 40, max: 45 },
      confidence: 'high',
      notes: 'ปลอดภัย',
    };

    const merged = mergePlantTargets([greenOak, gibberishProfile]);
    assert.strictEqual(merged.conflict, true);
    assert.ok(merged.warning?.includes('ตตตต'));
    assert.strictEqual(merged.compatiblePlantNames.length, 0);
  });
});
