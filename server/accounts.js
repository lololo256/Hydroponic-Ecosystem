/**
 * Account sign-up ONLY (the middle server never logs users in and never issues sessions).
 *
 *   POST /api/account/signup         { email, password, firstName? }     -> { success: true, email }
 *   POST /api/account/signup/google  { idToken, password, firstName? }   -> { success: true, email }
 *
 * The server uses its tenant-admin login (Render env) to create, in ThingsBoard Cloud:
 *   - a Customer titled with the user's e-mail (one customer per person -> users never see each other's devices)
 *   - a CUSTOMER_USER in that customer, activated with the password the user chose.
 * The app then logs in DIRECTLY to ThingsBoard (/api/auth/login) with that e-mail + password.
 * "Google" sign-up only proves the e-mail address belongs to the user; the account still uses a password.
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const DEFAULT_GOOGLE_CLIENT_IDS = ['175572736060-u745g13ng16ovfh2sm0rcs875koh1kun.apps.googleusercontent.com'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

class AccountError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function extractActivateToken(link) {
  const s = typeof link === 'string' ? link : link?.value || link?.activationLink || '';
  const m = /activateToken=([^&\s"]+)/.exec(s);
  if (!m) throw new AccountError(502, 'ACTIVATION_LINK_INVALID', 'ThingsBoard did not return an activation link');
  return decodeURIComponent(m[1]);
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
    throw new AccountError(400, 'WEAK_PASSWORD', 'Password must be 8-72 characters');
  }
}

function cleanName(firstName, fallback) {
  const n = typeof firstName === 'string' ? firstName.trim().slice(0, 60) : '';
  return n || fallback;
}

/**
 * @param {object} deps
 * @param {(method:string, path:string, opts?:{params?:object,data?:any}) => Promise<any>} deps.tb  tenant-admin ThingsBoard call
 * @param {(method:string, path:string, opts?:{params?:object,data?:any}) => Promise<any>} deps.tbNoAuth  unauthenticated ThingsBoard call
 * @param {(idToken:string) => Promise<object>} deps.fetchGoogleTokenInfo  Google tokeninfo lookup
 * @param {string[]} [deps.googleClientIds]
 */
/** Tags a ThingsBoard failure with the step it happened in, so the app/logs can say where it broke. */
async function step(name, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && typeof err === 'object' && !err.stage) err.stage = name;
    throw err;
  }
}

