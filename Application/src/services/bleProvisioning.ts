/**
 * bleProvisioning.ts — ตัวช่วย BLE กลางสำหรับการจับคู่อุปกรณ์ (CONTRACT v3 §5)
 *
 * ใช้ร่วมกันโดย AddBoardScreen / ConnectBoardScreen / WifiSetupScreen
 * - เช็ก native platform + Capacitor.isPluginAvailable('BluetoothLe') ก่อนเรียกทุกครั้ง (BUG-003)
 * - connect แบบ retry + exponential backoff + jitter (4 ครั้ง, timeout 8 วิ/ครั้ง)
 * - ค้นหาอุปกรณ์ด้วยชื่อที่ตรงกันทุกตัวอักษรเท่านั้น (ห้ามจับคู่แบบ substring "FARM"/"HYDRO") (C12)
 */
import { Capacitor } from '@capacitor/core';
import { BleClient, ScanMode, ScanResult } from '@capacitor-community/bluetooth-le';

export const ESP32_SERVICE_UUID = '0000ffff-0000-1000-8000-00805f9b34fb';
export const ESP32_CHAR_UUID = '0000ff01-0000-1000-8000-00805f9b34fb';

/** รูปแบบชื่ออุปกรณ์ / deviceId ใน ThingsBoard */
export const DEVICE_NAME_RE = /^FARM-[A-Z0-9-]{2,32}$/;
/** claim secret 10 ตัวอักษร */
export const CLAIM_CODE_RE = /^[A-Za-z0-9]{10}$/;

const CONNECT_TIMEOUT_MS = 8000;
const CONNECT_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;

export class BleUnavailableError extends Error {
  constructor(message = 'BLE_UNAVAILABLE') {
    super(message);
    this.name = 'BleUnavailableError';
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** หน่วงเวลาแบบ exponential backoff (1s, 2s, 4s, ... สูงสุด 30s) พร้อม jitter ±20% กัน thundering herd */
export function backoffDelay(attempt: number, baseMs = BACKOFF_BASE_MS, maxMs = BACKOFF_MAX_MS): number {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  // jitter สำหรับการ retry เท่านั้น (ไม่ใช่ค่าข้อมูลที่แสดงผล)
  const jitter = exp * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

/** BLE ใช้ได้เฉพาะแอปบนมือถือที่มีปลั๊กอิน BluetoothLe จริง */
export function isBleAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('BluetoothLe');
  } catch {
    return false;
  }
}

/** true บน iOS (deviceId ของ BLE เป็น UUID ที่ระบบสุ่มให้ ใช้ MAC จาก QR ไม่ได้) */
export function isIos(): boolean {
  try {
    return Capacitor.getPlatform() === 'ios';
  } catch {
    return false;
  }
}

/** รูปแบบ MAC "AA:BB:CC:DD:EE:FF" */
export function isMacAddress(id: string | null | undefined): boolean {
  return !!id && /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i.test(id);
}

let initPromise: Promise<void> | null = null;

/** initialize BLE ครั้งเดียว + ขอเปิดบลูทูธถ้าปิดอยู่ (Android) */
export async function ensureInit(): Promise<void> {
  if (!isBleAvailable()) throw new BleUnavailableError();
  if (!initPromise) {
    // Android 12+: BLUETOOTH_SCAN has neverForLocation in the manifest, so scanning works even with
    // the phone's Location switched off. Android 11 and older still need Location ON (checked below).
    initPromise = BleClient.initialize({ androidNeverForLocation: true }).catch((e) => {
      initPromise = null;
      throw e;
    });
  }
  await initPromise;
  let enabled = true;
  try {
    enabled = await BleClient.isEnabled();
  } catch {
    enabled = true;
  }
  if (!enabled) {
    if (!isIos()) {
      await BleClient.requestEnable().catch(() => {});
    }
    const nowEnabled = await BleClient.isEnabled().catch(() => false);
    if (!nowEnabled) throw new Error('BLE_DISABLED');
  }
  // Android <= 11 returns NO scan results (silently) while the Location switch is off.
  if (needsLocationForScan()) {
    const locOn = await BleClient.isLocationEnabled().catch(() => true);
    if (!locOn) throw new Error('LOCATION_DISABLED');
  }
}

/** Android version from the WebView user agent (null on iOS / unknown). */
function androidMajorVersion(): number | null {
  if (isIos()) return null;
  const m = /Android\s+(\d+)/i.exec(typeof navigator !== 'undefined' ? navigator.userAgent : '');
  return m ? Number(m[1]) : null;
}

/** Android 11 (API 30) and older need the Location switch ON for BLE scan results. */
function needsLocationForScan(): boolean {
  const v = androidMajorVersion();
  return v !== null && v <= 11;
}

/** Opens the phone's Location settings (Android). */
export async function openLocationSettings(): Promise<void> {
  await BleClient.openLocationSettings().catch(() => {});
}

/** ชื่อที่โฆษณาของผลสแกน (ใช้ทั้ง device.name และ localName) */
export function scanResultName(result: ScanResult): string {
  // Android keeps a cached name per MAC (can be stale from older firmware): the advertised
  // localName is the current one, so prefer whichever of the two is a valid FARM-xxxx name.
  const advertised = (result.localName || '').trim();
  const cached = (result.device?.name || '').trim();
  if (DEVICE_NAME_RE.test(advertised.toUpperCase())) return advertised;
  if (DEVICE_NAME_RE.test(cached.toUpperCase())) return cached;
  return advertised || cached;
}

/**
 * สแกนหาอุปกรณ์ที่ชื่อ "ตรงกันทุกตัวอักษร" (ไม่สนตัวพิมพ์เล็ก-ใหญ่) แล้ว stopLEScan ทันที
 * คืน BLE deviceId (Android = MAC, iOS = UUID) หรือ null เมื่อหมดเวลา
 */
export async function findDeviceByExactName(name: string, timeoutMs = 10000): Promise<string | null> {
  await ensureInit();
  const target = name.trim().toUpperCase();
  if (!target) return null;

  let found: string | null = null;
  let settle: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });

  try {
    await BleClient.requestLEScan(
      {
        // ไม่กรองด้วย service UUID ระดับระบบ: บางเครื่อง/เฟิร์มแวร์เก่าใส่ UUID ไม่ครบในแพ็กเก็ตโฆษณา
        // จึงคัดด้วยชื่อ FARM-xxxx ใน callback แทน (ทั้ง service และชื่อมาจากอุปกรณ์จริงเท่านั้น)
        allowDuplicates: true, // ผลแรกอาจยังไม่มีชื่อ (ชื่อมากับ scan response) ต้องให้รายงานซ้ำได้ เรากันซ้ำเองด้วย deviceId
        scanMode: ScanMode.SCAN_MODE_LOW_LATENCY,
      },
      (result) => {
        if (found) return;
        if (scanResultName(result).toUpperCase() === target) {
          found = result.device.deviceId;
          settle?.();
        }
      }
    );
    const timer = setTimeout(() => settle?.(), timeoutMs);
    await done;
    clearTimeout(timer);
  } finally {
    await BleClient.stopLEScan().catch(() => {});
  }
  return found;
}

