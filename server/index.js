const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 1. ตั้งค่าเชื่อมต่อ Firebase Admin
// ==========================================
let db = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log('Firebase Admin initialized successfully');
  } catch (err) {
    console.error('Firebase initialization error:', err.message);
  }
}

// Middleware ตรวจสอบ Firebase ID Token จากแอปมือถือ
async function verifyFirebaseUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization Bearer token' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid Firebase token', details: err.message });
  }
}

// ==========================================
// 2. ระบบจัดการ Token ของ ThingsBoard อัตโนมัติ
// ==========================================
const TB_URL = (process.env.THINGSBOARD_URL || 'https://eu.thingsboard.cloud').replace(/\/$/, '');
const TB_USERNAME = process.env.THINGSBOARD_USERNAME;
const TB_PASSWORD = process.env.THINGSBOARD_PASSWORD;

let tbJwtToken = null;
let tbTokenExpireAt = 0;

async function getThingsBoardHeaders() {
  const now = Date.now();
  if (tbJwtToken && now < tbTokenExpireAt) {
    return { 'X-Authorization': `Bearer ${tbJwtToken}` };
  }
  if (!TB_USERNAME || !TB_PASSWORD) {
    throw new Error('THINGSBOARD_USERNAME or THINGSBOARD_PASSWORD is not configured on Render');
  }
  const response = await axios.post(`${TB_URL}/api/auth/login`, {
    username: TB_USERNAME,
    password: TB_PASSWORD
  });
  tbJwtToken = response.data.token;
  // เก็บ Token ไว้ใช้ซ้ำ 45 นาทีก่อนขอใหม่
  tbTokenExpireAt = now + 45 * 60 * 1000;
  return { 'X-Authorization': `Bearer ${tbJwtToken}` };
}

