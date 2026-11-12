const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

// Set NODE_ENV to test before requiring app
process.env.NODE_ENV = 'test';
process.env.JOB_SECRET = 'super-secret-cron-key-12345';
process.env.MAX_PUMP_SECONDS = '10';

const app = require('../index.js');

// Mock in-memory Firebase database
class MockFirebaseDb {
  constructor() {
    this.store = {};
  }

  clear() {
    this.store = {};
  }

  ref(path) {
    const cleanPath = path.replace(/^\/|\/$/g, '');
    const self = this;
    return {
      once: async (event) => {
        const val = self._get(cleanPath);
        return {
          val: () => val,
          exists: () => val !== undefined && val !== null
        };
      },
      set: async (val) => {
        self._set(cleanPath, val);
      },
      update: async (updates) => {
        const current = self._get(cleanPath) || {};
        if (typeof updates === 'object' && updates !== null) {
          self._set(cleanPath, { ...current, ...updates });
        }
      },
      remove: async () => {
        self._delete(cleanPath);
      },
      transaction: async (fn) => {
        const current = self._get(cleanPath);
        const next = fn(current);
        if (next !== undefined) {
          self._set(cleanPath, next);
          return { committed: true, snapshot: { val: () => next } };
        }
        return { committed: false, snapshot: { val: () => current } };
      }
    };
  }

  _get(path) {
    const parts = path.split('/');
    let cur = this.store;
    for (const p of parts) {
      if (cur === undefined || cur === null) return null;
      cur = cur[p];
    }
    return cur !== undefined ? cur : null;
  }

  _set(path, val) {
    const parts = path.split('/');
    let cur = this.store;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!cur[p] || typeof cur[p] !== 'object') {
        cur[p] = {};
      }
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = val;
  }

  _delete(path) {
    const parts = path.split('/');
    let cur = this.store;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur || !cur[parts[i]]) return;
      cur = cur[parts[i]];
    }
    if (cur) {
      delete cur[parts[parts.length - 1]];
    }
  }
}

// Mock Firebase Auth
const mockAuth = {
  verifyIdToken: async (token) => {
    if (token === 'token_user_a') {
      return { uid: 'user_a', email: 'user_a@test.com' };
    }
    if (token === 'token_user_b') {
      return { uid: 'user_b', email: 'user_b@test.com' };
    }
    throw new Error('Invalid Firebase Token');
  }
};

