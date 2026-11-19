# Hydroponic Ecosystem

ระบบฟาร์มผักไฮโดรโปนิกส์อัจฉริยะ: บอร์ด ESP32 วัดค่าน้ำ (pH, EC/TDS, อุณหภูมิ, ลูกลอยถังน้ำ) ส่งขึ้น ThingsBoard Cloud
แล้วแอปบนมือถือแสดงค่าแบบสด กราฟย้อนหลัง แจ้งเตือน และสั่งปั๊มจ่ายปุ๋ย / ปรับ pH ได้ทั้งแบบสั่งเองและแบบอัตโนมัติ

## ดาวน์โหลดแอป (Android)

**หน้าดาวน์โหลด: https://lololo256.github.io/Hydroponic-Ecosystem/**

| แอป | ใช้ทำอะไร | ดาวน์โหลด |
| --- | --- | --- |
| Hydroponic | แอปหลักสำหรับเจ้าของฟาร์ม สมัครบัญชี ผูกบอร์ดด้วย QR / บลูทูธ ดูค่าน้ำ และควบคุมปั๊ม | [Hydroponic.apk](https://lololo256.github.io/Hydroponic-Ecosystem/apk/Hydroponic.apk) |
| Hydroponic Demo | แอปเดโมสำหรับอาจารย์ เข้าบัญชีที่ผูกบอร์ดทดลองไว้ให้อัตโนมัติ ไม่ต้องสมัครหรือล็อกอิน ลองส่งค่า pH / EC / อุณหภูมิเข้าบอร์ดได้จากกล่อง "ทดสอบระบบอัตโนมัติ" บนหน้าแรก | [Hydroponic-Demo.apk](https://lololo256.github.io/Hydroponic-Ecosystem/apk/Hydroponic-Demo.apk) |

ติดตั้งคู่กันบนมือถือเครื่องเดียวได้ ไฟล์ .apk ใช้กับ Android เท่านั้น (ตอนติดตั้งให้อนุญาต "ติดตั้งแอปที่ไม่รู้จัก")

## ข้อมูลโครงงาน

| หัวข้อ | รายละเอียด |
| --- | --- |
| ชื่อทีม | ธุรกิจพันล้าน |
| ชื่อโครงงาน | Hydroponic Ecosystem |


### สมาชิก

| รหัสนักศึกษา | ชื่อ-นามสกุล | Section |
| --- | --- | --- |
| 68062417 | ภูมิภัทร สุขใส | 2 |
| 68100372 | ภูมิพศิน รัตนวิจิตร | 2 |
| 68103740 | รัตนกร พูลถม | 2 |

ติดต่อ phumiphatsuksai403@gmail.com

## ระบบทำงานอย่างไร

```
บอร์ด ESP32-S3 (เซนเซอร์ + ปั๊ม 5 ตัว)
   │  MQTT (telemetry ทุก 30 วินาที, RPC สั่งปั๊ม / เปลี่ยนโหมด)
   ▼
ThingsBoard Cloud (EU) ── Rule Chain: แจ้งเตือนเมื่อค่าหลุดช่วง / บอร์ดออฟไลน์
   │  REST
   ▼
แอป Hydroponic (React + Capacitor, Android / iOS)

เซิร์ฟเวอร์บน Render: สมัครบัญชีผู้ใช้ใหม่ใน ThingsBoard ให้อัตโนมัติ
```

- **โหมดอัตโนมัติ (AUTO):** บอร์ดตรวจค่าทุก 5 นาที ถ้า pH หรือ EC หลุดช่วงที่ตั้งไว้ จะเปิดปั๊มน้ำวน จ่ายสารทีละตัว ตัวละ 2 วินาที แล้วผสม 5 นาทีก่อนตรวจซ้ำ
- **ความปลอดภัย:** ปั๊มเคมีมีเวลาเปิดสูงสุด 10 วินาที, ปั๊มหลักไม่เปิดเมื่อถังน้ำต่ำ, ผู้ใช้แต่ละคนเห็นเฉพาะบอร์ดของตัวเอง
- **ไม่มีค่าปลอม:** ถ้าบอร์ดไม่ส่งค่า แอปแสดง `--` และสถานะออฟไลน์ ส่วนบอร์ดทดลองที่ใช้ค่าจำลองจะส่ง `sim:true` และแอปติดป้ายบอกชัดเจน

## โครงสร้างโฟลเดอร์

| โฟลเดอร์ | เนื้อหา |
| --- | --- |
| [Application](Application) | แอปมือถือ React + TypeScript + Capacitor (`src/`, `android/`, `ios/`) และ Firebase rules |
| [firmware](firmware) | [smart_water_farm_esp32](firmware/smart_water_farm_esp32) เฟิร์มแวร์บอร์ด ESP32-S3 (Arduino) — คัดลอก `secrets.example.h` เป็น `secrets.h` แล้วใส่ token ของบอร์ด และ [Schematic_Hydroponic.pdf](firmware/Schematic_Hydroponic.pdf) วงจรของบอร์ด |
| [server](server) | เซิร์ฟเวอร์ Node.js บน Render สำหรับสมัครบัญชี |
| [docs](docs) | หน้าดาวน์โหลดแอป (GitHub Pages) และไฟล์ APK |

## Build แอปเอง

```bash
cd Application
npm install
npm run build          # web assets
npx cap sync android   # แล้ว build APK ใน Android Studio
```