// ==========================================
// 3. เส้นทางสำหรับ cron-job.org (ปลุกเซิร์ฟเวอร์ + งานรายชั่วโมง)
// ==========================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Hydroponic Render Server is awake and running!',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/cron', async (req, res) => {
  const runHourlyTask = req.query.hourly === 'true';
  try {
    if (runHourlyTask && db) {
      // ตัวอย่างงานรายชั่วโมง: อัปเดตเวลาตรวจสอบล่าสุดลงใน Firebase
      await db.collection('system_status').doc('cron').set({
        lastHourlyRun: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    res.json({
      status: 'awake',
      hourlyTaskExecuted: runHourlyTask,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. ผูกบอร์ด ESP32 เข้ากับฟาร์มใน Firebase (POST /api/bind-device)
// ==========================================
app.post('/api/bind-device', verifyFirebaseUser, async (req, res) => {
  const { farmId, deviceName, deviceLabel } = req.body;
  if (!farmId || !deviceName) {
    return res.status(400).json({ error: 'กรุณาระบุ farmId และ deviceName' });
  }

  try {
    const headers = await getThingsBoardHeaders();
    let device = null;

    // ค้นหาว่ามี Device ชื่อนี้อยู่ใน ThingsBoard แล้วหรือยัง
    try {
      const findRes = await axios.get(
        `${TB_URL}/api/tenant/devices?deviceName=${encodeURIComponent(deviceName)}`,
        { headers }
      );
      device = findRes.data;
    } catch (findErr) {
      // ถ้ายังไม่มี ให้สร้าง Device ใหม่บน ThingsBoard
      const createRes = await axios.post(
        `${TB_URL}/api/device`,
        {
          name: deviceName,
          type: 'ESP32',
          label: deviceLabel || deviceName
        },
        { headers }
      );
      device = createRes.data;
    }

    const deviceId = device.id.id;

    // ดึง Access Token ของบอร์ดสำหรับนำไปใส่ในโค้ด ESP32
    const credRes = await axios.get(`${TB_URL}/api/device/${deviceId}/credentials`, { headers });
    const accessToken = credRes.data.credentialsId;

    // บันทึกการผูกบอร์ดลงใน Firebase Firestore
    if (db) {
      await db.collection('farms').doc(farmId).set({
        ownerUid: req.user.uid,
        deviceName,
        tbDeviceId: deviceId,
        tbAccessToken: accessToken,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    res.json({
      success: true,
      farmId,
      deviceName,
      tbDeviceId: deviceId,
      tbAccessToken: accessToken
    });
  } catch (err) {
    res.status(500).json({
      error: 'ผูกบอร์ดไม่สำเร็จ',
      details: err.response?.data || err.message
    });
  }
});

// ==========================================
// 5. ดึงค่าเซนเซอร์สดและประวัติจาก ThingsBoard (GET /api/telemetry/:deviceId)
// ==========================================
app.get('/api/telemetry/:deviceId', verifyFirebaseUser, async (req, res) => {
  const { deviceId } = req.params;
  const { keys = 'temperature,humidity,ec,ph,waterLevel,pumpStatus', startTs, endTs } = req.query;

  try {
    const headers = await getThingsBoardHeaders();

    // ถ้ามีการส่งช่วงเวลา startTs และ endTs มา ให้ดึงประวัติย้อนหลัง
    if (startTs && endTs) {
      const historyRes = await axios.get(
        `${TB_URL}/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`,
        {
          headers,
          params: { keys, startTs, endTs, limit: 500, agg: 'NONE' }
        }
      );
      return res.json(historyRes.data);
    }

    // ถ้าไม่ส่งช่วงเวลา ให้ดึงค่าเซนเซอร์ล่าสุด (ค่าสด)
    const latestRes = await axios.get(
      `${TB_URL}/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`,
      {
        headers,
        params: { keys }
      }
    );
    res.json(latestRes.data);
  } catch (err) {
    res.status(500).json({
      error: 'ดึงค่าเซนเซอร์ไม่สำเร็จ',
      details: err.response?.data || err.message
    });
  }
});

// ==========================================
// 6. สั่งงานปั๊มหรือตั้งค่าเป้าหมายไปยังบอร์ด ESP32 (POST /api/command/:deviceId)
// ==========================================
app.post('/api/command/:deviceId', verifyFirebaseUser, async (req, res) => {
  const { deviceId } = req.params;
  const { method, params, sharedAttributes } = req.body;

  try {
    const headers = await getThingsBoardHeaders();

    // กรณีบันทึกค่าเป้าหมายรอบปลูก (Shared Attributes) ให้บอร์ด ESP32 นำไปคุมปั๊มเอง
    if (sharedAttributes) {
      await axios.post(
        `${TB_URL}/api/plugins/telemetry/DEVICE/${deviceId}/SHARED_SCOPE`,
        sharedAttributes,
        { headers }
      );
    }

    // กรณีสั่งเปิด-ปิดปั๊มทันทีผ่าน RPC
    let rpcResult = null;
    if (method) {
      const rpcRes = await axios.post(
        `${TB_URL}/api/plugins/rpc/oneway/${deviceId}`,
        { method, params: params || {} },
        { headers }
      );
      rpcResult = rpcRes.data;
    }

    res.json({
      success: true,
      rpcResult
    });
  } catch (err) {
    res.status(500).json({
      error: 'ส่งคำสั่งไปยังบอร์ดไม่สำเร็จ',
      details: err.response?.data || err.message
    });
  }
});

// ==========================================
// 7. ส่งออกไฟล์ CSV ประวัติรอบปลูก (GET /api/export/:deviceId)
// ==========================================
app.get('/api/export/:deviceId', verifyFirebaseUser, async (req, res) => {
  const { deviceId } = req.params;
  const {
    keys = 'temperature,humidity,ec,ph,waterLevel',
    startTs = Date.now() - 7 * 24 * 60 * 60 * 1000,
    endTs = Date.now()
  } = req.query;

  try {
    const headers = await getThingsBoardHeaders();
    const historyRes = await axios.get(
      `${TB_URL}/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`,
      {
        headers,
        params: { keys, startTs, endTs, limit: 5000, agg: 'NONE' }
      }
    );

    const data = historyRes.data || {};
    const keyList = keys.split(',').map((k) => k.trim());
    const timeMap = new Map();

    for (const key of keyList) {
      const points = data[key] || [];
      for (const pt of points) {
        if (!timeMap.has(pt.ts)) {
          timeMap.set(pt.ts, {});
        }
        timeMap.get(pt.ts)[key] = pt.value;
      }
    }

    const sortedTimestamps = Array.from(timeMap.keys()).sort((a, b) => a - b);
    const csvRows = [['timestamp_iso', ...keyList].join(',')];

    for (const ts of sortedTimestamps) {
      const rowValues = timeMap.get(ts);
      const isoTime = new Date(Number(ts)).toISOString();
      const row = [isoTime, ...keyList.map((k) => rowValues[k] ?? '')];
      csvRows.push(row.join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hydroponic_${deviceId}.csv"`);
    res.send('\uFEFF' + csvRows.join('\n'));
  } catch (err) {
    res.status(500).json({
      error: 'ส่งออกไฟล์ CSV ไม่สำเร็จ',
      details: err.response?.data || err.message
    });
  }
});

// ==========================================
// 8. วิเคราะห์ค่าเซนเซอร์ด้วย AI API โควตาฟรี (POST /api/ai/analyze)
// ==========================================
app.post('/api/ai/analyze', verifyFirebaseUser, async (req, res) => {
  const { cropName, sensorData, question } = req.body;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!geminiKey) {
    return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY ใน Render Environment' });
  }

  try {
    const prompt = `คุณคือผู้เชี่ยวชาญการปลูกพืชไฮโดรโปนิกส์
พืชที่ปลูก: ${cropName || 'ผักสลัดไฮโดรโปนิกส์'}
ค่าเซนเซอร์ปัจจุบัน: ${JSON.stringify(sensorData || {})}
คำถามเพิ่มเติม: ${question || 'ช่วยวิเคราะห์สภาพน้ำและอากาศตอนนี้ พร้อมคำแนะนำการปรับค่า EC/pH และการดูแลแบบกระชับเข้าใจง่าย'}`;

    const aiRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        contents: [{ parts: [{ text: prompt }] }]
      }
    );

    const advice = aiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'ไม่สามารถวิเคราะห์ได้ในขณะนี้';
    res.json({ advice });
  } catch (err) {
    res.status(500).json({
      error: 'เรียกใช้งาน AI API ไม่สำเร็จ',
      details: err.response?.data || err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hydroponic Render Server running on port ${PORT}`);
});
