/**
 * Account sign-up ONLY (the middle server never logs users in and never issues sessions).
 *
 *   POST /api/account/signup         { email, password, firstName? }     -> { success: true, email }
 *   POST /api/account/signup/google  { idToken, password, firstName? }   -> { success: true, email }
 *
 * The server uses its tenant-admin login (Render env) to create, in ThingsBoard Cloud, a CUSTOMER_USER
 * inside ONE existing shared customer (SIGNUP_CUSTOMER_TITLE, default "Hydroponic", because the Free plan
 * allows only 2 customers / 5 users), puts the user in a private user group that can only see the
 * device group "Devices <email>" (roles "Farm Member" + "Farm Device Owner"), and activates the account
 * with the password the user chose. A Root Rule Chain step moves a device into its owner's group when
 * the app writes the shared attribute bind_owner.
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
  memberRoleName = 'Farm Member',
  ownerRoleName = 'Farm Device Owner',
  alertChainName = 'Farm Alerts',
  pushTemplateName = 'Farm alert (push)',
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

  async function listGroups(customerId, type) {
    const groups = await tb('get', `/api/entityGroups/CUSTOMER/${customerId}/${type}`);
    return Array.isArray(groups) ? groups : groups?.data || [];
  }

  async function ensureGroup(customerId, name, type) {
    const existing = (await listGroups(customerId, type)).find((g) => g.name === name);
    if (existing) return existing;
    return tb('post', '/api/entityGroup', { data: { name, type, ownerId: { entityType: 'CUSTOMER', id: customerId } } });
  }

  let roleCache = null;
  async function findRoles() {
    if (roleCache) return roleCache;
    const page = await tb('get', '/api/roles', { params: { pageSize: 100, page: 0 } });
    const list = page?.data || [];
    const member = list.find((r) => r.name === memberRoleName);
    const owner = list.find((r) => r.name === ownerRoleName);
    if (!member || !owner) {
      throw Object.assign(
        new AccountError(500, 'SIGNUP_ROLES_MISSING', `Roles "${memberRoleName}" / "${ownerRoleName}" not found`),
        { stage: 'find_roles' }
      );
    }
    roleCache = { member, owner };
    return roleCache;
  }

  /**
   * Per-user privacy inside the shared customer (ThingsBoard PE RBAC, works on the Free plan):
   *   user group  "Users <email>"   -> generic role "Farm Member" (claim devices, set bind_owner, read alarms)
   *                                 -> group role "Farm Device Owner" on device group "Devices <email>"
   * The Root Rule Chain moves a device into "Devices <bind_owner>" when the app writes bind_owner,
   * so each user sees and controls only their own devices.
   */
  async function setUpPrivateGroups(customerId, email, userId) {
    const { member, owner } = await step('find_roles', () => findRoles());
    const userGroup = await step('user_group', () => ensureGroup(customerId, `Users ${email}`, 'USER'));
    const deviceGroup = await step('device_group', () => ensureGroup(customerId, `Devices ${email}`, 'DEVICE'));
    const perms = await step('permissions', () => tb('get', `/api/userGroup/${userGroup.id.id}/groupPermissions`));
    const has = (roleId, groupId) =>
      (Array.isArray(perms) ? perms : []).some(
        (p) => (p.roleId?.id || p.role?.id?.id) === roleId && (p.entityGroupId?.id || null) === groupId
      );
    if (!has(member.id.id, null)) {
      await step('permissions', () => tb('post', '/api/groupPermission', { data: { roleId: member.id, userGroupId: userGroup.id } }));
    }
    if (!has(owner.id.id, deviceGroup.id.id)) {
      await step('permissions', () =>
        tb('post', '/api/groupPermission', {
          data: { roleId: owner.id, userGroupId: userGroup.id, entityGroupId: deviceGroup.id, entityGroupType: 'DEVICE' },
        })
      );
    }
    await step('join_group', () => tb('post', `/api/entityGroup/${userGroup.id.id}/addEntities`, { data: [userId] }));
    await setUpPush(email, userGroup.id.id);
  }

  /**
   * Push notifications for the new owner (non-fatal: sign-up still succeeds if this fails).
   * Rule chain "Farm Alerts" routes each alarm by the device's bind_owner (switch relation = e-mail)
   * to a "send notification" node whose target is ONLY this user's group, so nobody receives
   * another user's alerts. Creates: target "Farm push <email>" + node "[Push] <email>" + connection.
   */
  async function setUpPush(email, userGroupId) {
    try {
      const tplPage = await tb('get', '/api/notification/templates', {
        params: { pageSize: 50, page: 0, textSearch: pushTemplateName, notificationTypes: 'RULE_NODE' },
      });
      const tpl = (tplPage?.data || []).find((t) => t.name === pushTemplateName);
      const chains = await tb('get', '/api/ruleChains', { params: { pageSize: 50, page: 0, textSearch: alertChainName } });
      const chain = (chains?.data || []).find((c) => c.name === alertChainName);
      if (!tpl || !chain) {
        console.warn('[accounts] push setup skipped: template or rule chain not found');
        return;
      }

      const targetName = `Farm push ${email}`;
      const tPage = await tb('get', '/api/notification/targets', { params: { pageSize: 50, page: 0, textSearch: targetName } });
      let target = (tPage?.data || []).find((t) => t.name === targetName);
      if (!target) {
        target = await tb('post', '/api/notification/target', {
          data: {
            name: targetName,
            configuration: {
              type: 'PLATFORM_USERS',
              description: `Farm alerts for the owner ${email}`,
              usersFilter: { type: 'USER_GROUP_LIST', groupsIds: [userGroupId] },
            },
          },
        });
      }

      const md = await tb('get', `/api/ruleChain/${chain.id.id}/metadata`);
      const nodeName = `[Push] ${email}`;
      if ((md.nodes || []).some((n) => n.name === nodeName)) return;
      const routerIndex = (md.nodes || []).findIndex((n) => n.name === '[Alert] route to owner');
      if (routerIndex < 0) {
        console.warn('[accounts] push setup skipped: router node not found');
        return;
      }
      const pushCount = md.nodes.filter((n) => String(n.name).startsWith('[Push] ')).length;
      md.nodes.push({
        type: 'org.thingsboard.rule.engine.notification.TbNotificationNode',
        name: nodeName,
        debugSettings: null,
        singletonMode: false,
        configurationVersion: 0,
        configuration: { templateId: tpl.id.id, targets: [target.id.id] },
        additionalInfo: { layoutX: 1800, layoutY: 40 + pushCount * 90, description: 'Smart Water Farm alerts' },
      });
      md.connections = md.connections || [];
      md.connections.push({ fromIndex: routerIndex, toIndex: md.nodes.length - 1, type: email });
      await tb('post', '/api/ruleChain/metadata', { data: md });
    } catch (err) {
      console.warn('[accounts] push setup notice:', err?.response?.status || '', err?.message || err);
    }
  }

  /**
   * Creates the user inside the shared customer (ThingsBoard Cloud Free plan: max 2 customers / 5 users,
   * so every self-registered user joins ONE existing customer, SIGNUP_CUSTOMER_TITLE, default "Hydroponic"),
   * gives the user private groups/permissions, and activates it with the user's password.
   */
  async function createAccount({ email, password, firstName, lastName }) {
    const customer = await step('find_customer', () => findCustomer(sharedCustomerTitle));
    if (!customer) {
      throw Object.assign(new AccountError(500, 'SIGNUP_CUSTOMER_MISSING', `Customer "${sharedCustomerTitle}" not found`), {
        stage: 'find_customer',
      });
    }
    await findRoles(); // fail early (before creating anything) if the roles are not configured
    const params = { sendActivationMail: false };

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
      await setUpPrivateGroups(customer.id.id, email, user.id.id);
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
