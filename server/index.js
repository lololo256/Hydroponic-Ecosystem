require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
let axiosClient = axios;
const crypto = require('crypto');
const admin = require('firebase-admin');

// ==========================================
// 0. ค่าคงที่และการตั้งค่า (ค่าลับทั้งหมดอ่านจาก Environment ของ Render)
// ==========================================
const PORT = process.env.PORT || 3000;
const TB_URL = (process.env.THINGSBOARD_URL || 'https://eu.thingsboard.cloud').replace(/\/$/, '');
let TB_USERNAME = process.env.THINGSBOARD_USERNAME;
// Auto-correct common typo if '@' was typed as 'm' before gmail.com
if (TB_USERNAME && TB_USERNAME.includes('mgmail.com') && !TB_USERNAME.includes('@')) {
  TB_USERNAME = TB_USERNAME.replace('mgmail.com', '@gmail.com');
}
const TB_PASSWORD = process.env.THINGSBOARD_PASSWORD;
const JOB_SECRET = process.env.JOB_SECRET; // รหัสลับสำหรับ cron-job.org
const MAX_PUMP_SECONDS = Number(process.env.MAX_PUMP_SECONDS || 10);
const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT || 3);
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const PAIRING_WINDOW_MS = 10 * 60 * 1000; // อุปกรณ์ต้องอยู่ในโหมดจับคู่ไม่เกิน 10 นาที
const BIND_MAX_ATTEMPTS = 5; // ลองผูกได้กี่ครั้ง
const BIND_WINDOW_MS = 10 * 60 * 1000; // ในกี่นาที

// เพดานความปลอดภัยของค่าเป้าหมาย (แก้ที่เดียวตรงนี้)
const SAFE_LIMITS = { ph: [4.5, 7.5], ec: [0.5, 3.5], temp: [15, 35] };
// ชื่อคีย์ telemetry ที่อุปกรณ์ส่งขึ้น ThingsBoard (ต้องตรงกับเฟิร์มแวร์)
const ALLOWED_KEYS = [
  'ph', 'ec', 'tds', 'temp',
  'tank_main', 'tank_a', 'tank_b', 'tank_ph_down', 'tank_ph_up',
  'pump_main', 'pump_a', 'pump_b', 'pump_ph_up', 'pump_ph_down',
  'mode'
];
const PUMPS = ['main', 'A', 'B', 'phUp', 'phDown'];

// ตรวจค่าที่จำเป็นก่อนเริ่ม ถ้าขาดให้เตือน
const missing = ['FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_DATABASE_URL', 'THINGSBOARD_USERNAME', 'THINGSBOARD_PASSWORD', 'JOB_SECRET']
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.warn('หมายเหตุ: ยังไม่ได้ตั้งค่า Environment Variable บางตัว:', missing.join(', '));
}

// ==========================================
// 1. Firebase Admin
// ==========================================
let serviceAccount = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (_) {}
}
if (!serviceAccount) {
  try {
    const fs = require('fs');
    const path = require('path');
    const keyPath = path.join(__dirname, 'serviceAccountKey.json');
    if (fs.existsSync(keyPath)) {
      serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    }
  } catch (_) {}
}

const fbDbUrl = process.env.FIREBASE_DATABASE_URL || 'https://smart-water-farm-default-rtdb.asia-southeast1.firebasedatabase.app';

if (serviceAccount && fbDbUrl && !admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: fbDbUrl
    });
  } catch (e) {
    console.error('Firebase init error:', e.message);
  }
}
let db = admin.apps.length ? admin.database() : null;

// ==========================================
// 2. Express + ความปลอดภัยพื้นฐาน
// ==========================================
const app = express();
app.set('trust proxy', 1);
app.use(helmet());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'capacitor://localhost,http://localhost,https://localhost')
  .split(',')
  .map((s) => s.trim());
app.use(
  cors({
    origin: (origin, cb) => {
      if (
        !origin ||
        allowedOrigins.includes('*') ||
        allowedOrigins.includes(origin) ||
        origin.startsWith('http://localhost') ||
        origin.startsWith('http://127.0.0.1') ||
        origin === 'capacitor://localhost' ||
        origin === 'https://localhost'
      ) {
        return cb(null, true);
      }
      return cb(new Error('CORS_BLOCKED'));
    }
  })
);
app.use(express.json({ limit: '20kb' }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false }));

// ==========================================
// 3. ฟังก์ชันช่วย
// ==========================================
function fail(res, err, message, status = 500) {
  console.error(message, err.response?.status, err.response?.data || err.message);
  return res.status(status).json({ error: message });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function thaiHourKey(ts) {
  return new Date(ts + 7 * 3600 * 1000).toISOString().slice(0, 13).replace(/[-T]/g, '');
}

function toThaiIso(ts) {
  return new Date(ts + 7 * 3600 * 1000).toISOString().replace('Z', '+07:00');
}

async function consumeAttempt(path, max, windowMs) {
  if (!db) return true;
  let allowed = true;
  await db.ref(path).transaction((cur) => {
    allowed = true;
    const now = Date.now();
    if (!cur || now - cur.start > windowMs) return { start: now, count: 1 };
    if (cur.count >= max) {
      allowed = false;
      return;
    }
    return { start: cur.start, count: cur.count + 1 };
  });
  return allowed;
}

// ==========================================
// 4. ThingsBoard client
// ==========================================
let tbJwt = null;
let tbJwtExpireAt = 0;

async function tbHeaders(force = false) {
  if (!force && tbJwt && Date.now() < tbJwtExpireAt) {
    return { 'X-Authorization': `Bearer ${tbJwt}` };
  }
  const r = await axios.post(
    `${TB_URL}/api/auth/login`,
    { username: TB_USERNAME, password: TB_PASSWORD },
    { timeout: 15000 }
  );
  tbJwt = r.data.token;
  tbJwtExpireAt = Date.now() + 45 * 60 * 1000;
  return { 'X-Authorization': `Bearer ${tbJwt}` };
}

async function tb(method, path, { params, data } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = await tbHeaders(attempt > 0);
    try {
      const r = await axios({ method, url: `${TB_URL}${path}`, headers, params, data, timeout: 20000 });
      return r.data;
    } catch (err) {
      if (err.response?.status === 401 && attempt === 0) continue;
      throw err;
    }
  }
}

