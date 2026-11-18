/**
 * Hydroponic middle server (Render) — ACCOUNT SIGN-UP ONLY.
 *
 * Per the project requirement, this server does exactly one job: create user accounts in
 * ThingsBoard Cloud (see accounts.js). It does not log users in, does not proxy telemetry,
 * does not send device commands and stores no farm data. The mobile app logs in and talks to
 * ThingsBoard directly.
 *
 * Environment (Render):
 *   THINGSBOARD_URL       default https://eu.thingsboard.cloud
 *   THINGSBOARD_USERNAME  tenant administrator e-mail (2FA must be off)
 *   THINGSBOARD_PASSWORD  tenant administrator password
 *   GOOGLE_CLIENT_IDS     optional, comma separated Google OAuth client IDs accepted for Google sign-up
 *   ALLOWED_ORIGINS       optional, extra CORS origins (comma separated)
 *   SIGNUP_CUSTOMER_TITLE optional, existing customer new users join (default "Hydroponic")
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const { createAccountService, createAccountRouter } = require('./accounts');

const PORT = process.env.PORT || 3000;
const TB_URL = (process.env.THINGSBOARD_URL || 'https://eu.thingsboard.cloud').replace(/\/$/, '');
const TB_USERNAME = process.env.THINGSBOARD_USERNAME;
const TB_PASSWORD = process.env.THINGSBOARD_PASSWORD;

if (!TB_USERNAME || !TB_PASSWORD) {
  console.warn('หมายเหตุ: ยังไม่ได้ตั้งค่า THINGSBOARD_USERNAME / THINGSBOARD_PASSWORD — สมัครสมาชิกจะใช้งานไม่ได้');
}

// ==========================================
// ThingsBoard tenant-admin client (used only to create accounts)
// ==========================================
let tbJwt = null;
let tbJwtExpireAt = 0;
let loginInFlight = null;

async function tbHeaders(force = false) {
  if (!force && tbJwt && Date.now() < tbJwtExpireAt) {
    return { 'X-Authorization': `Bearer ${tbJwt}` };
  }
  loginInFlight ??= axios
    .post(`${TB_URL}/api/auth/login`, { username: TB_USERNAME, password: TB_PASSWORD }, { timeout: 15000 })
    .finally(() => {
      loginInFlight = null;
    });
  let r;
  try {
    r = await loginInFlight;
  } catch (err) {
    err.stage = 'admin_login';
    throw err;
  }
  if (r.data?.scope === 'PRE_VERIFICATION_TOKEN') {
    throw Object.assign(new Error('TB_2FA_ENABLED: turn off two-factor authentication for the server account'), { stage: 'admin_login' });
  }
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

async function tbNoAuth(method, path, { params, data } = {}) {
  const r = await axios({ method, url: `${TB_URL}${path}`, params, data, timeout: 20000 });
  return r.data;
}

async function fetchGoogleTokenInfo(idToken) {
  const r = await axios.get('https://oauth2.googleapis.com/tokeninfo', { params: { id_token: idToken }, timeout: 10000 });
  return r.data;
}

// ==========================================
// HTTP app
// ==========================================
const app = express();
app.set('trust proxy', 1);
app.use(helmet());

const allowedOrigins = new Set(
  ['capacitor://localhost', 'https://localhost', 'http://localhost', 'ionic://localhost']
    .concat((process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()))
    .filter(Boolean)
);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.has(origin)) return cb(null, true);
      try {
        const host = new URL(origin).hostname;
        if (host === 'localhost' || host === '127.0.0.1') return cb(null, true);
      } catch (_) {
        /* invalid origin */
      }
      return cb(new Error('CORS_BLOCKED'));
    },
  })
);
app.use(express.json({ limit: '10kb' }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }));

// Health check / keep-alive target (cron-job.org can ping this; no secret needed).
// /api/health?deep=1 also checks that the tenant-admin login to ThingsBoard works (reports only ok / HTTP status).
app.get(['/', '/api/health'], async (req, res) => {
  const body = { ok: true, service: 'hydroponic-signup', time: new Date().toISOString() };
  if (req.query.deep === '1') {
    body.config = { tbUrl: TB_URL, hasUsername: Boolean(TB_USERNAME), hasPassword: Boolean(TB_PASSWORD) };
    try {
      await tbHeaders(true);
      body.tbAdminLogin = 'ok';
    } catch (err) {
      body.ok = false;
      body.tbAdminLogin = String(err?.message || '').startsWith('TB_2FA')
        ? 'failed: 2FA enabled on the server account'
        : `failed: HTTP ${err?.response?.status || 'no response'}`;
    }
  }
  res.status(body.ok ? 200 : 503).json(body);
});

let accountService = createAccountService({
  tb,
  tbNoAuth,
  fetchGoogleTokenInfo,
  googleClientIds: process.env.GOOGLE_CLIENT_IDS
    ? process.env.GOOGLE_CLIENT_IDS.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined,
  sharedCustomerTitle: process.env.SIGNUP_CUSTOMER_TITLE || undefined,
});
app.use('/api/account', createAccountRouter({
  signUpWithEmail: (body) => accountService.signUpWithEmail(body),
  signUpWithGoogle: (body) => accountService.signUpWithGoogle(body),
}));

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.message === 'CORS_BLOCKED') return res.status(403).json({ error: 'CORS_BLOCKED' });
  console.error('[server] unexpected error:', err?.message || err);
  res.status(500).json({ error: 'SERVER_ERROR' });
});

process.on('unhandledRejection', (e) => console.error('[server] unhandledRejection:', e?.message || e));

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`Hydroponic sign-up server listening on :${PORT}`));
}

module.exports = app;
module.exports.__setAccountService = (svc) => {
  accountService = svc;
};
