/**
 * DEMO APP ONLY (vite --mode demo): replaces src/services/thingsboard.ts at build time
 * (see demoBuild() in vite.config.ts).
 *
 * The instructor demo app talks to the REAL ThingsBoard Cloud with the owner's account that has the
 * CYD display test board bound, so the instructor sees (and changes) the same data as the owner's app:
 *   - signs in automatically with VITE_DEMO_EMAIL / VITE_DEMO_PASSWORD (from .env.demo.local, git-ignored)
 *   - the account is locked: logging out just signs straight back in, other e-mails are ignored
 *   - only the demo board (VITE_DEMO_DEVICE_NAME, default FARM-TEST01) is shown, so real farm boards
 *     on the same account can never be controlled from the demo app
 *   - actions that would change the board's ownership or Wi-Fi are blocked
 *     (unbind / remove / factory reset / reset Wi-Fi / pairing / pH calibration / claim new board)
 */
import * as real from '../services/thingsboard';
import type { DeviceRpcMethod, TBDevice, TBUser } from '../services/thingsboard';

export * from '../services/thingsboard';

const DEMO_EMAIL = String(import.meta.env.VITE_DEMO_EMAIL || '').trim();
const DEMO_PASSWORD = String(import.meta.env.VITE_DEMO_PASSWORD || '');
const DEMO_DEVICE_NAME = String(import.meta.env.VITE_DEMO_DEVICE_NAME || 'FARM-TEST01').trim().toUpperCase();

const BLOCKED_RPC = new Set<string>(['unbind', 'bind', 'factoryReset', 'resetWifi', 'enablePairing', 'calibratePh']);
const BLOCKED_MESSAGE = 'แอปเดโมสำหรับอาจารย์: คำสั่งนี้ถูกล็อกไว้ (ใช้ได้ในแอปจริงของเจ้าของเท่านั้น)';

function blocked(): never {
  throw new real.TBError('FORBIDDEN', BLOCKED_MESSAGE, 403);
}

async function demoLogin(): Promise<{ token: string; user: TBUser }> {
  if (!DEMO_EMAIL || !DEMO_PASSWORD) {
    throw new real.TBError('INVALID_DATA', 'แอปเดโมยังไม่ได้ตั้งค่าบัญชี (VITE_DEMO_EMAIL / VITE_DEMO_PASSWORD)');
  }
  return real.thingsboard.login(DEMO_EMAIL, DEMO_PASSWORD);
}

/** Restores the session, or signs in with the demo account (no login screen for the instructor). */
export async function initSession(): Promise<boolean> {
  if (await real.initSession()) {
    try {
      const u = await real.thingsboard.getCurrentUser();
      if (u.email.toLowerCase() === DEMO_EMAIL.toLowerCase()) return true;
    } catch (err) {
      if (!(err instanceof real.TBError && err.code === 'UNAUTHORIZED')) return true; // offline: keep session
    }
  }
  try {
    await demoLogin();
    return true;
  } catch (err) {
    console.warn('[Demo] auto sign-in failed:', err);
    return false;
  }
}

export async function callDeviceRpc(
  deviceId: string,
  method: DeviceRpcMethod,
  params: Record<string, any> = {},
  timeoutMs = 10000
): Promise<Record<string, any>> {
  if (BLOCKED_RPC.has(method)) throw new real.DeviceRpcError('FORBIDDEN', BLOCKED_MESSAGE);
  return real.callDeviceRpc(deviceId, method, params, timeoutMs);
}

const isDemoDevice = (d: TBDevice) => (d.name || '').trim().toUpperCase() === DEMO_DEVICE_NAME;

export const thingsboard = {
  ...real.thingsboard,

  initSession,
  callDeviceRpc,

  /** Locked to the demo account: whatever is typed, the demo account is used. */
  async login(_username: string, _pass: string): Promise<{ token: string; user: TBUser }> {
    return demoLogin();
  },

  /** Locked: "log out" signs straight back in to the demo account. */
  async logout(): Promise<void> {
    setTimeout(() => window.location.reload(), 300);
  },

  /** Push for the owner's account must not go to the instructor's phone. */
  async saveMobileSession(_fcmToken: string): Promise<void> {},
  async removeMobileSession(_fcmToken: string): Promise<void> {},

  async getCustomerDevices(pageSize = 50, page = 0): Promise<{ data: TBDevice[]; totalElements: number }> {
    const res = await real.thingsboard.getCustomerDevices(pageSize, page);
    const data = (res.data || []).filter(isDemoDevice);
    return { data, totalElements: data.length };
  },

  async claimDevice(): Promise<{ success: boolean; device?: TBDevice; response?: string }> {
    return blocked();
  },

  async reclaimDevice(): Promise<boolean> {
    return blocked();
  },

  async saveSharedAttributes(deviceId: string, attributes: Record<string, any>): Promise<void> {
    if ('bind_owner' in attributes) blocked();
    return real.thingsboard.saveSharedAttributes(deviceId, attributes);
  },

  async sendRpcTwoWay(deviceId: string, method: string, params: any, timeoutMs = 10000): Promise<any> {
    if (BLOCKED_RPC.has(method)) blocked();
    return real.thingsboard.sendRpcTwoWay(deviceId, method, params, timeoutMs);
  },
};