let tbClient = tb;

async function readTbAttributes(tbDeviceId, keys) {
  const attrs = await tbClient('get', `/api/plugins/telemetry/DEVICE/${tbDeviceId}/values/attributes`, {
    params: { keys }
  });
  return Array.isArray(attrs) ? attrs : [];
}

// ==========================================
// 5. Middleware
// ==========================================
let testAuth = null;

async function verifyFirebaseUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'ไม่พบ token การล็อกอิน' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    if (testAuth) {
      req.user = await testAuth.verifyIdToken(token);
    } else {
      req.user = await admin.auth().verifyIdToken(token);
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'token ไม่ถูกต้องหรือหมดอายุ' });
  }
}

async function requireOwner(req, res, next) {
  const name = req.params.deviceName;
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(name || '')) {
    return res.status(400).json({ error: 'ชื่ออุปกรณ์ไม่ถูกต้อง' });
  }
  try {
    if (!db) return res.status(503).json({ error: 'ฐานข้อมูลไม่พร้อมใช้งาน' });
    const snap = await db.ref(`devices/${name}`).once('value');
    const d = snap.val() || {};
    
    // ตรวจสอบสิทธิ์ความเป็นเจ้าของอุปกรณ์อย่างเข้มงวด (ป้องกัน BOLA - Broken Object Level Authorization)
    const userDevSnap = await db.ref(`users/${req.user.uid}/devices/${name}`).once('value');
    const userSavedSnap = await db.ref(`users/${req.user.uid}/savedBoards/${name}`).once('value');
    const boardSnap = await db.ref(`boards/${name}/ownerUid`).once('value');
    const boardOwnerUid = boardSnap.val();

    const isOwner = Boolean(
      (d.ownerUid && d.ownerUid === req.user.uid) ||
      (userDevSnap.exists() && userDevSnap.val() === true) ||
      (userSavedSnap.exists() && userSavedSnap.val() !== null) ||
      (boardOwnerUid && boardOwnerUid === req.user.uid)
    );
    
    if (!isOwner) {
      return res.status(403).json({ error: 'คุณไม่ใช่เจ้าของอุปกรณ์นี้' });
    }
    
    let tbDeviceId = d.tbDeviceId;
    if (!tbDeviceId || tbDeviceId === name) {
      try {
        const tbDev = await tbClient('get', '/api/tenant/devices', { params: { deviceName: name } });
        if (tbDev && tbDev.id && tbDev.id.id) {
          tbDeviceId = tbDev.id.id;
          await db.ref(`devices/${name}/tbDeviceId`).set(tbDeviceId);
        }
      } catch (e) {
        tbDeviceId = name;
      }
    }
    
    req.device = { name, tbDeviceId: tbDeviceId || name };
    next();
  } catch (err) {
    return fail(res, err, 'ตรวจสิทธิ์ไม่สำเร็จ');
  }
}

