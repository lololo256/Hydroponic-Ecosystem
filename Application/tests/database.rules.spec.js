/**
 * Firebase Realtime Database Security Rules Unit Tests
 * ตรวจสอบความปลอดภัยตามเกณฑ์ตรวจรับ ข้อ 0.3 (ระดับ 0)
 *
 * รันด้วย: npx mocha tests/database.rules.spec.js (เมื่อเปิด firebase emulators:exec)
 */

const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'smart-water-farm-test';
let testEnv;

describe('Firebase Security Rules - Section 0.3 Verification', () => {
  before(async () => {
    const rules = fs.readFileSync(path.resolve(__dirname, '../database.rules.json'), 'utf8');
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      database: {
        rules: rules,
        host: '127.0.0.1',
        port: 9000
      }
    });
  });

  beforeEach(async () => {
    await testEnv.clearDatabase();
    // Seed test data via admin context
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.database();
      await db.ref('boards/FARM-A').set({
        ownerUid: 'user_a',
        plantType: 'Green Oak',
        plantingStartDate: 1730000000000,
        current: { pH: 6.2, ec: 1.5 }
      });
      await db.ref('devices/FARM-A').set({
        ownerUid: 'user_a',
        status: 'claimed'
      });
      await db.ref('deviceSecrets/FARM-A').set({
        claimCode: '123456'
      });
      await db.ref('users/user_a').set({
        profile: { name: 'User A', email: 'user_a@test.com' }
      });
      await db.ref('users/user_b').set({
        profile: { name: 'User B', email: 'user_b@test.com' }
      });
    });
  });

  after(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  // กรณีที่ 1: ไม่ล็อกอิน อ่านอะไรไม่ได้ (Deny by default)
  it('Case 1: Unauthenticated user cannot read any data', async () => {
    const unauthedDb = testEnv.unauthenticatedContext().database();
    await assertFails(unauthedDb.ref('boards/FARM-A').get());
    await assertFails(unauthedDb.ref('users/user_a').get());
    await assertFails(unauthedDb.ref('devices/FARM-A').get());
    await assertFails(unauthedDb.ref('deviceSecrets/FARM-A').get());
  });

  // กรณีที่ 2: ผู้ใช้ B อ่านอุปกรณ์ของ A ไม่ได้
  it('Case 2: User B cannot read board of User A', async () => {
    const userBDb = testEnv.authenticatedContext('user_b').database();
    await assertFails(userBDb.ref('boards/FARM-A').get());
    await assertFails(userBDb.ref('devices/FARM-A').get());
  });

  // กรณีที่ 3: ผู้ใช้เขียน ownerUid ไม่ได้ (แม้เป็นอุปกรณ์ของตนเอง)
  it('Case 3: User A cannot change ownerUid of the board', async () => {
    const userADb = testEnv.authenticatedContext('user_a').database();
    await assertFails(userADb.ref('boards/FARM-A').update({ ownerUid: 'user_hacker' }));
  });

  // กรณีที่ 4: ผู้ใช้เขียน startDate หรือค่าการปลูกของอุปกรณ์ตัวเองได้
  it('Case 4: User A can write plantingStartDate on own board', async () => {
    const userADb = testEnv.authenticatedContext('user_a').database();
    await assertSucceeds(userADb.ref('boards/FARM-A').update({
      plantingStartDate: 1731000000000,
      plantType: 'Red Oak'
    }));
  });

  // กรณีที่ 5: ผู้ใช้เขียน startDate ของอุปกรณ์คนอื่นไม่ได้
  it('Case 5: User B cannot write plantingStartDate on User A board', async () => {
    const userBDb = testEnv.authenticatedContext('user_b').database();
    await assertFails(userBDb.ref('boards/FARM-A').update({
      plantingStartDate: 1739999999999
    }));
  });

  // กรณีเสริม: ผู้ใช้ไม่สามารถอ่าน deviceSecrets ได้โดยเด็ดขาด
  it('Case 6: No authenticated client can read deviceSecrets', async () => {
    const userADb = testEnv.authenticatedContext('user_a').database();
    await assertFails(userADb.ref('deviceSecrets/FARM-A').get());
  });
});