/**
 * เชื่อมต่อแบบ retry 4 ครั้ง (timeout 8 วิ/ครั้ง) พร้อม exponential backoff + jitter
 * โยน error สุดท้ายเมื่อเชื่อมไม่ได้ทุกครั้ง
 */
export async function connectWithRetry(
  deviceId: string,
  onDisconnect?: (deviceId: string) => void,
  shouldAbort?: () => boolean
): Promise<void> {
  await ensureInit();
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
    if (shouldAbort?.()) throw new Error('ABORTED');
    try {
      await BleClient.connect(deviceId, onDisconnect, { timeout: CONNECT_TIMEOUT_MS });
      return;
    } catch (e) {
      lastErr = e;
      // ปิดการเชื่อมที่ค้างครึ่งทางก่อนลองใหม่
      await BleClient.disconnect(deviceId).catch(() => {});
      if (attempt < CONNECT_ATTEMPTS - 1) {
        await sleep(backoffDelay(attempt));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('BLE_CONNECT_FAILED');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toDataView(obj: unknown): DataView {
  const bytes = encoder.encode(JSON.stringify(obj));
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function parseDataView(value: DataView): any | null {
  try {
    const text = decoder.decode(value);
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function writeJson(deviceId: string, payload: unknown): Promise<void> {
  await BleClient.write(deviceId, ESP32_SERVICE_UUID, ESP32_CHAR_UUID, toDataView(payload), { timeout: CONNECT_TIMEOUT_MS });
}

export async function readJson(deviceId: string): Promise<any | null> {
  const value = await BleClient.read(deviceId, ESP32_SERVICE_UUID, ESP32_CHAR_UUID, { timeout: CONNECT_TIMEOUT_MS });
  return parseDataView(value);
}

export async function startJsonNotifications(deviceId: string, onMessage: (msg: any) => void): Promise<void> {
  await BleClient.startNotifications(deviceId, ESP32_SERVICE_UUID, ESP32_CHAR_UUID, (value) => {
    const msg = parseDataView(value);
    if (msg) onMessage(msg);
  });
}

export async function stopJsonNotifications(deviceId: string): Promise<void> {
  if (!isBleAvailable()) return;
  await BleClient.stopNotifications(deviceId, ESP32_SERVICE_UUID, ESP32_CHAR_UUID).catch(() => {});
}

/** ปิดทุกอย่างที่เกี่ยวกับอุปกรณ์นี้ (เรียกได้ซ้ำ ไม่โยน error) */
export async function releaseDevice(deviceId: string | null | undefined): Promise<void> {
  if (!deviceId || !isBleAvailable()) return;
  await stopJsonNotifications(deviceId);
  await BleClient.disconnect(deviceId).catch(() => {});
}

/** หยุดสแกน (ไม่โยน error) */
export async function stopScanSafe(): Promise<void> {
  if (!isBleAvailable()) return;
  await BleClient.stopLEScan().catch(() => {});
}

/** โค้ด error ของบอร์ดจากผลอ่าน/notify — fw ใหม่ใช้ `error`, fw เก่าใช้ `reason` */
export function boardErrorCode(msg: any): string | null {
  if (!msg || typeof msg !== 'object') return null;
  const code = msg.error ?? msg.reason;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/** แปลงโค้ด error จากบอร์ดเป็นข้อความภาษาไทยที่บอกสาเหตุจริง */
export function boardErrorMessage(code: string | null, ssid?: string): string {
  switch (code) {
    case 'ERR_WIFI_WRONG_PASSWORD':
      return 'รหัสผ่าน Wi-Fi ไม่ถูกต้อง โปรดตรวจสอบแล้วลองใหม่';
    case 'ERR_WIFI_NO_AP_FOUND':
      return ssid
        ? `อุปกรณ์หาสัญญาณ Wi-Fi "${ssid}" ไม่พบ โปรดตรวจชื่อ Wi-Fi (ต้องเป็น 2.4GHz) และระยะห่าง`
        : 'อุปกรณ์หาสัญญาณ Wi-Fi ไม่พบ โปรดตรวจชื่อ Wi-Fi (ต้องเป็น 2.4GHz) และระยะห่าง';
    case 'ERR_WIFI_TIMEOUT':
      return 'อุปกรณ์เชื่อมต่อ Wi-Fi ไม่สำเร็จภายในเวลาที่กำหนด โปรดตรวจว่าเป็น Wi-Fi 2.4GHz สัญญาณแรงพอ และรหัสผ่านถูกต้อง แล้วลองใหม่';
    case 'ERR_LOCKED_OUT':
      return 'อุปกรณ์ล็อกชั่วคราวเพราะยืนยันรหัสผิดหลายครั้ง โปรดรอ 5 นาทีแล้วลองใหม่';
    case 'UNAUTHORIZED':
    case 'ERR_AUTH_FAILED':
      return 'อุปกรณ์ไม่ยอมรับรหัสยืนยัน โปรดสแกน QR บนหน้าจออุปกรณ์ใหม่อีกครั้ง';
    case 'ERR_CODE_MISMATCH':
      return 'ตัวเลขไม่ตรงกับหน้าจออุปกรณ์ โปรดดูอีกครั้ง';
    default:
      return code
        ? `อุปกรณ์แจ้งข้อผิดพลาด (${code}) โปรดลองใหม่อีกครั้ง`
        : 'เชื่อมต่อ Wi-Fi ไม่สำเร็จ โปรดตรวจสอบชื่อและรหัสผ่าน แล้วลองใหม่อีกครั้ง';
  }
}

/** ข้อความภาษาไทยเมื่อเชื่อม BLE ไม่ได้ */
export function bleConnectErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (err instanceof BleUnavailableError) return 'ต้องใช้แอปบนมือถือเพื่อเชื่อมต่ออุปกรณ์ผ่านบลูทูธ';
  if (msg === 'BLE_DISABLED') return 'บลูทูธปิดอยู่ โปรดเปิดบลูทูธแล้วลองใหม่';
  if (msg === 'LOCATION_DISABLED') return 'มือถือรุ่นนี้ต้องเปิดตำแหน่ง (Location) ก่อนจึงจะค้นหาอุปกรณ์ผ่านบลูทูธได้ โปรดเปิดตำแหน่งแล้วลองใหม่';
  if (/permission|denied|unauthori[sz]ed/i.test(msg)) return 'แอปยังไม่ได้รับอนุญาตให้ใช้บลูทูธหรือตำแหน่ง โปรดอนุญาตในการตั้งค่าแล้วลองใหม่';
  return 'เชื่อมต่อบลูทูธกับอุปกรณ์ไม่สำเร็จ โปรดถือโทรศัพท์ใกล้อุปกรณ์แล้วลองใหม่';
}
