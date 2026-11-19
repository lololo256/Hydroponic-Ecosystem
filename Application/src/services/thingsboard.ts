/**
 * ThingsBoard Cloud (EU) Official REST Client
 * Standard: Pure ThingsBoard Cloud EU (Direct Connection Without Intermediate Servers)
 */

import { Preferences } from '@capacitor/preferences';

export interface TBTokens {
  token: string;
  refreshToken: string;
}

export interface TBUser {
  id: { id: string; entityType: string };
  createdTime: number;
  tenantId: { id: string; entityType: string };
  customerId: { id: string; entityType: string };
  email: string;
  authority: 'SYS_ADMIN' | 'TENANT_ADMIN' | 'CUSTOMER_USER';
  firstName: string;
  lastName: string;
  name: string;
}

export interface TBDevice {
  id: { id: string; entityType: string };
  createdTime: number;
  name: string;
  type: string;
  label?: string;
  customerId?: { id: string; entityType: string };
  deviceProfileId?: { id: string; entityType: string };
  additionalInfo?: Record<string, any>;
}

export interface TBTelemetryValue {
  ts: number;
  value: string | number | boolean;
}

export type TBLatestTelemetry = Record<string, TBTelemetryValue[]>;

export interface TBAlarm {
  id: { id: string; entityType: string };
  createdTime: number;
  name: string;
  type: string;
  originator: { id: string; entityType: string };
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING' | 'INDETERMINATE';
  status: 'ACTIVE_UNACK' | 'ACTIVE_ACK' | 'CLEARED_UNACK' | 'CLEARED_ACK';
  acknowledged: boolean;
  cleared: boolean;
  ackTs: number;
  clearTs: number;
  details?: Record<string, any>;
}

export type TBErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'OFFLINE'
  | 'INVALID_DATA'
  | 'SERVER_ERROR'
  | 'UNKNOWN';

export class TBError extends Error {
  code: TBErrorCode;
  status?: number;

  constructor(code: TBErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'TBError';
    this.code = code;
    this.status = status;
  }
}

const STORAGE_KEY_TOKEN = 'tb_token';
const STORAGE_KEY_REFRESH = 'tb_refresh_token';
const STORAGE_KEY_USER = 'smartfarm_current_user';
const DEFAULT_TIMEOUT_MS = 15000;

function getBaseUrl(): string {
  const envUrl = import.meta.env.VITE_TB_URL;
  if (envUrl && typeof envUrl === 'string' && envUrl.trim().length > 0) {
    return envUrl.trim().replace(/\/+$/, '');
  }
  return 'https://eu.thingsboard.cloud';
}