function createAccountService({ tb, tbNoAuth, fetchGoogleTokenInfo, googleClientIds = DEFAULT_GOOGLE_CLIENT_IDS }) {
  async function verifyGoogleIdToken(idToken) {
    if (!idToken || typeof idToken !== 'string' || idToken.length > 4096) {
      throw new AccountError(400, 'INVALID_INPUT', 'idToken is required');
    }
    let info;
    try {
      info = await fetchGoogleTokenInfo(idToken);
    } catch (_) {
      throw new AccountError(401, 'GOOGLE_TOKEN_INVALID', 'Google rejected the sign-in token');
    }
    if (!info || !googleClientIds.includes(info.aud)) {
      throw new AccountError(401, 'GOOGLE_AUDIENCE_MISMATCH', 'Google token was issued for a different app');
    }
    if (!(info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com')) {
      throw new AccountError(401, 'GOOGLE_TOKEN_INVALID', 'Unexpected token issuer');
    }
    if (Number(info.exp) * 1000 < Date.now()) {
      throw new AccountError(401, 'GOOGLE_TOKEN_EXPIRED', 'Google sign-in token expired');
    }
    const email = normalizeEmail(info.email);
    if (!(info.email_verified === true || info.email_verified === 'true') || !EMAIL_RE.test(email)) {
      throw new AccountError(401, 'GOOGLE_EMAIL_UNVERIFIED', 'Google account e-mail is not verified');
    }
    return { email, firstName: info.given_name || info.name || '', lastName: info.family_name || '' };
  }

  async function findCustomer(title) {
    try {
      const c = await tb('get', '/api/tenant/customers', { params: { customerTitle: title } });
      return c && c.id ? c : null;
    } catch (err) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  }

  async function findCustomerAdminGroupId(customerId) {
    try {
      const groups = await tb('get', `/api/entityGroups/CUSTOMER/${customerId}/USER`);
      const list = Array.isArray(groups) ? groups : groups?.data || [];
      const g =
        list.find((x) => /customer administrators/i.test(x.name || '')) ||
        list.find((x) => /customer users/i.test(x.name || ''));
      return g?.id?.id || null;
    } catch (_) {
      return null; // ThingsBoard CE has no entity groups; a plain CUSTOMER_USER is fine there
    }
  }

  /** Creates customer + user and activates it with the user's password. Duplicate e-mail -> 409. */
  async function createAccount({ email, password, firstName, lastName }) {
    let customer = await step('find_customer', () => findCustomer(email));
    let createdCustomer = false;
    if (!customer) {
      customer = await step('create_customer', () => tb('post', '/api/customer', { data: { title: email, email } }));
      createdCustomer = true;
    }
    const removeOrphanCustomer = async () => {
      if (!createdCustomer) return;
      try {
        await tb('delete', `/api/customer/${customer.id.id}`);
      } catch (_) {
        /* best effort */
      }
    };
    const groupId = await findCustomerAdminGroupId(customer.id.id);
    const params = { sendActivationMail: false };
    if (groupId) params.entityGroupId = groupId;

    let user;
    try {
      user = await step('create_user', () => tb('post', '/api/user', {
        params,
        data: {
          email,
          authority: 'CUSTOMER_USER',
          customerId: { entityType: 'CUSTOMER', id: customer.id.id },
          firstName: cleanName(firstName, email.split('@')[0]),
          lastName: lastName || '',
        },
      }));
    } catch (err) {
      await removeOrphanCustomer();
      const msg = String(err?.response?.data?.message || '');
      if (err?.response?.status === 400 && /already|exist|duplicate|in use/i.test(msg)) {
        throw new AccountError(409, 'EMAIL_EXISTS', 'An account with this e-mail already exists');
      }
      throw err;
    }

    try {
      const link = await step('activation_link', () => tb('get', `/api/user/${user.id.id}/activationLink`));
      const activateToken = extractActivateToken(link);
      // ThingsBoard answers with a session for the new user; the middle server deliberately discards it.
      await step('activate', () =>
        tbNoAuth('post', '/api/noauth/activate', {
          params: { sendActivationMail: false },
          data: { activateToken, password },
        })
      );
    } catch (err) {
      // Do not leave a half-created, unusable account behind (the e-mail would be blocked forever).
      try {
        await tb('delete', `/api/user/${user.id.id}`);
      } catch (_) {
        /* best effort */
      }
      await removeOrphanCustomer();
      throw err;
    }
    return { success: true, email };
  }

  async function signUpWithEmail({ email, password, firstName }) {
    const cleanEmail = normalizeEmail(email);
    if (!EMAIL_RE.test(cleanEmail)) throw new AccountError(400, 'INVALID_EMAIL', 'Invalid e-mail address');
    validatePassword(password);
    return createAccount({ email: cleanEmail, password, firstName });
  }

  async function signUpWithGoogle({ idToken, password, firstName }) {
    validatePassword(password);
    const profile = await verifyGoogleIdToken(idToken);
    return createAccount({
      email: profile.email,
      password,
      firstName: cleanName(firstName, profile.firstName),
      lastName: profile.lastName,
    });
  }

  return { signUpWithEmail, signUpWithGoogle, verifyGoogleIdToken };
}

function sendError(res, err) {
  if (err instanceof AccountError) return res.status(err.status).json({ error: err.code });
  const tbStatus = err?.response?.status;
  const tbMsg = String(err?.response?.data?.message || '');
  if (tbStatus === 400 && /password/i.test(tbMsg)) return res.status(400).json({ error: 'WEAK_PASSWORD' });
  const stage = err?.stage || 'unknown';
  console.error('[accounts] ThingsBoard error:', stage, tbStatus, tbMsg || err?.message);
  // Step + HTTP status only (no ThingsBoard message text) so the app can show where it failed.
  return res.status(502).json({ error: 'THINGSBOARD_ERROR', stage, tbStatus: tbStatus || null, detail: String(err?.message || '').startsWith('TB_2FA') ? 'TB_2FA_ENABLED' : undefined });
}

function createAccountRouter(service, { maxPerWindow = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const router = express.Router();
  router.use(rateLimit({ windowMs, max: maxPerWindow, standardHeaders: true, legacyHeaders: false }));

  router.post('/signup', async (req, res) => {
    try {
      res.json(await service.signUpWithEmail(req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/signup/google', async (req, res) => {
    try {
      res.json(await service.signUpWithGoogle(req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

module.exports = { createAccountService, createAccountRouter, AccountError, extractActivateToken };
