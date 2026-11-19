const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.database();

/**
 * Cloud Function: claimDevice
 * รับ { deviceId, claimCode }
 * 1. ต้องล็อกอินอยู่ ไม่งั้นปฏิเสธ
 * 2. เทียบ claimCode กับ deviceSecrets (ใช้ Admin SDK)
 * 3. ใช้ transaction เปลี่ยน status เป็น "claimed" และใส่ ownerUid ได้ก็ต่อเมื่อ
 *    status ยังเป็น "unclaimed" (กันสองคนผูกพร้อมกัน)
 * 4. เขียน users/{uid}/devices/{deviceId} = true ใน operation เดียวกัน
 * 5. ถ้ารหัสผิด ให้นับจำนวนครั้ง ถ้าผิดเกิน 5 ครั้งใน 10 นาที
 *    ให้ล็อกชั่วคราว (กันเดารหัส)
 * 6. ส่งผลกลับเป็นข้อความไทยที่ผู้ใช้เข้าใจ เช่น "รหัสไม่ถูกต้อง"
 *    "อุปกรณ์นี้มีเจ้าของแล้ว" "ผูกอุปกรณ์สำเร็จ"
 * 7. ห้ามส่ง claimCode กลับไปที่แอปเด็ดขาด
 */
exports.claimDevice = onCall(
  { region: "asia-southeast1", cors: true },
  async (request) => {
    // 1. ต้องล็อกอินอยู่ ไม่งั้นปฏิเสธ
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError(
        "unauthenticated",
        "กรุณาเข้าสู่ระบบก่อนทำการผูกอุปกรณ์"
      );
    }

    const uid = request.auth.uid;
    const { deviceId, claimCode } = request.data || {};

    if (!deviceId || typeof deviceId !== "string" || !claimCode || typeof claimCode !== "string") {
      throw new HttpsError(
        "invalid-argument",
        "กรุณาระบุรหัสอุปกรณ์และรหัสยืนยัน 6 หลักให้ครบถ้วน"
      );
    }

    const cleanDeviceId = deviceId.trim().toUpperCase();
    const cleanClaimCode = claimCode.trim();

    const now = Date.now();
    const TEN_MINUTES_MS = 10 * 60 * 1000;
    const rateLimitRef = db.ref(`rateLimits/claimDevice/${uid}`);

    // 2. ตรวจสอบ Rate Limit (ผิดเกิน 5 ครั้งใน 10 นาที)
    const rateSnap = await rateLimitRef.once("value");
    const rateData = rateSnap.val() || {};
    const { failedCount = 0, firstFailedAt = 0, lockedUntil = 0 } = rateData;

    if (lockedUntil && now < lockedUntil) {
      const waitMinutes = Math.ceil((lockedUntil - now) / 60000);
      return {
        success: false,
        message: `คุณกรอกรหัสผิดเกินกำหนด กรุณารอสักครู่แล้วลองใหม่ในอีก ${waitMinutes} นาที`
      };
    }

    // ฟังก์ชันช่วยนับจำนวนครั้งที่กรอกผิด
    const recordFailure = async (customMessage) => {
      let newCount = failedCount + 1;
      let newFirstFailedAt = firstFailedAt;

      // ถ้ารอบ 10 นาทีเดิมหมดเวลาแล้ว ให้เริ่มนับใหม่
      if (!firstFailedAt || now - firstFailedAt > TEN_MINUTES_MS) {
        newCount = 1;
        newFirstFailedAt = now;
      }

      let newLockedUntil = 0;
      if (newCount >= 5) {
        newLockedUntil = now + TEN_MINUTES_MS;
      }

      await rateLimitRef.set({
        failedCount: newCount,
        firstFailedAt: newFirstFailedAt,
        lastFailedAt: now,
        lockedUntil: newLockedUntil
      });

      if (newCount >= 5) {
        return {
          success: false,
          message: "คุณกรอกรหัสผิดเกิน 5 ครั้ง ระบบระงับการลองชั่วคราว 10 นาที"
        };
      }

      const remaining = 5 - newCount;
      return {
        success: false,
        message: `${customMessage} (เหลือโอกาสลองอีก ${remaining} ครั้ง)`
      };
    };

    // 3. ตรวจสอบว่ามีข้อมูลความลับ deviceSecrets หรือไม่
    const secretRef = db.ref(`deviceSecrets/${cleanDeviceId}/claimCode`);
    const secretSnap = await secretRef.once("value");

    if (!secretSnap.exists()) {
      return await recordFailure("ไม่พบอุปกรณ์นี้ในระบบ กรุณาตรวจสอบรหัสอุปกรณ์");
    }

    const expectedCode = String(secretSnap.val()).trim();
    if (expectedCode !== cleanClaimCode) {
      return await recordFailure("รหัสไม่ถูกต้อง");
    }

    // 4. ใช้ Transaction เปลี่ยน status เป็น "claimed" และใส่ ownerUid ได้ก็ต่อเมื่อ status ยังเป็น "unclaimed"
    const deviceRef = db.ref(`devices/${cleanDeviceId}`);
    let alreadyClaimed = false;
    let notFound = false;

    const txnResult = await deviceRef.transaction((current) => {
      if (current === null) {
        notFound = true;
        return; // ยกเลิก transaction
      }
      if (current.status === "claimed") {
        alreadyClaimed = true;
        return; // ยกเลิก transaction ไม่ให้ผูกซ้ำ
      }

      // เปลี่ยนสถานะเป็น claimed และบันทึก ownerUid
      return {
        ...current,
        status: "claimed",
        ownerUid: uid,
        claimedAt: admin.database.ServerValue.TIMESTAMP
      };
    });

    if (!txnResult.committed) {
      if (notFound) {
        return { success: false, message: "ไม่พบอุปกรณ์นี้ในระบบ" };
      }
      if (alreadyClaimed) {
        // ตรวจสอบว่าเป็นของตัวเองอยู่แล้วหรือไม่
        const currentDevSnap = await deviceRef.once("value");
        const devVal = currentDevSnap.val();
        if (devVal && devVal.ownerUid === uid) {
          return {
            success: true,
            message: "อุปกรณ์นี้ผูกกับบัญชีของคุณอยู่แล้ว",
            deviceId: cleanDeviceId
          };
        }
        return { success: false, message: "อุปกรณ์นี้มีเจ้าของแล้ว" };
      }
      return { success: false, message: "เกิดข้อผิดพลาดในการผูกอุปกรณ์ กรุณาลองใหม่อีกครั้ง" };
    }

    // 5. เขียน users/{uid}/devices/{deviceId} = true ใน operation เดียวกัน
    const updates = {};
    updates[`users/${uid}/devices/${cleanDeviceId}`] = true;
    updates[`users/${uid}/connectedBoardId`] = cleanDeviceId;
    updates[`users/${uid}/savedBoards/${cleanDeviceId}`] = {
      name: `Hydroponic ${cleanDeviceId}`,
      addedAt: now
    };
    updates[`boards/${cleanDeviceId}/ownerUid`] = uid;
    updates[`boards/${cleanDeviceId}/boundAt`] = now;
    // เคลียร์ rate limit หลังทำรายการสำเร็จ
    updates[`rateLimits/claimDevice/${uid}`] = null;

    await db.ref().update(updates);

    // 6. ส่งผลกลับเป็นข้อความไทยที่ผู้ใช้เข้าใจ (ห้ามส่ง claimCode กลับไปเด็ดขาด)
    return {
      success: true,
      message: "ผูกอุปกรณ์สำเร็จ",
      deviceId: cleanDeviceId
    };
  }
);