describe('Server BOLA & Security Verification (Section 0.4)', () => {
  let mockDb;

  before(() => {
    mockDb = new MockFirebaseDb();
    app.__setTestDb(mockDb);
    app.__setTestAuth(mockAuth);
  });

  beforeEach(() => {
    mockDb.clear();
    // Seed devices and ownership
    // FARM-A owned by user_a
    mockDb.ref('devices/FARM-A').set({
      ownerUid: 'user_a',
      status: 'claimed',
      tbDeviceId: 'tb-farm-a-id'
    });
    mockDb.ref('users/user_a/devices/FARM-A').set(true);

    // FARM-B owned by user_b
    mockDb.ref('devices/FARM-B').set({
      ownerUid: 'user_b',
      status: 'claimed',
      tbDeviceId: 'tb-farm-b-id'
    });
    mockDb.ref('users/user_b/devices/FARM-B').set(true);

    // Mock ThingsBoard client calls
    app.__setTestTb(async (method, path, { params, data } = {}) => {
      if (path.includes('/api/tenant/devices')) {
        if (params && params.deviceName === 'FARM-A') {
          return { id: { id: 'tb-farm-a-id' } };
        }
        const notFoundErr = new Error('Device not found');
        notFoundErr.response = { status: 404, data: { message: 'Device not found' } };
        throw notFoundErr;
      }
      if (path.includes('/values/attributes')) {
        return [
          { key: 'claimCode', value: 'VALIDCLAIM123' },
          { key: 'pairing', value: true, lastUpdateTs: Date.now() },
          { key: 'active', value: true }
        ];
      }
      return { success: true };
    });
  });

  // 1. ไม่แนบ token ได้ 401
  it('1. Returns 401 when Authorization token is missing', async () => {
    const res = await request(app)
      .post('/api/command/FARM-A')
      .send({ method: 'setPump', params: { pump: 'main', seconds: 5 } });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'ไม่พบ token การล็อกอิน');
  });

  // 2. token ของผู้ใช้อื่นได้ 403 (BOLA Protection)
  it('2. Returns 403 when User B tries to control User A device (BOLA prevention)', async () => {
    const res = await request(app)
      .post('/api/command/FARM-A')
      .set('Authorization', 'Bearer token_user_b')
      .send({ method: 'setPump', params: { pump: 'main', seconds: 5 } });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error, 'คุณไม่ใช่เจ้าของอุปกรณ์นี้');
  });

  it('2.1 Returns 403 when User B tries to get telemetry of User A device', async () => {
    const res = await request(app)
      .get('/api/telemetry/FARM-A')
      .set('Authorization', 'Bearer token_user_b');

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error, 'คุณไม่ใช่เจ้าของอุปกรณ์นี้');
  });

  it('2.2 Returns 403 when User B tries to export CSV of User A device', async () => {
    const res = await request(app)
      .get('/api/export/FARM-A')
      .set('Authorization', 'Bearer token_user_b');

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error, 'คุณไม่ใช่เจ้าของอุปกรณ์นี้');
  });

  // 3. ชื่ออุปกรณ์รูปแบบผิดได้ 400
  it('3. Returns 400 when deviceName has invalid format or characters', async () => {
    const res = await request(app)
      .post('/api/command/F@RM!_INVALID')
      .set('Authorization', 'Bearer token_user_a')
      .send({ method: 'setPump', params: { pump: 'main', seconds: 5 } });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'ชื่ออุปกรณ์ไม่ถูกต้อง');
  });

  // 4. คำสั่งนอกรายการได้ 400
  it('4. Returns 400 when RPC method is not in allowed list', async () => {
    const res = await request(app)
      .post('/api/command/FARM-A')
      .set('Authorization', 'Bearer token_user_a')
      .send({ method: 'hackServer', params: {} });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'คำสั่งหรือค่าที่ส่งไม่ถูกต้อง');
  });

  it('4.1 Returns 400 when pump seconds exceeds MAX_PUMP_SECONDS (10s)', async () => {
    const res = await request(app)
      .post('/api/command/FARM-A')
      .set('Authorization', 'Bearer token_user_a')
      .send({ method: 'setPump', params: { pump: 'main', seconds: 999 } });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'คำสั่งหรือค่าที่ส่งไม่ถูกต้อง');
  });

  // 5. ค่าเป้าหมายนอกเพดานได้ 400
  it('5. Returns 400 when target pH is outside SAFE_LIMITS (4.5 - 7.5)', async () => {
    const res = await request(app)
      .post('/api/command/FARM-A')
      .set('Authorization', 'Bearer token_user_a')
      .send({ sharedAttributes: { ph_min: 2.0, ph_max: 6.5 } });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /ph_min ต้องอยู่ระหว่าง 4.5 ถึง 7.5/);
  });

  it('5.1 Returns 400 when min target is greater than or equal to max target', async () => {
    const res = await request(app)
      .post('/api/command/FARM-A')
      .set('Authorization', 'Bearer token_user_a')
      .send({ sharedAttributes: { ph_min: 6.5, ph_max: 5.5 } });

    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /ph_min ต้องน้อยกว่า ph_max/);
  });

  // 6. ผูกอุปกรณ์ด้วยรหัสผิด ได้ข้อความเดียวกับไม่พบอุปกรณ์
  it('6. Returns identical 400 message for wrong code and non-existent device', async () => {
    // 6a: Wrong code on existing device
    const resWrongCode = await request(app)
      .post('/api/bind-device')
      .set('Authorization', 'Bearer token_user_a')
      .send({ deviceName: 'FARM-A', claimCode: 'WRONGCODE999' });

    assert.strictEqual(resWrongCode.status, 400);
    assert.strictEqual(resWrongCode.body.error, 'รหัสไม่ถูกต้อง');

    // 6b: Non-existent device
    const resNotFound = await request(app)
      .post('/api/bind-device')
      .set('Authorization', 'Bearer token_user_a')
      .send({ deviceName: 'FARM-UNKNOWN-999', claimCode: 'ANYCODE123456' });

    assert.strictEqual(resNotFound.status, 400);
    assert.strictEqual(resNotFound.body.error, 'รหัสไม่ถูกต้อง');

    // Response must be strictly identical to prevent enumeration
    assert.deepStrictEqual(resWrongCode.body, resNotFound.body);
  });

  // 7. ลองผูกเกิน 5 ครั้งใน 10 นาที ได้ 429
  it('7. Returns 429 when bind attempts exceed 5 times in 10 minutes', async () => {
    // Simulate 5 attempts already recorded in rateLimits/bind/user_a
    mockDb.ref('rateLimits/bind/user_a').set({
      start: Date.now(),
      count: 5
    });

    const res = await request(app)
      .post('/api/bind-device')
      .set('Authorization', 'Bearer token_user_a')
      .send({ deviceName: 'FARM-A', claimCode: 'VALIDCLAIM123' });

    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.body.error, 'ลองหลายครั้งเกินไป กรุณารอสักครู่');
  });

  // 8. เรียก /api/cron โดยไม่มี X-Job-Secret ได้ 401
  it('8. Returns 401 when calling /api/cron without X-Job-Secret header', async () => {
    const res = await request(app)
      .get('/api/cron');

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'unauthorized');
  });

  it('8.1 Returns 401 when calling /api/cron with incorrect X-Job-Secret header', async () => {
    const res = await request(app)
      .get('/api/cron')
      .set('x-job-secret', 'wrong-secret');

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, 'unauthorized');
  });

  it('8.2 Returns 200 when calling /api/cron with valid X-Job-Secret header', async () => {
    const res = await request(app)
      .get('/api/cron')
      .set('x-job-secret', 'super-secret-cron-key-12345');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'awake');
  });

  // Positive verification: Legitimate owner succeeds
  it('9. Allows legitimate owner User A to send valid command', async () => {
    const res = await request(app)
      .post('/api/command/FARM-A')
      .set('Authorization', 'Bearer token_user_a')
      .send({ method: 'setPump', params: { pump: 'main', seconds: 5 } });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
  });
});
