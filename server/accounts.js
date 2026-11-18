/**
 * Account sign-up ONLY (the middle server never logs users in and never issues sessions).
 *
 *   POST /api/account/signup         { email, password, firstName? }     -> { success: true, email }
 *   POST /api/account/signup/google  { idToken, password, firstName? }   -> { success: true, email }
 *
 * The server uses its tenant-admin login (Render env) to create, in ThingsBoard Cloud, a CUSTOMER_USER
 * inside ONE existing shared customer (SIGNUP_CUSTOMER_TITLE, default "Hydroponic"), activated with the
 * password the user chose. (ThingsBoard Cloud Free plan: max 2 customers / 5 users, so a customer per
 * person is not possible; members of the shared customer see the same devices.)
 * The app then logs in DIRECTLY to ThingsBoard (/api/auth/login) with that e-mail + password.
 * "Google" sign-up only proves the e-mail address belongs to the user; the account still uses a password.
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const DEFAULT_GOOGLE_CLIENT_IDS = ['175572736060-u745g13ng16ovfh2sm0rcs875koh1kun.apps.googleusercontent.com'];
const DEFAULT_SIGNUP_CUSTOMER = 'Hydroponic';
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
 * @param {string} [deps.sharedCustomerTitle]  existing customer every new user joins (Free plan limit)
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

function createAccountService({
  tb,
  tbNoAuth,
  fetchGoogleTokenInfo,
  googleClientIds = DEFAULT_GOOGLE_CLIENT_IDS,
  sharedCustomerTitle = DEFAULT_SIGNUP_CUSTOMER,
}) {
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

  /** User groups of the shared customer (ThingsBoard PE). Returns [] on CE, where groups do not exist. */
  async function listCustomerUserGroups(customerId) {
    try {
      const groups = await tb('get', `/api/entityGroups/CUSTOMER/${customerId}/USER`);
      return Array.isArray(groups) ? groups : groups?.data || [];
    } catch (_) {
      return [];
    }
  }

  /**
   * Picks the user group for a new member: the same group an existing member of the customer is in
   * (so new users get exactly the permissions that already work, e.g. claiming devices), otherwise
   * "Customer Users". Never "All" and never "Customer Administrators" (a shared customer must not
   * let members manage each other).
   */
  async function pickUserGroupId(customerId) {
    const groups = await listCustomerUserGroups(customerId);
    if (!groups.length) return null;
    const usable = groups.filter((g) => !/^all$/i.test(g.name || '') && !/administrators/i.test(g.name || ''));
    try {
      const members = await tb('get', `/api/customer/${customerId}/users`, { params: { pageSize: 1, page: 0 } });
      const existing = members?.data?.[0];
      if (existing?.id?.id) {
        const memberOf = await tb('get', `/api/entityGroups/USER/${existing.id.id}`);
        const ids = (Array.isArray(memberOf) ? memberOf : []).map((g) => g?.id || g?.id?.id || g);
        const match = usable.find((g) => ids.includes(g.id?.id));
        if (match) return match.id.id;
      }
    } catch (_) {
      /* fall back to the default group below */
    }
    return (usable.find((g) => /customer users/i.test(g.name || '')) || usable[0])?.id?.id || null;
  }

  /**
   * Creates the user inside the shared customer and activates it with the user's password.
   * ThingsBoard Cloud's Free plan allows only 2 customers / 5 users, so every self-registered user
   * joins ONE existing customer (SIGNUP_CUSTOMER_TITLE, default "Hydroponic") instead of getting their own.
   */
  async function createAccount({ email, password, firstName, lastName }) {
    const customer = await step('find_customer', () => findCustomer(sharedCustomerTitle));
    if (!customer) {
      throw Object.assign(new AccountError(500, 'SIGNUP_CUSTOMER_MISSING', `Customer "${sharedCustomerTitle}" not found`), {
        stage: 'find_customer',
      });
    }
    const groupId = await step('find_group', () => pickUserGroupId(customer.id.id));
    const params = { sendActivationMail: false };
    if (groupId) params.entityGroupId = groupId;

    let user;
    try {
      user = await step('create_user', () =>
        tb('post', '/api/user', {
          params,
          data: {
            email,
            authority: 'CUSTOMER_USER',
            customerId: { entityType: 'CUSTOMER', id: customer.id.id },
            firstName: cleanName(firstName, email.split('@')[0]),
            lastName: lastName || '',
          },
        })
      );
    } catch (err) {
      const status = err?.response?.status;
      const msg = String(err?.response?.data?.message || '');
      if (status === 400 && /already|exist|duplicate|in use/i.test(msg)) {
        throw new AccountError(409, 'EMAIL_EXISTS', 'An account with this e-mail already exists');
      }
      if (status === 403 && !/permission|authority|not allowed to perform/i.test(msg)) {
        // Plan limit (Free plan: 5 users) — ThingsBoard rejects new users with 403.
        throw new AccountError(403, 'USER_LIMIT_REACHED', 'ThingsBoard plan user limit reached');
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
  if (err instanceof AccountError) {
    if (err.status >= 500) console.error('[accounts] config error:', err.code, err.message);
    return res.status(err.status).json({ error: err.code });
  }
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
