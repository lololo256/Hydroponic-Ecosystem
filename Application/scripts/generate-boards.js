import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// กำหนดจำนวนบอร์ดที่ต้องการสร้างจาก Argument (เช่น node generate-boards.js 20) หรือค่าเริ่มต้น 10
const args = process.argv.slice(2);
const count = parseInt(args[0], 10) || 10;

console.log(`\n==================================================`);
console.log(` กำลังสร้างบอร์ดใหม่จำนวน ${count} ตัว (Hydroponic Ecosystem)`);
console.log(`==================================================\n`);

const devices = {};
const deviceSecrets = {};
const csvRows = ['DeviceID,ClaimCode,QR_Data'];

const generatedIds = new Set();

for (let i = 0; i < count; i++) {
  // 1. สุ่มรหัสบอร์ดที่ไม่ซ้ำกัน รูปแบบ FARM-XXXXXX (Hex ตัวพิมพ์ใหญ่ 6 ตัว)
  let deviceId;
  do {
    const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
    deviceId = `FARM-${randomHex}`;
  } while (generatedIds.has(deviceId));
  generatedIds.add(deviceId);

  // 2. สุ่มรหัส Claim Code 6 หลักอย่างปลอดภัย (100000 - 999999)
  const claimCode = crypto.randomInt(100000, 1000000).toString();

  const now = Date.now();

  // 3. โครงสร้างข้อมูลสำหรับ Firebase Realtime Database
  devices[deviceId] = {
    status: 'unclaimed',
    ownerUid: '',
    createdAt: now
  };

  deviceSecrets[deviceId] = {
    claimCode: claimCode
  };

  // 4. QR Data ในรูปแบบ JSON {"d":"FARM-A1B2C3","c":"482913"}
  const qrPayload = JSON.stringify({ d: deviceId, c: claimCode });
  // Escape Double Quotes สำหรับ CSV
  const escapedQr = qrPayload.replace(/"/g, '""');
  csvRows.push(`${deviceId},${claimCode},"${escapedQr}"`);
}

// 5. บันทึกไฟล์ JSON สำหรับ Import เข้า Firebase Console
const outputDir = path.join(__dirname, 'output');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const firebaseImportData = {
  devices: devices,
  deviceSecrets: deviceSecrets
};

const jsonPath = path.join(outputDir, 'devices_import.json');
fs.writeFileSync(jsonPath, JSON.stringify(firebaseImportData, null, 2), 'utf-8');

const csvPath = path.join(outputDir, 'boards_qr_print.csv');
fs.writeFileSync(csvPath, csvRows.join('\r\n'), 'utf-8');

console.log(`สร้างสำเร็จเรียบร้อย!`);
console.log(` 1. ไฟล์ JSON สำหรับ Import เข้า Firebase RTDB:`);
console.log(`    -> ${jsonPath}`);
console.log(` 2. ไฟล์ CSV สำหรับพิมพ์สติกเกอร์ QR Code ติดบอร์ด:`);
console.log(`    -> ${csvPath}\n`);

console.log(`ตัวอย่างบอร์ดที่สร้างขึ้น:`);
const sampleKeys = Object.keys(devices).slice(0, 3);
sampleKeys.forEach(k => {
  console.log(` - บอร์ด: ${k} | รหัสยืนยัน: ${deviceSecrets[k].claimCode} | QR Data: {"d":"${k}","c":"${deviceSecrets[k].claimCode}"}`);
});
console.log(`\n==================================================\n`);