function parseJwtExp(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

let activeToken: string | null = null;
let activeRefreshToken: string | null = null;

function loadStoredTokens(): void {
  try {
    activeToken = localStorage.getItem(STORAGE_KEY_TOKEN);
    activeRefreshToken = localStorage.getItem(STORAGE_KEY_REFRESH);
  } catch {
    activeToken = null;
    activeRefreshToken = null;
  }
}

loadStoredTokens();

export function setTokens(token: string, refreshToken: string): void {
  activeToken = token;
  activeRefreshToken = refreshToken;
  try {
    localStorage.setItem(STORAGE_KEY_TOKEN, token);
    localStorage.setItem(STORAGE_KEY_REFRESH, refreshToken);
  } catch {}
  Preferences.set({ key: STORAGE_KEY_TOKEN, value: token }).catch(() => {});
  Preferences.set({ key: STORAGE_KEY_REFRESH, value: refreshToken }).catch(() => {});
}

export function clearTokens(): void {
  activeToken = null;
  activeRefreshToken = null;
  try {
    localStorage.removeItem(STORAGE_KEY_TOKEN);
    localStorage.removeItem(STORAGE_KEY_REFRESH);
    localStorage.removeItem(STORAGE_KEY_USER);
  } catch {}
  Preferences.remove({ key: STORAGE_KEY_TOKEN }).catch(() => {});
  Preferences.remove({ key: STORAGE_KEY_REFRESH }).catch(() => {});
  Preferences.remove({ key: STORAGE_KEY_USER }).catch(() => {});
}

export function getAccessToken(): string | null {
  return activeToken;
}

export function getRefreshToken(): string | null {
  return activeRefreshToken;
}

export function isTokenValid(): boolean {
  if (!activeToken) return false;
  const exp = parseJwtExp(activeToken);
  if (!exp) return false;
  // Consider invalid if expiring within 30 seconds
  return Date.now() < exp - 30000;
}

/**
 * Robust session initializer that synchronizes native SharedPreferences/UserDefaults
 * and auto-refreshes expired access tokens on cold app launch.
 */
export async function initSession(): Promise<boolean> {
  // 1. Sync from native Preferences first (survives app kill / process termination)
  try {
    const [tRes, rfRes] = await Promise.all([
      Preferences.get({ key: STORAGE_KEY_TOKEN }),
      Preferences.get({ key: STORAGE_KEY_REFRESH }),
    ]);
    if (tRes.value) {
      activeToken = tRes.value;
      try { localStorage.setItem(STORAGE_KEY_TOKEN, tRes.value); } catch {}
    }
    if (rfRes.value) {
      activeRefreshToken = rfRes.value;
      try { localStorage.setItem(STORAGE_KEY_REFRESH, rfRes.value); } catch {}
    }
  } catch (e) {
    console.warn('[ThingsBoard] Failed reading tokens from Preferences:', e);
  }

  // 2. Fallback to localStorage if native storage had no tokens
  if (!activeToken && !activeRefreshToken) {
    loadStoredTokens();
  }

  // 3. If no tokens exist at all, unauthenticated
  if (!activeToken && !activeRefreshToken) {
    return false;
  }

  // 4. If current access token is still valid (>30s remaining), session is good
  if (isTokenValid()) {
    return true;
  }

  // 5. If access token is expired, but refresh token exists, auto-refresh!
  if (activeRefreshToken) {
    try {
      const newToken = await refreshAccessToken();
      return Boolean(newToken);
    } catch (err: any) {
      console.warn('[ThingsBoard] Automatic token refresh failed during initSession:', err?.message || err);
      // Only a real 401 / expired refresh token ends the session.
      // Network or server hiccups keep the cached session so the user is not kicked out.
      if (err instanceof TBError && err.code === 'UNAUTHORIZED') {
        return false;
      }
      return true;
    }
  }

  return false;
}

let refreshPromise: Promise<string> | null = null;

export async function refreshAccessToken(): Promise<string> {
  if (refreshPromise) return refreshPromise;

  // The shared promise is cleared in .finally() of the OUTER promise. Clearing it inside the async
  // body was wrong: an early throw (no / expired refresh token) runs that finally synchronously,
  // BEFORE the assignment below, which then stored a rejected promise forever (later logins were
  // kicked out on the next token refresh).
  const run = (async () => {
    const rf = getRefreshToken();
    if (!rf) {
      clearTokens();
      throw new TBError('UNAUTHORIZED', 'ไม่มี Refresh Token');
    }

    const exp = parseJwtExp(rf);
    if (exp && Date.now() >= exp) {
      clearTokens();
      throw new TBError('UNAUTHORIZED', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    }

    try {
      const baseUrl = getBaseUrl();
      const res = await fetch(`${baseUrl}/api/auth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ refreshToken: rf }),
      });

      if (res.status === 401) {
        // Refresh token rejected by ThingsBoard (expired / revoked) -> real logout
        clearTokens();
        throw new TBError('UNAUTHORIZED', 'ไม่สามารถต่ออายุเซสชันได้ กรุณาเข้าสู่ระบบใหม่', res.status);
      }
      if (!res.ok) {
        // 5xx / proxy problems are transient: keep tokens, caller may retry later
        throw new TBError(res.status >= 500 ? 'SERVER_ERROR' : 'INVALID_DATA', 'ต่ออายุเซสชันไม่สำเร็จชั่วคราว', res.status);
      }

      const data = await res.json();
      if (!data.token) {
        clearTokens();
        throw new TBError('UNAUTHORIZED', 'โทเค็นใหม่ไม่ถูกต้อง');
      }

      const newToken = data.token;
      const newRf = data.refreshToken || rf;
      setTokens(newToken, newRf);
      return newToken;
    } catch (err: any) {
      // Network errors (offline, DNS, timeout) must NOT log the user out.
      if (err instanceof TBError) throw err;
      throw new TBError('OFFLINE', 'เชื่อมต่อระบบต่ออายุเซสชันล้มเหลว (เครือข่าย)');
    }
  })();

  const shared = run.finally(() => {
    if (refreshPromise === shared) refreshPromise = null;
  });
  refreshPromise = shared;
  return shared;
}

async function tbFetch<T>(
  endpoint: string,
  options: RequestInit = {},
  isRetry = false,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new TBError('OFFLINE', 'ไม่มีการเชื่อมต่ออินเทอร์เน็ต');
  }

  let token = getAccessToken();

  // If token is expiring or missing, attempt refresh if we have a refresh token
  if (!token || !isTokenValid()) {
    if (getRefreshToken()) {
      try {
        token = await refreshAccessToken();
      } catch {
        token = null;
      }
    }
  }

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  if (token && !headers['X-Authorization']) {
    headers['X-Authorization'] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.status === 401 && !isRetry) {
      // Automatic 1-time token refresh retry
      try {
        await refreshAccessToken();
      } catch (rfErr: any) {
        if (rfErr instanceof TBError && rfErr.code !== 'UNAUTHORIZED') {
          // Transient refresh failure: keep tokens, surface as connectivity error
          throw rfErr;
        }
        clearTokens();
        throw new TBError('UNAUTHORIZED', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
      }
      return await tbFetch<T>(endpoint, options, true, timeoutMs);
    }

    if (res.status === 401) {
      clearTokens();
      throw new TBError('UNAUTHORIZED', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
    }

    if (res.status === 408 || res.status === 504) {
      // ThingsBoard two-way RPC: device did not answer in time
      throw new TBError('TIMEOUT', 'อุปกรณ์ไม่ตอบสนองภายในเวลาที่กำหนด', res.status);
    }

    if (res.status === 403) {
      throw new TBError('FORBIDDEN', 'ไม่มีสิทธิ์เข้าถึงข้อมูลนี้', 403);
    }

    if (res.status === 404) {
      throw new TBError('NOT_FOUND', 'ไม่พบข้อมูลที่ระบุ', 404);
    }

    if (res.status >= 500) {
      throw new TBError('SERVER_ERROR', 'เซิร์ฟเวอร์ขัดข้อง กรุณาลองใหม่ภายหลัง', res.status);
    }

    if (!res.ok) {
      let errMsg = 'คำขอล้มเหลว';
      try {
        const errJson = await res.json();
        if (errJson.message) errMsg = errJson.message;
      } catch {}
      throw new TBError('INVALID_DATA', errMsg, res.status);
    }

    // Handle 204 No Content or empty bodies
    if (res.status === 204) {
      return {} as T;
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return (await res.json()) as T;
    }
    const textData = await res.text();
    return textData as unknown as T;
  } catch (err: any) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new TBError('TIMEOUT', `การเชื่อมต่อหมดเวลา (${timeoutMs / 1000} วินาที)`);
    }
    if (err instanceof TBError) {
      throw err;
    }
    throw new TBError('OFFLINE', (err && err.message) || 'การเชื่อมต่อล้มเหลว');
  }
}

/* ------------------------------------------------------------------ */
/* RPC helpers (Data Contract v3 §4)                                   */
/* ------------------------------------------------------------------ */

export type DeviceRpcMethod =
  | 'setPump'
  | 'setMode'
  | 'bind'
  | 'unbind'
  | 'enablePairing'
  | 'resetWifi'
  | 'reboot'
  | 'factoryReset'
  | 'calibratePh'
  | 'simSet';

/** Thai user-facing message for contract RPC error codes. */
export function describeRpcError(code: string | undefined | null): string {
  switch (code) {
    case 'AUTO_MODE_LOCKED':
      return 'อุปกรณ์อยู่ในโหมดอัตโนมัติ ปั๊มสารเคมีถูกล็อก กรุณาเปลี่ยนเป็นโหมดควบคุมเองก่อน';
    case 'TANK_EMPTY':
      return 'ถังน้ำหลักน้ำต่ำ อุปกรณ์ปฏิเสธการเปิดปั๊มหลักเพื่อป้องกันปั๊มเดินตัวเปล่า';
    case 'UNKNOWN_PUMP':
      return 'อุปกรณ์ไม่รู้จักปั๊มที่สั่ง (เฟิร์มแวร์อาจไม่ตรงรุ่นกับแอป)';
    case 'DEVICE_UNBOUND':
      return 'อุปกรณ์ยังไม่ได้ผูกกับบัญชี กรุณาผูกอุปกรณ์อีกครั้ง';
    case 'TIMEOUT':
      return 'อุปกรณ์ไม่ตอบสนองภายในเวลาที่กำหนด กรุณาตรวจสอบว่าอุปกรณ์ออนไลน์อยู่';
    case 'OFFLINE':
      return 'ไม่มีการเชื่อมต่ออินเทอร์เน็ต หรือเชื่อมต่อคลาวด์ไม่ได้';
    case 'UNAUTHORIZED':
      return 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่';
    case 'FORBIDDEN':
      return 'บัญชีนี้ไม่มีสิทธิ์สั่งงานอุปกรณ์นี้';
    case 'NOT_FOUND':
      return 'ไม่พบอุปกรณ์บนคลาวด์';
    case 'SERVER_ERROR':
      return 'คลาวด์ขัดข้องชั่วคราว กรุณาลองใหม่';
    case 'INVALID_RESPONSE':
      return 'อุปกรณ์ตอบกลับในรูปแบบที่ไม่ถูกต้อง';
    case 'INVALID_SECONDS':
      return 'ระยะเวลาเปิดปั๊มไม่ถูกต้อง';
    case 'PUMP_TIMER_FAIL':
      return 'อุปกรณ์ตั้งตัวจับเวลาปั๊มไม่สำเร็จ จึงไม่เปิดปั๊มเพื่อความปลอดภัย';
    case 'INVALID_MODE':
      return 'โหมดการทำงานไม่ถูกต้อง';
    case 'INVALID_POINT':
      return 'จุดคาลิเบรตต้องเป็น pH 7 หรือ pH 4 เท่านั้น';
    case 'PH_SIGNAL_INVALID':
      return 'สัญญาณหัววัด pH ไม่ถูกต้อง ตรวจสอบสายและจุ่มหัววัดในน้ำยาบัฟเฟอร์ก่อนคาลิเบรต';
    case 'CAL_SPAN_TOO_SMALL':
      return 'ค่าแรงดันระหว่าง pH 7 และ pH 4 ใกล้กันเกินไป ตรวจสอบน้ำยาบัฟเฟอร์และหัววัด';
    case 'NO_VALUE':
      return 'กรุณาใส่ค่าอย่างน้อย 1 ค่า';
    case 'METHOD_NOT_SUPPORTED':
      return 'เฟิร์มแวร์ของอุปกรณ์ไม่รองรับคำสั่งนี้ (กรุณาอัปเดตเฟิร์มแวร์)';
    default:
      return `อุปกรณ์ตอบกลับข้อผิดพลาด${code ? ` (${code})` : ''}`;
  }
}

/** Error raised when the device (or ThingsBoard) rejects / fails an RPC. `code` is the contract error code. */
export class DeviceRpcError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message || describeRpcError(code));
    this.name = 'DeviceRpcError';
    this.code = code;
  }
}

function parseJsonLoose(raw: any): any {
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Two-way RPC with the contract check: resolves only when the device answered
 * `{"success":true,...}`. `{"error":"CODE"}`, transport errors and malformed
 * bodies reject with DeviceRpcError (contract code + Thai message).
 */
export async function callDeviceRpc(
  deviceId: string,
  method: DeviceRpcMethod,
  params: Record<string, any> = {},
  timeoutMs = 10000
): Promise<Record<string, any>> {
  let raw: any;
  try {
    raw = await tbFetch<any>(
      `/api/rpc/twoway/${deviceId}`,
      {
        method: 'POST',
        body: JSON.stringify({ method, params, timeout: timeoutMs }),
      },
      false,
      timeoutMs + 3000
    );
  } catch (err: any) {
    if (err instanceof TBError) {
      throw new DeviceRpcError(err.code, describeRpcError(err.code));
    }
    throw new DeviceRpcError('UNKNOWN', describeRpcError(null));
  }
  const body = parseJsonLoose(raw);
  if (body && typeof body === 'object' && body.success === true) {
    return body;
  }
  const code = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : 'INVALID_RESPONSE';
  throw new DeviceRpcError(code);
}

export type AttributeScope = 'CLIENT_SCOPE' | 'SHARED_SCOPE' | 'SERVER_SCOPE';
export type TBAttribute = { key: string; value: any; lastUpdateTs: number };

/** Read attributes of one scope (CLIENT_SCOPE = reported by the device). */
export async function getScopedAttributes(
  deviceId: string,
  scope: AttributeScope,
  keys?: string[]
): Promise<TBAttribute[]> {
  const q = keys && keys.length > 0 ? `?keys=${encodeURIComponent(keys.join(','))}` : '';
  const res = await tbFetch<TBAttribute[]>(`/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes/${scope}${q}`);
  return Array.isArray(res) ? res : [];
}

/**
 * Poll the device client attribute `bound` (Contract v3 §2) every `intervalMs`
 * until it is `true` or `timeoutMs` elapses. Resolves `true` once bound.
 * Transient network errors are tolerated (keeps polling until timeout).
 * `deviceId` = ThingsBoard device UUID (the `deviceId` returned by claimBoardDevice).
 */
export async function waitForBoardBound(
  deviceId: string,
  timeoutMs = 60000,
  intervalMs = 2000,
  signal?: AbortSignal
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (signal?.aborted) return false;
    try {
      const attrs = await getScopedAttributes(deviceId, 'CLIENT_SCOPE', ['bound']);
      const bound = attrs.find((a) => a.key === 'bound');
      if (bound && (bound.value === true || bound.value === 'true')) return true;
    } catch {
      // transient: keep polling
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }
}

export const thingsboard = {
  /**
   * Log in to ThingsBoard Cloud EU using Email & Password.
   * Strictly enforces CUSTOMER_USER authority; rejects Tenant Admin.
   */
  async login(username: string, pass: string): Promise<{ token: string; user: TBUser }> {
    clearTokens();
    const baseUrl = getBaseUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          username: username.trim(),
          password: pass,
        }),
        signal: controller.signal,
      });
    } catch (netErr: any) {
      clearTimeout(timer);
      if (netErr.name === 'AbortError') throw new TBError('TIMEOUT', 'การเข้าสู่ระบบหมดเวลา');
      throw new TBError('OFFLINE', 'ไม่สามารถเชื่อมต่อ ThingsBoard Cloud ได้');
    }
    clearTimeout(timer);

    if (res.status === 401) {
      throw new TBError('UNAUTHORIZED', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    }
    if (!res.ok) {
      throw new TBError('INVALID_DATA', 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่', res.status);
    }

    const loginData = await res.json();
    if (!loginData.token) {
      throw new TBError('INVALID_DATA', 'ไม่ได้รับข้อมูลโทเค็นจากระบบ');
    }

    setTokens(loginData.token, loginData.refreshToken || '');

    // Verify User Authority
    let user: TBUser;
    try {
      user = await thingsboard.getCurrentUser();
    } catch (userErr: any) {
      clearTokens();
      throw userErr;
    }

    if (user.authority !== 'CUSTOMER_USER') {
      clearTokens();
      throw new TBError(
        'FORBIDDEN',
        'แอปพลิเคชันนี้สำหรับบัญชีลูกค้า (Customer User) เท่านั้น ไม่อนุญาตให้ผู้ดูแลระบบ (Tenant Admin) ใช้งาน'
      );
    }

    return { token: loginData.token, user };
  },

  /**
   * Fetch details of currently authenticated user.
   */
  async getCurrentUser(): Promise<TBUser> {
    return tbFetch<TBUser>('/api/auth/user');
  },

  /**
   * Log out and wipe all session credentials.
   */
  async logout(): Promise<void> {
    clearTokens();
  },

  /** Registers this phone's FCM token so ThingsBoard can push notifications to the signed-in user. */
  async saveMobileSession(fcmToken: string): Promise<void> {
    await tbFetch<unknown>('/api/user/mobile/session', {
      method: 'POST',
      headers: { 'X-Mobile-Token': fcmToken },
      body: JSON.stringify({ fcmTokenTimestamp: Date.now() }),
    });
  },

  /** Removes this phone's FCM token from the signed-in user (no more push after logout). */
  async removeMobileSession(fcmToken: string): Promise<void> {
    await tbFetch<unknown>('/api/user/mobile/session', {
      method: 'DELETE',
      headers: { 'X-Mobile-Token': fcmToken },
    });
  },

  /**
   * Initialize and restore session from native storage / refresh token.
   */
  initSession,
  setTokens,
  clearTokens,
  isTokenValid,
  getAccessToken,
  getRefreshToken,
  refreshAccessToken,

  /**
   * Retrieve devices owned by or assigned to this customer user.
   * Checks all standard ThingsBoard endpoints for both Customer Users and Tenant Admins.
   */
  async getCustomerDevices(pageSize = 50, page = 0): Promise<{ data: TBDevice[]; totalElements: number }> {
    let customerId: string | null = null;
    let isTenantAdmin = false;
    try {
      const user = await thingsboard.getCurrentUser();
      customerId = user.customerId?.id || null;
      isTenantAdmin = user.authority === 'TENANT_ADMIN' || user.authority === 'SYS_ADMIN';
    } catch (_) {}

    const endpoints: string[] = [
      // Devices this user may access (ThingsBoard PE RBAC). With per-user device groups this is
      // the only list that shows exactly "my devices"; the customer-wide lists are 400/403 for them.
      `/api/user/devices?pageSize=${pageSize}&page=${page}`,
      `/api/customer/deviceInfos?pageSize=${pageSize}&page=${page}`,
      `/api/customer/devices?pageSize=${pageSize}&page=${page}`,
    ];

    if (customerId) {
      endpoints.push(`/api/customer/${customerId}/deviceInfos?pageSize=${pageSize}&page=${page}`);
      endpoints.push(`/api/customer/${customerId}/devices?pageSize=${pageSize}&page=${page}`);
    }

    if (isTenantAdmin) {
      endpoints.push(`/api/tenant/deviceInfos?pageSize=${pageSize}&page=${page}`);
      endpoints.push(`/api/tenant/devices?pageSize=${pageSize}&page=${page}`);
    }

    // Per-user privacy model: /api/user/devices is authoritative even when empty
    // (the customer-wide lists answer 400/403 for these users, so don't fall through to them).
    try {
      const mine = await tbFetch<{ data: TBDevice[]; totalElements: number }>(endpoints[0]);
      if (mine && Array.isArray(mine.data) && (mine.data.length > 0 || !isTenantAdmin)) return mine;
    } catch (_) {}

    for (const ep of endpoints) {
      try {
        const res = await tbFetch<{ data: TBDevice[]; totalElements: number }>(ep);
        if (res && Array.isArray(res.data) && res.data.length > 0) {
          return res;
        }
      } catch (_) {}
    }

    // Fallback: return first endpoint that successfully returns an array (even if 0 items)
    for (const ep of endpoints) {
      try {
        const res = await tbFetch<{ data: TBDevice[]; totalElements: number }>(ep);
        if (res && Array.isArray(res.data)) {
          return res;
        }
      } catch (_) {}
    }

    return { data: [], totalElements: 0 };
  },

  /**
   * Claim an unassigned device using Device Name and Secure Claim Secret.
   * Uses ThingsBoard official claim endpoint: POST /api/customer/device/{deviceName}/claim
   */
  async claimDevice(
    deviceName: string,
    secretKey: string
  ): Promise<{ success: boolean; device?: TBDevice; response?: string }> {
    const raw = await tbFetch<any>(`/api/customer/device/${encodeURIComponent(deviceName.trim())}/claim`, {
      method: 'POST',
      body: JSON.stringify({
        secretKey: secretKey.trim(),
      }),
    });
    const res = parseJsonLoose(raw);
    // ThingsBoard ClaimResult: { device: Device, response: 'SUCCESS' | 'FAILURE' | 'CLAIMED' }
    if (res && typeof res === 'object') {
      const device: TBDevice | undefined = res.device && res.device.id ? res.device : undefined;
      if (res.response === 'SUCCESS' || device) {
        return { success: true, device, response: typeof res.response === 'string' ? res.response : undefined };
      }
      return { success: false, response: typeof res.response === 'string' ? res.response : undefined };
    }
    if (res === 'SUCCESS') return { success: true, response: 'SUCCESS' };
    return { success: false };
  },

  /**
   * Reclaim / unassign device from the current customer.
   * Uses ThingsBoard official endpoint: DELETE /api/customer/device/{deviceName}/claim
   */
  async reclaimDevice(deviceName: string): Promise<boolean> {
    try {
      await tbFetch(`/api/customer/device/${encodeURIComponent(deviceName.trim())}/claim`, {
        method: 'DELETE',
      });
      return true;
    } catch (e: any) {
      if (e.code === 'NOT_FOUND') return true; // Already unassigned
      throw e;
    }
  },

  /**
   * Fetch latest timeseries values for specified keys.
   */
  async getLatestTimeseries(deviceId: string, keys: string[]): Promise<TBLatestTelemetry> {
    const keysParam = encodeURIComponent(keys.join(','));
    return tbFetch<TBLatestTelemetry>(
      `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${keysParam}`
    );
  },

  /**
   * Fetch aggregated historical timeseries data for graphs.
   */
  async getHistoricalTimeseries(
    deviceId: string,
    keys: string[],
    startTs: number,
    endTs: number,
    intervalMs: number,
    agg: 'AVG' | 'MIN' | 'MAX' | 'SUM' | 'COUNT' | 'NONE' = 'AVG',
    timeoutMs = 20000,
    limit?: number
  ): Promise<TBLatestTelemetry> {
    const keysParam = encodeURIComponent(keys.join(','));
    const url = `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${keysParam}&startTs=${startTs}&endTs=${endTs}&interval=${intervalMs}&agg=${agg}${limit ? `&limit=${limit}&orderBy=ASC` : ''}`;
    return tbFetch<TBLatestTelemetry>(url, {}, false, timeoutMs);
  },

  // NOTE: deleteTimeseries was intentionally removed (Audit C7):
  // unbinding a device must keep the crop history on ThingsBoard.

  /** Read attributes of a single scope. */
  getScopedAttributes,

  /**
   * Read client and shared attributes of a device (all scopes merged).
   */
  async getAttributes(deviceId: string): Promise<Array<{ key: string; value: any; lastUpdateTs: number }>> {
    return tbFetch<Array<{ key: string; value: any; lastUpdateTs: number }>>(
      `/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes`
    );
  },

  /**
   * true only when ThingsBoard reports the device connected (`active`) and it was heard from
   * within the last 150 s. Used to decide "claim directly" vs "set up Wi-Fi over Bluetooth".
   */
  async isDeviceOnline(deviceId: string): Promise<boolean> {
    const attrs = await this.getAttributes(deviceId);
    const get = (k: string) => attrs.find((a) => a.key === k)?.value;
    if (get('active') !== true) return false;
    const last = Number(get('lastActivityTime'));
    return Number.isFinite(last) && last > 0 ? Date.now() - last < 150000 : true;
  },

  /**
   * Write target shared attributes to device in SHARED_SCOPE.
   */
  /** Server-side attributes: stored in ThingsBoard only, never pushed to the device. */
  async saveServerAttributes(deviceId: string, attributes: Record<string, any>): Promise<void> {
    await tbFetch(`/api/plugins/telemetry/DEVICE/${deviceId}/SERVER_SCOPE`, {
      method: 'POST',
      body: JSON.stringify(attributes),
    });
  },

  async saveSharedAttributes(deviceId: string, attributes: Record<string, any>): Promise<void> {
    await tbFetch(`/api/plugins/telemetry/DEVICE/${deviceId}/SHARED_SCOPE`, {
      method: 'POST',
      body: JSON.stringify(attributes),
    });
  },

  /** Contract-checked RPC (resolves only on `success===true`). */
  callDeviceRpc,
  /** Poll client attribute `bound===true`. */
  waitForBoardBound,

  /**
   * Raw two-way RPC without the success check. Prefer `callDeviceRpc`.
   */
  async sendRpcTwoWay(
    deviceId: string,
    method: 'setPump' | 'setMode' | 'reboot' | 'factoryReset' | 'enablePairing' | string,
    params: any,
    timeoutMs = 10000
  ): Promise<any> {
    return tbFetch<any>(
      `/api/rpc/twoway/${deviceId}`,
      {
        method: 'POST',
        body: JSON.stringify({
          method,
          params: params !== undefined ? params : {},
          timeout: timeoutMs,
        }),
      },
      false,
      timeoutMs + 3000
    );
  },

  /**
   * Retrieve active and historical alarms for the device.
   */
  async getDeviceAlarms(deviceId: string, pageSize = 30, page = 0): Promise<{ data: TBAlarm[]; totalElements: number }> {
    try {
      const res = await tbFetch<{ data: TBAlarm[]; totalElements: number }>(
        `/api/alarm/DEVICE/${deviceId}?pageSize=${pageSize}&page=${page}&sortProperty=createdTime&sortOrder=DESC`
      );
      if (res && Array.isArray(res.data)) {
        return res;
      }
      return { data: [], totalElements: 0 };
    } catch (e: any) {
      if (e.code === 'FORBIDDEN' || e.code === 'NOT_FOUND') {
        return { data: [], totalElements: 0 };
      }
      throw e;
    }
  },
};
