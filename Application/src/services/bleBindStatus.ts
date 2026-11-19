/**
 * bleBindStatus.ts — ขั้นตอนหลังส่ง WiFi สำเร็จ: claim ใน ThingsBoard แล้วรอบอร์ดยืนยันผูก (CONTRACT v3 §2-3)
 *
 * - claim ต้องรอให้บอร์ดต่อ MQTT แล้ว publish `v1/devices/me/claim` ก่อน จึงต้อง retry (backoff + jitter)
 * - การยืนยันผูกดูจาก client attribute `bound === true` ที่บอร์ดรายงานเอง (ไม่เดา ไม่จำลอง)
 */
import { thingsboard } from './thingsboard';
import { backoffDelay, sleep } from './bleProvisioning';

export type ClaimResult = { success: boolean; message: string; deviceId?: string };
export type ClaimFn = (deviceId: string, claimCode: string) => Promise<ClaimResult>;
export type WaitBoundFn = (deviceId: string, timeoutMs: number) => Promise<boolean>;

/**
 * เรียก claim ซ้ำจนสำเร็จหรือหมดเวลา (ค่าเริ่ม 45 วิ) — คืนผลล่าสุดพร้อมข้อความจริงจากระบบ
 */
export async function claimWithRetry(
  claim: ClaimFn,
  deviceName: string,
  claimCode: string,
  opts: { totalMs?: number; shouldAbort?: () => boolean } = {}
): Promise<ClaimResult> {
  const totalMs = opts.totalMs ?? 45000;
  const deadline = Date.now() + totalMs;
  let last: ClaimResult = { success: false, message: 'ยังไม่ได้ผูกอุปกรณ์' };
  for (let attempt = 0; ; attempt++) {
    if (opts.shouldAbort?.()) return { success: false, message: 'ABORTED' };
    try {
      last = await claim(deviceName, claimCode);
    } catch (e: any) {
      last = { success: false, message: e?.message || 'การผูกอุปกรณ์ล้มเหลว' };
    }
    if (last.success) return last;
    const wait = backoffDelay(attempt, 2000, 8000);
    if (Date.now() + wait >= deadline) return last;
    await sleep(wait);
  }
}

/** อ่าน client attribute `bound` จาก ThingsBoard (true/false/null = ยังไม่มีข้อมูล) */
export async function readBoundAttribute(tbDeviceId: string): Promise<boolean | null> {
  const attrs = await thingsboard.getAttributes(tbDeviceId);
  const bound = (attrs || []).find((a) => a.key === 'bound');
  if (!bound) return null;
  return bound.value === true || bound.value === 'true';
}

/**
 * ทางสำรองของ `waitForBoardBound` จาก context: poll `bound` ทุก ~2 วิ จนเป็น true หรือหมดเวลา
 */
export async function waitForBoundViaAttributes(
  tbDeviceId: string,
  timeoutMs = 30000,
  shouldAbort?: () => boolean
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldAbort?.()) return false;
    try {
      if ((await readBoundAttribute(tbDeviceId)) === true) return true;
    } catch {
      // เครือข่ายสะดุดชั่วคราว ลองรอบถัดไป
    }
    await sleep(2000);
  }
  return false;
}

/**
 * เลือกใช้ `waitForBoardBound` ของ context ถ้ามี (เพื่อนร่วมทีม frontend กำลังเพิ่ม) ไม่งั้นใช้ทางสำรองข้างบน
 */
export function pickWaitBound(ctx: unknown, shouldAbort?: () => boolean): WaitBoundFn {
  const fn = (ctx as { waitForBoardBound?: unknown } | null)?.waitForBoardBound;
  if (typeof fn === 'function') {
    return (deviceId, timeoutMs) => Promise.resolve((fn as WaitBoundFn)(deviceId, timeoutMs)).then(Boolean);
  }
  return (deviceId, timeoutMs) => waitForBoundViaAttributes(deviceId, timeoutMs, shouldAbort);
}