function requireJobSecret(req, res, next) {
  const given = req.headers['x-job-secret'] || '';
  if (!safeEqual(given, JOB_SECRET)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ==========================================
// 5.5 ระบบแจ้งเตือนอัจฉริยะแบบ Real-Time Push (FCM & Quiet Hours)
// ==========================================
const pushCooldownMap = new Map();
let testMessaging = null;

function getMessaging() {
  if (testMessaging) return testMessaging;
  if (admin.apps.length && typeof admin.messaging === 'function') {
    return admin.messaging();
  }
  return null;
}

async function sendPushToBoardOwners(boardName, { title, body, level = 'warning', key = 'general' }) {
  const msgClient = getMessaging();
  if (!db || !msgClient) return;

  const now = Date.now();
  const cooldownKey = `${boardName}_${key}`;
  const lastSent = pushCooldownMap.get(cooldownKey) || 0;
  // ป้องกันการสแปมแจ้งเตือน: เว้นช่วง 15 นาทีสำหรับประเด็นเดิม
  if (now - lastSent < 15 * 60 * 1000) {
    return;
  }

  // เคารพช่วงเวลานอน (Quiet Hours 22:00 - 06:00 น. ตามเวลาท้องถิ่นประเทศไทย UTC+7)
  const localHour = (new Date(now + 7 * 3600 * 1000)).getUTCHours();
  const isQuietHour = localHour >= 22 || localHour < 6;
  if (isQuietHour && level !== 'critical') {
    // ช่วงเวลานอน ส่งเฉพาะเรื่องวิกฤตความปลอดภัย (Critical / P0) เช่น บอร์ดดับ, น้ำแห้ง
    return;
  }

  try {
    const tokens = new Set();

    // 1. ดึงจาก boards/${boardName}/fcmTokens
    const boardTokensSnap = await db.ref(`boards/${boardName}/fcmTokens`).once('value');
    if (boardTokensSnap.exists()) {
      const bTokens = boardTokensSnap.val();
      if (bTokens && typeof bTokens === 'object') {
        Object.values(bTokens).forEach((t) => {
          if (typeof t === 'string' && t.length > 20) tokens.add(t);
        });
      }
    }

    // 2. ดึงจากเจ้าของบอร์ด boards/${boardName}/ownerUid -> users/${ownerUid}/fcmToken
    const ownerSnap = await db.ref(`boards/${boardName}/ownerUid`).once('value');
    const ownerUid = ownerSnap.val();
    if (ownerUid) {
      const userTokenSnap = await db.ref(`users/${ownerUid}/fcmToken`).once('value');
      const uToken = userTokenSnap.val();
      if (typeof uToken === 'string' && uToken.length > 20) tokens.add(uToken);
    }

    if (tokens.size === 0) return;

    // 3. ส่ง Push Notification ไปยังทุกเครื่องที่เกี่ยวข้อง
    const messagePromises = Array.from(tokens).map((token) => {
      const payload = {
        token,
        notification: {
          title,
          body,
        },
        data: {
          boardId: String(boardName),
          level: String(level),
          timestamp: String(now),
        },
        android: {
          priority: level === 'critical' ? 'high' : 'normal',
          notification: {
            channelId: level === 'critical' ? 'smartfarm_critical' : 'smartfarm_general',
            sound: 'default',
            priority: level === 'critical' ? 'max' : 'default',
            defaultVibrateTimings: true,
          },
        },
      };

      return msgClient.send(payload).catch((err) => {
        if (
          err.code === 'messaging/invalid-registration-token' ||
          err.code === 'messaging/registration-token-not-registered'
        ) {
          console.warn(`Removing stale FCM token for board ${boardName}`);
        } else {
          console.warn('FCM send warning:', err.message);
        }
      });
    });

    await Promise.all(messagePromises);
    pushCooldownMap.set(cooldownKey, now);
  } catch (err) {
    console.warn('sendPushToBoardOwners error:', err.message);
  }
}

// ==========================================
// 6. Health check และงานตั้งเวลา
// ==========================================
app.get('/', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Realtime sync from ThingsBoard to Firebase RTDB every 6 seconds
async function syncTelemetryToFirebase() {
  if (!db) return;
  try {
    const snap = await db.ref('devices').once('value');
    const bSnap = await db.ref('boards').once('value');
    const boardsData = bSnap.val() || {};
    const devicesData = snap.val() || {};
    const devices = { ...boardsData, ...devicesData };
    for (const [name, d] of Object.entries(devices)) {
      const fbBoard = boardsData[name] || {};
      const fbCurrent = fbBoard.current || {};
      const fbDev = fbBoard.device || {};
      const fbUpdatedTs = Number(fbCurrent.updatedAt || fbDev.lastSeen || 0);
      const now = Date.now();
      const isFbFresh = fbUpdatedTs > 1700000000000 && (now - fbUpdatedTs <= 50000);
      const isFbDirectOnline = Boolean(fbDev.esp32Connected === true && fbDev.wifiConnected !== false && isFbFresh);

      let tbId = d.tbDeviceId;
      if (!tbId || tbId === name) {
        try {
          const tbDev = await tbClient('get', '/api/tenant/devices', { params: { deviceName: name } });
          if (tbDev?.id?.id) {
            tbId = tbDev.id.id;
            await db.ref(`devices/${name}/tbDeviceId`).set(tbId);
          }
        } catch (e) {}
      }
      if (!tbId) {
        if (isFbDirectOnline) {
          await db.ref(`devices/${name}/status`).set('online');
        }
        continue;
      }

      try {
        const queryKeys = 'ph,ec,tds,temp,tank_main,tank_a,tank_b,tank_ph_down,tank_ph_up,pump_main,pump_a,pump_b,pump_ph_up,pump_ph_down,mode';
        const tbData = await tbClient('get', `/api/plugins/telemetry/DEVICE/${tbId}/values/timeseries`, {
          params: { keys: queryKeys, limit: 1 }
        });
        if (tbData) {
          // ตรวจสอบ Timestamp ล่าสุดจริงจากข้อมูลที่ได้รับจาก ThingsBoard เพื่อป้องกัน Zombie Online
          let latestTs = 0;
          for (const pts of Object.values(tbData)) {
            if (pts && pts[0] && pts[0].ts) {
              latestTs = Math.max(latestTs, Number(pts[0].ts));
            }
          }

          const ph = tbData.ph?.[0]?.value !== undefined ? Number(tbData.ph[0].value) : null;
          const ec = tbData.ec?.[0]?.value !== undefined ? Number(tbData.ec[0].value) : null;
          const tds = tbData.tds?.[0]?.value !== undefined ? Number(tbData.tds[0].value) : null;
          const temp = tbData.temp?.[0]?.value !== undefined ? Number(tbData.temp[0].value) : null;
          const tankMain = tbData.tank_main?.[0]?.value !== undefined ? Number(tbData.tank_main[0].value) : null;
          const tankA = tbData.tank_a?.[0]?.value !== undefined ? Number(tbData.tank_a[0].value) : null;
          const tankB = tbData.tank_b?.[0]?.value !== undefined ? Number(tbData.tank_b[0].value) : null;
          const tankPhDown = tbData.tank_ph_down?.[0]?.value !== undefined ? Number(tbData.tank_ph_down[0].value) : null;
          const tankPhUp = tbData.tank_ph_up?.[0]?.value !== undefined ? Number(tbData.tank_ph_up[0].value) : null;

          const parseBool = (v) => v === true || v === 'true' || v === 1 || v === '1';

          if (ph !== null || ec !== null || latestTs > 0) {
            // ตรวจสอบความสดใหม่ตามเกณฑ์มาตรฐาน Fast & Stable IoT (ข้อมูลไม่เก่าเกิน 50 วินาที)
            const isTbFresh = latestTs > 0 && (now - latestTs <= 50000);
            const reportedTs = latestTs > 0 ? latestTs : now;

            // หาก ThingsBoard สดใหม่และใหม่กว่าหรือเท่ากับ Firebase ให้ซิงก์ข้อมูลจาก ThingsBoard
            if (isTbFresh && (!isFbDirectOnline || latestTs >= fbUpdatedTs)) {
              const currentPayload = {
                pH: ph,
                ec: ec,
                tds: tds ?? (ec ? Math.round(ec * 500) : 0),
                tempC: temp ?? 25,
                updatedAt: reportedTs
              };
              const levelPayload = {
                mainTankPercent: tankMain ?? 100,
                fertAPercent: tankA ?? 90,
                fertBPercent: tankB ?? 85
              };
              if (tankPhDown !== null) levelPayload.phDownPercent = tankPhDown;
              if (tankPhUp !== null) levelPayload.phUpPercent = tankPhUp;

              const deviceStatus = {
                esp32Connected: true,
                wifiConnected: true,
                lastSeen: reportedTs
              };

              const pumpPayload = {};
              if (tbData.pump_main !== undefined) pumpPayload.mainPumpOn = parseBool(tbData.pump_main[0]?.value);
              if (tbData.pump_a !== undefined) pumpPayload.fertPumpAOn = parseBool(tbData.pump_a[0]?.value);
              if (tbData.pump_b !== undefined) pumpPayload.fertPumpBOn = parseBool(tbData.pump_b[0]?.value);
              if (tbData.pump_ph_up !== undefined) pumpPayload.phUpPumpOn = parseBool(tbData.pump_ph_up[0]?.value);
              if (tbData.pump_ph_down !== undefined) pumpPayload.phDownPumpOn = parseBool(tbData.pump_ph_down[0]?.value);
              if (tbData.mode !== undefined) {
                const m = String(tbData.mode[0]?.value).toUpperCase();
                pumpPayload.controlMode = (m === 'AUTO' || m === 'MANUAL') ? m : 'MANUAL';
              }

              await db.ref(`boards/${name}/current`).update(currentPayload);
              await db.ref(`boards/${name}/levels`).update(levelPayload);
              await db.ref(`boards/${name}/device`).update(deviceStatus);
              if (Object.keys(pumpPayload).length > 0) {
                await db.ref(`boards/${name}/pumps`).update(pumpPayload);
              }
              await db.ref(`devices/${name}/current`).update(currentPayload);
              await db.ref(`devices/${name}/status`).set('online');

              // ตรวจสอบค่าผิดปกติเพื่อยิง Push Notification ถึงมือถือแม้แอปจะปิดอยู่
              if (ec !== null && (ec < 0.8 || ec > 2.8)) {
                sendPushToBoardOwners(name, {
                  title: '⚠️ ค่า EC ปุ๋ยวิกฤต',
                  body: `แปลง ${name}: ค่า EC อยู่ที่ ${ec.toFixed(2)} mS/cm สารละลายเจือจางหรือเข้มข้นเกินเกณฑ์ปลอดภัย`,
                  level: 'critical',
                  key: 'ec_crit'
                }).catch(() => {});
              }
              if (ph !== null && (ph < 4.8 || ph > 7.5)) {
                sendPushToBoardOwners(name, {
                  title: '⚠️ ค่า pH สารละลายวิกฤต',
                  body: `แปลง ${name}: ค่า pH อยู่ที่ ${ph.toFixed(2)} หลุดนอกช่วงปลอดภัย กรุณาตรวจสอบน้ำ`,
                  level: 'critical',
                  key: 'ph_crit'
                }).catch(() => {});
              }
              if (tankMain !== null && tankMain < 15) {
                sendPushToBoardOwners(name, {
                  title: '💧 ระดับน้ำในถังหลักเหลือน้อย',
                  body: `แปลง ${name}: ระดับน้ำลดเหลือ ${tankMain}% เสี่ยงปั๊มสูบแห้ง กรุณาเติมน้ำ`,
                  level: 'critical',
                  key: 'tank_low'
                }).catch(() => {});
              }
            } else if (isFbDirectOnline || isFbFresh) {
              // Dual-Channel Protection: อุปกรณ์รายงานตรงเข้า Firebase อย่างสดใหม่ ห้ามเขียนทับด้วยสถานะออฟไลน์
              await db.ref(`devices/${name}/status`).set('online');
            } else {
              // ทั้งสองช่องทางเงียบหายเกิน 50 วินาที ปรับเป็นออฟไลน์อย่างปลอดภัย (Safety Offline Fallback)
              const offlineDeviceStatus = {
                esp32Connected: false,
                wifiConnected: false,
                lastSeen: Math.max(latestTs, fbUpdatedTs) || now
              };
              const safePumps = {
                mainPumpOn: false,
                fertPumpAOn: false,
                fertPumpBOn: false,
                phUpPumpOn: false,
                phDownPumpOn: false
              };
              await db.ref(`boards/${name}/device`).update(offlineDeviceStatus);
              await db.ref(`boards/${name}/pumps`).update(safePumps);
              await db.ref(`devices/${name}/status`).set('offline');

              // บันทึกแจ้งเตือนเมื่ออุปกรณ์เปลี่ยนสถานะเป็นออฟไลน์
              if (fbDev.esp32Connected === true || d.status === 'online') {
                const alertKey = `alert_offline_${Math.floor(now / 180000)}`;
                await db.ref(`boards/${name}/alerts/${alertKey}`).set({
                  level: 'critical',
                  title: 'อุปกรณ์ออฟไลน์',
                  message: `อุปกรณ์ ${name} ขาดการเชื่อมต่อเกิน 50 วินาที เซ็นเซอร์และปั๊มตัดการทำงานเพื่อความปลอดภัย`,
                  timestamp: now,
                  read: false
                });

                // ยิง Push Notification ทันที (Critical / P0 - ปลุกได้ตลอด 24 ชม.)
                sendPushToBoardOwners(name, {
                  title: '🚨 แจ้งเตือนด่วน: อุปกรณ์ออฟไลน์',
                  body: `อุปกรณ์ ${name} ขาดการเชื่อมต่อนานเกิน 50 วินาที ปั๊มหยุดทำงานอัตโนมัติเพื่อความปลอดภัย`,
                  level: 'critical',
                  key: 'offline'
                }).catch(() => {});
              }
            }
          }
        }
      } catch (err) {
        // Individual device sync error: หาก ThingsBoard error และ Firebase ไม่สด ให้ตัดสถานะเป็นออฟไลน์ทันที
        if (!isFbFresh) {
          const offlineDeviceStatus = {
            esp32Connected: false,
            wifiConnected: false,
            lastSeen: fbUpdatedTs || now
          };
          const safePumps = {
            mainPumpOn: false,
            fertPumpAOn: false,
            fertPumpBOn: false,
            phUpPumpOn: false,
            phDownPumpOn: false
          };
          await db.ref(`boards/${name}/device`).update(offlineDeviceStatus).catch(() => {});
          await db.ref(`boards/${name}/pumps`).update(safePumps).catch(() => {});
          await db.ref(`devices/${name}/status`).set('offline').catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('syncTelemetryToFirebase failed:', err.message);
  }
}
if (process.env.NODE_ENV !== 'test') {
  setInterval(syncTelemetryToFirebase, 6000);
}

async function runHourlySummary() {
  if (!db) return 0;
  const snap = await db.ref('devices').once('value');
  const devices = snap.val() || {};
  const end = Math.floor(Date.now() / 3600000) * 3600000;
  const start = end - 3600000;
  let written = 0;

  for (const [name, d] of Object.entries(devices)) {
    if (d.status !== 'claimed' || !d.tbDeviceId) continue;
    try {
      const summary = {};
      for (const agg of ['AVG', 'MIN', 'MAX']) {
        const data = await tbClient('get', `/api/plugins/telemetry/DEVICE/${d.tbDeviceId}/values/timeseries`, {
          params: { keys: 'ph,ec,tds,temp', startTs: start, endTs: end, interval: 3600000, agg, limit: 1 }
        });
        for (const [key, pts] of Object.entries(data || {})) {
          if (pts && pts[0]) {
            summary[key] = summary[key] || {};
            summary[key][agg.toLowerCase()] = Number(pts[0].value);
          }
        }
      }
      if (Object.keys(summary).length) {
        await db.ref(`history/${name}/hourly/${thaiHourKey(start)}`).set({ ts: start, ...summary });
        written++;
      }
    } catch (err) {
      console.error('สรุปรายชั่วโมงล้มเหลว', name, err.response?.data || err.message);
    }
  }
  return written;
}

app.get('/api/cron', requireJobSecret, async (req, res) => {
  const hourly = req.query.hourly === 'true';
  try {
    const written = hourly ? await runHourlySummary() : 0;
    res.json({ status: 'awake', hourlyExecuted: hourly, devicesWritten: written, timestamp: new Date().toISOString() });
  } catch (err) {
    return fail(res, err, 'งานตั้งเวลาล้มเหลว');
  }
});

// ==========================================
// 7. ผูกอุปกรณ์กับบัญชี (POST /api/bind-device)
// ==========================================
app.post('/api/bind-device', verifyFirebaseUser, async (req, res) => {
  const { deviceName, claimCode, deviceLabel, farmId } = req.body || {};
  const uid = req.user.uid;

  if (typeof deviceName !== 'string' || !/^[A-Za-z0-9_-]{3,40}$/.test(deviceName)) {
    return res.status(400).json({ error: 'ชื่ออุปกรณ์ไม่ถูกต้อง' });
  }
  if (typeof claimCode !== 'string' || !/^[A-Za-z0-9]{6,32}$/.test(claimCode)) {
    return res.status(400).json({ error: 'รหัสไม่ถูกต้อง' });
  }
  const label = typeof deviceLabel === 'string' ? deviceLabel.trim().slice(0, 60) : '';
  const farm = typeof farmId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(farmId) ? farmId : null;

  const allowed = await consumeAttempt(`rateLimits/bind/${uid}`, BIND_MAX_ATTEMPTS, BIND_WINDOW_MS);
  if (!allowed) return res.status(429).json({ error: 'ลองหลายครั้งเกินไป กรุณารอสักครู่' });

  const wrongCode = () => res.status(400).json({ error: 'รหัสไม่ถูกต้อง' });

  try {
    let tbDevice;
    try {
      tbDevice = await tbClient('get', '/api/tenant/devices', { params: { deviceName } });
    } catch (err) {
      if (err.response?.status === 404) return wrongCode();
      throw err;
    }
    const tbDeviceId = tbDevice.id.id;

    const attrs = await readTbAttributes(tbDeviceId, 'claimCode,pairing');
    const claim = attrs.find((a) => a.key === 'claimCode');
    const pairing = attrs.find((a) => a.key === 'pairing');

    if (!claim || !safeEqual(claim.value, claimCode)) return wrongCode();

    const pairingOn = pairing && (pairing.value === true || pairing.value === 'true');
    const pairingFresh = pairingOn && Date.now() - Number(pairing.lastUpdateTs) < PAIRING_WINDOW_MS;
    if (!pairingFresh) {
      return res.status(409).json({ error: 'อุปกรณ์ไม่ได้อยู่ในโหมดจับคู่ กรุณาปิดแล้วเปิดเครื่องอุปกรณ์ใหม่' });
    }

    let prevOwner = null;
    const tx = await db.ref(`devices/${deviceName}`).transaction((cur) => {
      prevOwner = cur && cur.ownerUid ? cur.ownerUid : null;
      if (cur && cur.status === 'claimed' && cur.ownerUid && cur.ownerUid !== uid &&
          Date.now() - Number(cur.claimedAt || 0) < PAIRING_WINDOW_MS) {
        return;
      }
      return {
        ...(cur || {}),
        status: 'claimed',
        ownerUid: uid,
        tbDeviceId,
        name: label || (cur && cur.name) || deviceName,
        ...(farm ? { farmId: farm } : {}),
        claimedAt: Date.now()
      };
    });
    if (!tx.committed) {
      return res.status(409).json({ error: 'อุปกรณ์นี้เพิ่งถูกผูกโดยผู้ใช้อื่น' });
    }

    const updates = { [`users/${uid}/devices/${deviceName}`]: true };
    if (prevOwner && prevOwner !== uid) {
      updates[`users/${prevOwner}/devices/${deviceName}`] = null;
      updates[`users/${prevOwner}/savedBoards/${deviceName}`] = null;
    }
    await db.ref('/').update(updates);
    await db.ref(`rateLimits/bind/${uid}`).remove();

    // Check if board already has an active plant profile from a previous or ongoing cycle
    let hasExistingPlant = false;
    let existingPlantType = null;
    let existingPlantingDate = null;
    let existingHarvestDays = null;
    let existingTargets = null;

    const currentBoardSnap = await db.ref(`boards/${deviceName}`).once('value');
    if (currentBoardSnap.exists()) {
      const val = currentBoardSnap.val();
      if (val && val.plantType && typeof val.plantType === 'string' && val.plantType.trim().length > 0) {
        hasExistingPlant = true;
        existingPlantType = val.plantType;
        existingPlantingDate = val.plantingStartDate;
        existingHarvestDays = val.expectedHarvestDays;
        existingTargets = val.targets;
      }
    }

    // Fallback: หากบน boards ยังไม่มี ให้ตรวจดูที่ crops/${farmId}/${cropId} จาก seed data
    if (!hasExistingPlant) {
      const devSnap = await db.ref(`devices/${deviceName}`).once('value');
      if (devSnap.exists()) {
        const devVal = devSnap.val() || {};
        const fId = devVal.farmId || 'farm_001';
        const cId = devVal.cropId || 'crop_001';
        const cropSnap = await db.ref(`crops/${fId}/${cId}`).once('value');
        if (cropSnap.exists()) {
          const cropVal = cropSnap.val() || {};
          if (cropVal.cropName || cropVal.plantType) {
            hasExistingPlant = true;
            existingPlantType = cropVal.cropName || cropVal.plantType;
            existingPlantingDate = cropVal.startDate || Date.now();
            existingHarvestDays = cropVal.harvestDays || 45;
            existingTargets = {
              phMin: cropVal.targetPhMin || 5.8,
              phMax: cropVal.targetPhMax || 6.5,
              ecMin: cropVal.targetEcMin || 1.2,
              ecMax: cropVal.targetEcMax || 2.0,
              tempMin: cropVal.targetTempMin || 22.0,
              tempMax: cropVal.targetTempMax || 28.0,
            };
          }
        }
      }
    }

    const boardUpdate = {
      ownerUid: uid,
      status: 'claimed',
      pumps: {
        mainPumpOn: false,
        fertPumpAOn: false,
        fertPumpBOn: false,
        phUpPumpOn: false,
        phDownPumpOn: false,
        controlMode: 'MANUAL'
      }
    };

    if (hasExistingPlant) {
      boardUpdate.plantType = existingPlantType;
      boardUpdate.plantingStartDate = existingPlantingDate;
      boardUpdate.expectedHarvestDays = existingHarvestDays;
      if (existingTargets) boardUpdate.targets = existingTargets;
    } else {
      boardUpdate.plantType = null;
      boardUpdate.plantingStartDate = null;
      boardUpdate.expectedHarvestDays = null;
      boardUpdate.targets = null;
      boardUpdate.aiMemory = null;
      boardUpdate.alerts = null;
    }

    await db.ref(`boards/${deviceName}`).update(boardUpdate);

    if (hasExistingPlant) {
      await db.ref(`users/${uid}/savedBoards/${deviceName}`).update({
        plantType: existingPlantType,
        plantingStartDate: existingPlantingDate,
        expectedHarvestDays: existingHarvestDays
      });
    } else {
      await db.ref(`boards/${deviceName}/plantType`).remove();
      await db.ref(`boards/${deviceName}/plantingStartDate`).remove();
      await db.ref(`boards/${deviceName}/expectedHarvestDays`).remove();
      await db.ref(`boards/${deviceName}/targets`).remove();
      await db.ref(`boards/${deviceName}/aiMemory`).remove();
      await db.ref(`boards/${deviceName}/alerts`).remove();
    }

    res.json({ success: true, deviceName });
  } catch (err) {
    return fail(res, err, 'ผูกอุปกรณ์ไม่สำเร็จ');
  }
});

// ==========================================
// 8. เปิดโหมดจับคู่อีกครั้งสำหรับเปลี่ยน WiFi
// ==========================================
app.post('/api/boards/:deviceName/enable-pairing', verifyFirebaseUser, requireOwner, async (req, res) => {
  const ok = await consumeAttempt(`rateLimits/pairing/${req.device.name}`, 5, 60 * 60 * 1000);
  if (!ok) return res.status(429).json({ error: 'ขอเปิดโหมดจับคู่บ่อยเกินไป กรุณารอสักครู่' });

  try {
    const attrs = await readTbAttributes(req.device.tbDeviceId, 'active');
    const active = attrs.find((a) => a.key === 'active');
    if (!active || !(active.value === true || active.value === 'true')) {
      return res.status(409).json({ error: 'อุปกรณ์ออฟไลน์ ให้กดปุ่มบนอุปกรณ์ค้าง 5 วินาที' });
    }
    await tbClient('post', `/api/plugins/rpc/twoway/${req.device.tbDeviceId}`, {
      data: { method: 'enablePairing', params: {}, timeout: 10000 }
    });
    res.json({ success: true });
  } catch (err) {
    const s = err.response?.status;
    if (s === 408 || s === 504) {
      return res.status(504).json({ error: 'อุปกรณ์ไม่ตอบสนอง ให้กดปุ่มบนอุปกรณ์ค้าง 5 วินาที' });
    }
    return fail(res, err, 'เปิดโหมดจับคู่ไม่สำเร็จ');
  }
});

// ==========================================
// 9. ดึงค่าเซนเซอร์สดและประวัติ
// ==========================================
function parseKeys(raw, fallback) {
  const list = String(raw || fallback).split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length || !list.every((k) => ALLOWED_KEYS.includes(k))) return null;
  return list;
}

app.get('/api/telemetry/:deviceName', verifyFirebaseUser, requireOwner, async (req, res) => {
  const keys = parseKeys(req.query.keys, 'ph,ec,tds,temp');
  if (!keys) return res.status(400).json({ error: 'คีย์ข้อมูลไม่ถูกต้อง' });

  const params = { keys: keys.join(',') };
  const { startTs, endTs } = req.query;

  if (startTs && endTs) {
    const s = Number(startTs);
    const e = Number(endTs);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || e - s > 120 * 24 * 3600 * 1000) {
      return res.status(400).json({ error: 'ช่วงเวลาไม่ถูกต้อง (ไม่เกิน 120 วัน)' });
    }
    const agg = ['NONE', 'AVG', 'MIN', 'MAX'].includes(req.query.agg) ? req.query.agg : 'AVG';
    let interval = Number(req.query.interval) || 3600000;
    // ป้องกัน ThingsBoard Aggregation Error เมื่อจำนวนช่วงเวลาเกิน 480 จุด
    if (agg !== 'NONE' && (e - s) / interval > 480) {
      interval = Math.ceil((e - s) / 480);
    }
    interval = Math.max(60000, interval);
    Object.assign(params, { startTs: s, endTs: e, agg, limit: 1000 });
    if (agg !== 'NONE') params.interval = interval;
  } else {
    // เมื่อดึงค่าล่าสุด บังคับจำกัด 1 จุด เพื่อให้ได้ค่าสดใหม่ล่าสุดเสมอ (ป้องกันได้ค่าเก่าค้าง)
    params.limit = 1;
  }

  try {
    const data = await tbClient('get', `/api/plugins/telemetry/DEVICE/${req.device.tbDeviceId}/values/timeseries`, { params });
    // ทริกเกอร์การซิงก์ข้อมูลลง Firebase RTDB ทันที
    syncTelemetryToFirebase().catch(() => {});
    res.json(data);
  } catch (err) {
    return fail(res, err, 'ดึงค่าเซนเซอร์ไม่สำเร็จ');
  }
});

// ==========================================
// 10. สั่งงานปั๊มและตั้งค่าเป้าหมาย
// ==========================================
const ALLOWED_RPC = {
  setPump: (p) =>
    PUMPS.includes(p && p.pump) && Number.isInteger(p.seconds) && p.seconds >= 1 && p.seconds <= MAX_PUMP_SECONDS,
  setMode: (p) => ['AUTO', 'MANUAL'].includes(p && p.mode),
  reboot: () => true,
  resetWifi: () => true,
  factoryReset: () => true,
  unbind: () => true
};

function validateTargets(attrs) {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return { error: 'รูปแบบค่าเป้าหมายไม่ถูกต้อง' };
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    const m = k.match(/^(ph|ec|temp)_(min|max)$/);
    if (!m) return { error: `ไม่อนุญาตให้ตั้งค่า ${k}` };
    if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${k} ต้องเป็นตัวเลข` };
    const [lo, hi] = SAFE_LIMITS[m[1]];
    if (v < lo || v > hi) return { error: `${k} ต้องอยู่ระหว่าง ${lo} ถึง ${hi}` };
    out[k] = v;
  }
  for (const t of ['ph', 'ec', 'temp']) {
    if (out[`${t}_min`] !== undefined && out[`${t}_max`] !== undefined && out[`${t}_min`] >= out[`${t}_max`]) {
      return { error: `${t}_min ต้องน้อยกว่า ${t}_max` };
    }
  }
  return { value: out };
}

app.post('/api/command/:deviceName', verifyFirebaseUser, requireOwner, async (req, res) => {
  const { method, params, sharedAttributes } = req.body || {};
  if (!method && !sharedAttributes) return res.status(400).json({ error: 'ไม่มีคำสั่งที่จะส่ง' });

  if (method) {
    const validator = ALLOWED_RPC[method];
    if (!validator || !validator(params)) return res.status(400).json({ error: 'คำสั่งหรือค่าที่ส่งไม่ถูกต้อง' });
  }
  let targets = null;
  if (sharedAttributes) {
    const r = validateTargets(sharedAttributes);
    if (r.error) return res.status(400).json({ error: r.error });
    targets = r.value;
  }

  try {
    const id = req.device.tbDeviceId;
    if (targets && Object.keys(targets).length) {
      await tbClient('post', `/api/plugins/telemetry/DEVICE/${id}/SHARED_SCOPE`, { data: targets });
    }
    if (method) {
      try {
        await tbClient('post', `/api/plugins/rpc/oneway/${id}`, { data: { method, params } });
      } catch (rpcErr) {
        console.warn(`[RPC] ThingsBoard RPC failed for device ${id}:`, rpcErr.message || rpcErr);
        if (method !== 'unbind' && method !== 'factoryReset') throw rpcErr;
      }
    }
    if (method === 'unbind' && db) {
      const name = req.device.name;
      const uid = req.user.uid;
      await db.ref(`boards/${name}`).update({
        ownerUid: null,
        status: 'unbound',
        updatedAt: Date.now()
      });
      await db.ref(`devices/${name}/ownerUid`).remove();
      await db.ref(`devices/${name}/farmId`).remove();
      await db.ref(`devices/${name}/status`).set('unclaimed');
      await db.ref(`users/${uid}/savedBoards/${name}`).remove();
      await db.ref(`users/${uid}/devices/${name}`).remove();
    }
    if (method === 'factoryReset' && db) {
      const name = req.device.name;
      const uid = req.user.uid;
      const cleanBoardState = {
        ownerUid: null,
        status: 'unbound',
        plantType: null,
        plantingStartDate: null,
        expectedHarvestDays: null,
        targets: null,
        aiMemory: null,
        alerts: null,
        pumps: {
          mainPumpOn: false,
          fertPumpAOn: false,
          fertPumpBOn: false,
          phUpPumpOn: false,
          phDownPumpOn: false,
          controlMode: 'MANUAL'
        },
        device: {
          esp32Connected: false,
          wifiConnected: false,
          lastSeen: Date.now()
        },
        updatedAt: Date.now()
      };
      await db.ref(`boards/${name}`).update(cleanBoardState);
      await db.ref(`boards/${name}/plantType`).remove();
      await db.ref(`boards/${name}/plantingStartDate`).remove();
      await db.ref(`boards/${name}/expectedHarvestDays`).remove();
      await db.ref(`boards/${name}/targets`).remove();
      await db.ref(`boards/${name}/aiMemory`).remove();
      await db.ref(`boards/${name}/alerts`).remove();
      await db.ref(`history/${name}`).remove();
      await db.ref(`devices/${name}/ownerUid`).remove();
      await db.ref(`devices/${name}/farmId`).remove();
      await db.ref(`devices/${name}/status`).set('unclaimed');
      await db.ref(`users/${uid}/savedBoards/${name}`).remove();
      await db.ref(`users/${uid}/devices/${name}`).remove();
    }
    res.json({ success: true });
  } catch (err) {
    return fail(res, err, 'ส่งคำสั่งไปยังอุปกรณ์ไม่สำเร็จ');
  }
});

// ==========================================
// 11. ส่งออก CSV
// ==========================================
app.get('/api/export/:deviceName', verifyFirebaseUser, requireOwner, async (req, res) => {
  const keys = parseKeys(req.query.keys, ALLOWED_KEYS.join(','));
  if (!keys) return res.status(400).json({ error: 'คีย์ข้อมูลไม่ถูกต้อง' });

  const end = Number(req.query.endTs) || Date.now();
  const start = Number(req.query.startTs) || end - 7 * 24 * 3600 * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 120 * 24 * 3600 * 1000) {
    return res.status(400).json({ error: 'ช่วงเวลาไม่ถูกต้อง (ไม่เกิน 120 วัน)' });
  }
  const interval = Math.max(60000, Number(req.query.interval) || 600000);
  const limit = Math.min(50000, Math.ceil((end - start) / interval) + 10);

  try {
    const data = await tbClient('get', `/api/plugins/telemetry/DEVICE/${req.device.tbDeviceId}/values/timeseries`, {
      params: { keys: keys.join(','), startTs: start, endTs: end, agg: 'AVG', interval, limit }
    });

    const rows = new Map();
    for (const key of keys) {
      for (const pt of (data && data[key]) || []) {
        if (!rows.has(pt.ts)) rows.set(pt.ts, {});
        rows.get(pt.ts)[key] = pt.value;
      }
    }
    const cell = (v) => {
      const s = String(v === undefined || v === null ? '' : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [['time_th', ...keys].join(',')];
    for (const ts of Array.from(rows.keys()).sort((a, b) => a - b)) {
      const r = rows.get(ts);
      lines.push([toThaiIso(Number(ts)), ...keys.map((k) => cell(r[k]))].join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hydroponic_${req.device.name}.csv"`);
    res.send('\uFEFF' + lines.join('\n'));
  } catch (err) {
    return fail(res, err, 'ส่งออกไฟล์ CSV ไม่สำเร็จ');
  }
});

// ==========================================
// 12. วิเคราะห์ด้วย AI
// ==========================================
async function takeAiQuota(uid) {
  const day = thaiHourKey(Date.now()).slice(0, 8);
  const ref = db.ref(`aiUsage/${uid}/${day}`);
  let allowed = true;
  await ref.transaction((cur) => {
    allowed = true;
    const n = cur || 0;
    if (n >= AI_DAILY_LIMIT) {
      allowed = false;
      return;
    }
    return n + 1;
  });
  return { allowed, refund: () => ref.transaction((cur) => Math.max((cur || 1) - 1, 0)) };
}

app.post('/api/ai/analyze', verifyFirebaseUser, async (req, res) => {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่า AI บนเซิร์ฟเวอร์' });

  const { cropName, sensorData, question, anomalyData } = req.body || {};
  const crop = typeof cropName === 'string' ? cropName.trim().slice(0, 100) : 'ผักไฮโดรโปนิกส์';
  const q = typeof question === 'string' ? question.trim().slice(0, 300) : '';
  const sensors = {};
  if (sensorData && typeof sensorData === 'object') {
    for (const k of ALLOWED_KEYS) {
      if (typeof sensorData[k] === 'number' && Number.isFinite(sensorData[k])) sensors[k] = sensorData[k];
    }
  }

  const quota = await takeAiQuota(req.user.uid);
  if (!quota.allowed) {
    return res.status(429).json({ error: `วันนี้ใช้ AI ครบ ${AI_DAILY_LIMIT} ครั้งแล้ว ลองใหม่พรุ่งนี้` });
  }

  // Gemini Token-Saver: One-off anomaly prompt (Concise, no memory diary overhead)
  const prompt = [
    'คุณคือผู้เชี่ยวชาญการปลูกพืชไฮโดรโปนิกส์ ตอบเป็นภาษาไทย กระชับ ตรงจุด ไม่เกิน 4 บรรทัด',
    'วิเคราะห์เฉพาะค่าที่ผิดปกติหรือข้อสงสัยที่ถามเท่านั้น',
    `ห้ามแนะนำให้ปรับเกินค่าที่ปลอดภัย (pH ${SAFE_LIMITS.ph.join('-')}, EC ${SAFE_LIMITS.ec.join('-')}, อุณหภูมิ ${SAFE_LIMITS.temp.join('-')})`,
    '<ข้อมูล>',
    `พืช: ${crop}`,
    `ค่าเซนเซอร์: ${JSON.stringify(sensors)}`,
    anomalyData ? `ค่าที่ผิดปกติ: ${JSON.stringify(anomalyData)}` : '',
    `ข้อสงสัย: ${q || 'วิเคราะห์ความผิดปกติของค่าน้ำและวิธีแก้ไขด่วน'}`,
    '</ข้อมูล>'
  ].filter(Boolean).join('\n');

  try {
    const aiRes = await axiosClient.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const advice = aiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!advice) {
      await quota.refund();
      return res.status(502).json({ error: 'AI ไม่ตอบกลับ กรุณาลองใหม่' });
    }
    res.json({ advice });
  } catch (err) {
    await quota.refund();
    return fail(res, err, 'เรียกใช้งาน AI ไม่สำเร็จ');
  }
});

// ==========================================
// 13. จัดการข้อผิดพลาดและเริ่มเซิร์ฟเวอร์
// ==========================================
app.use((req, res) => res.status(404).json({ error: 'ไม่พบเส้นทางนี้' }));

app.use((err, req, res, next) => {
  if (err && err.message === 'CORS_BLOCKED') return res.status(403).json({ error: 'ไม่อนุญาตให้เรียกจากที่มานี้' });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Hydroponic server running on port ${PORT}`);
  });
}

module.exports = app;
module.exports.__setTestDb = (mockDb) => { db = mockDb; };
module.exports.__setTestAuth = (mockAuth) => { testAuth = mockAuth; };
module.exports.__setTestTb = (mockTb) => { tbClient = mockTb; };
module.exports.__syncTelemetryToFirebase = syncTelemetryToFirebase;
module.exports.__sendPushToBoardOwners = sendPushToBoardOwners;
module.exports.__pushCooldownMap = pushCooldownMap;
module.exports.__setTestMessaging = (mock) => { testMessaging = mock; };
module.exports.__setTestAxios = (mockAxios) => { axiosClient = mockAxios; };


