const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { createAccountService, createAccountRouter, extractActivateToken } = require('../accounts');

const WEB_CLIENT = 'web-client.apps.googleusercontent.com';
const HYDRO = { id: { id: 'cust-hydro' }, title: 'Hydroponic' };
const ROLES = [
  { id: { entityType: 'ROLE', id: 'role-member' }, name: 'Farm Member', type: 'GENERIC' },
  { id: { entityType: 'ROLE', id: 'role-owner' }, name: 'Farm Device Owner', type: 'GROUP' },
];

/** In-memory fake of the ThingsBoard tenant-admin API used by accounts.js (Free plan: 5 users). */
function fakeThingsBoard({ users = [], customers = [HYDRO], userLimit = 5, roles = ROLES, push = false } = {}) {
  const state = {
    users: [...users], customers: [...customers], calls: [], activated: {},
    groups: [{ id: { id: 'grp-all-u' }, name: 'All', type: 'USER' }, { id: { id: 'grp-cu' }, name: 'Customer Users', type: 'USER' }, { id: { id: 'grp-all-d' }, name: 'All', type: 'DEVICE' }],
    permissions: [], members: {},
    targets: [],
    chainMd: push
      ? { ruleChainId: { id: 'rc-alerts' }, nodes: [{ name: '[Alert] owner + thresholds' }, { name: '[Alert] route to owner' }], connections: [] }
      : null,
  };
  let seq = 100;
  const notFound = () => Object.assign(new Error('404'), { response: { status: 404 } });

  const tb = async (method, path, { params, data } = {}) => {
    state.calls.push(`${method.toUpperCase()} ${path}`);
    if (method === 'get' && path === '/api/tenant/customers') {
      const c = state.customers.find((x) => x.title === params.customerTitle);
      if (!c) throw notFound();
      return c;
    }
    if (method === 'post' && path === '/api/customer') {
      throw Object.assign(new Error('limit'), { response: { status: 403, data: { message: 'Customers limit reached' } } });
    }
    if (method === 'get' && path === '/api/roles') return { data: roles };
    let m = /^\/api\/entityGroups\/CUSTOMER\/(.+)\/(USER|DEVICE)$/.exec(path);
    if (method === 'get' && m) return state.groups.filter((g) => g.type === m[2]);
    if (method === 'post' && path === '/api/entityGroup') {
      const g = { id: { entityType: 'ENTITY_GROUP', id: `grp-${seq++}` }, name: data.name, type: data.type, ownerId: data.ownerId };
      state.groups.push(g);
      return g;
    }
    m = /^\/api\/userGroup\/(.+)\/groupPermissions$/.exec(path);
    if (method === 'get' && m) return state.permissions.filter((p) => p.userGroupId.id === m[1]);
    if (method === 'post' && path === '/api/groupPermission') {
      const p = { id: { id: `perm-${seq++}` }, ...data };
      state.permissions.push(p);
      return p;
    }
    m = /^\/api\/entityGroup\/(.+)\/addEntities$/.exec(path);
    if (method === 'post' && m) {
      (state.members[m[1]] ||= []).push(...data);
      return null;
    }
    if (method === 'post' && path === '/api/user') {
      if (state.users.some((u) => u.email === data.email)) {
        throw Object.assign(new Error('dup'), { response: { status: 400, data: { message: 'User with email already present in database!' } } });
      }
      if (state.users.length >= userLimit) {
        throw Object.assign(new Error('limit'), { response: { status: 403, data: { message: 'Users limit reached' } } });
      }
      const u = { id: { id: `user-${seq++}` }, email: data.email, authority: data.authority, firstName: data.firstName, customerId: data.customerId };
      state.users.push(u);
      return u;
    }
    m = /^\/api\/user\/(.+)\/activationLink$/.exec(path);
    if (method === 'get' && m) return `https://eu.thingsboard.cloud/api/noauth/activate?activateToken=act-${m[1]}`;
    m = /^\/api\/user\/([^/]+)$/.exec(path);
    if (method === 'delete' && m) {
      const i = state.users.findIndex((x) => x.id.id === m[1]);
      if (i >= 0) state.users.splice(i, 1);
      return null;
    }
    if (push && method === 'get' && path === '/api/notification/templates') return { data: [{ id: { id: 'tpl-1' }, name: 'Farm alert (push)' }] };
    if (push && method === 'get' && path === '/api/ruleChains') return { data: [{ id: { id: 'rc-alerts' }, name: 'Farm Alerts' }] };
    if (push && method === 'get' && path === '/api/notification/targets') return { data: state.targets.filter((t) => t.name === params.textSearch) };
    if (push && method === 'post' && path === '/api/notification/target') {
      const t = { id: { id: `tgt-${seq++}` }, ...data };
      state.targets.push(t);
      return t;
    }
    if (push && method === 'get' && path === '/api/ruleChain/rc-alerts/metadata') return JSON.parse(JSON.stringify(state.chainMd));
    if (push && method === 'post' && path === '/api/ruleChain/metadata') {
      state.chainMd = data;
      return data;
    }
    throw new Error(`unexpected TB call ${method} ${path}`);
  };

  const tbNoAuth = async (method, path, { data } = {}) => {
    state.calls.push(`${method.toUpperCase()} ${path}`);
    assert.strictEqual(path, '/api/noauth/activate');
    state.activated[data.activateToken.replace(/^act-/, '')] = data.password;
    return { token: 'session-token', refreshToken: 'session-refresh' };
  };
  return { tb, tbNoAuth, state };
}

const google = (overrides = {}) => async () => ({
  aud: WEB_CLIENT, iss: 'https://accounts.google.com', email: 'Farmer@Example.com', email_verified: 'true',
  given_name: 'Farmer', family_name: 'One', exp: String(Math.floor(Date.now() / 1000) + 600), ...overrides,
});

function makeApp(fake, googleInfo = google(), extra = {}) {
  const svc = createAccountService({ tb: fake.tb, tbNoAuth: fake.tbNoAuth, fetchGoogleTokenInfo: googleInfo, googleClientIds: [WEB_CLIENT], ...extra });
  const app = express();
  app.use(express.json());
  app.use('/api/account', createAccountRouter(svc, { maxPerWindow: 1000 }));
  return app;
}

const existingMember = { id: { id: 'u-old' }, email: 'old@farm.io', authority: 'CUSTOMER_USER', customerId: { id: 'cust-hydro' } };

/** What the user can reach: their own user group, its permissions, and the device group they cover. */
function privacySetup(fake, email) {
  const ug = fake.state.groups.find((g) => g.name === `Users ${email}` && g.type === 'USER');
  const dg = fake.state.groups.find((g) => g.name === `Devices ${email}` && g.type === 'DEVICE');
  const perms = ug ? fake.state.permissions.filter((p) => p.userGroupId.id === ug.id.id) : [];
  return { ug, dg, perms };
}

test('e-mail sign-up: shared customer, PRIVATE user group + device group, NO session returned', async () => {
  const fake = fakeThingsBoard({ users: [existingMember] });
  const res = await request(makeApp(fake)).post('/api/account/signup').send({ email: 'New@Farm.io', password: 'goodpass123', firstName: 'New' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { success: true, email: 'new@farm.io' });
  const user = fake.state.users.find((u) => u.email === 'new@farm.io');
  assert.strictEqual(user.customerId.id, 'cust-hydro');
  assert.strictEqual(fake.state.activated[user.id.id], 'goodpass123');

  const { ug, dg, perms } = privacySetup(fake, 'new@farm.io');
  assert.ok(ug && dg, 'private groups created under the shared customer');
  assert.strictEqual(ug.ownerId.id, 'cust-hydro');
  assert.deepStrictEqual(fake.state.members[ug.id.id], [user.id.id], 'user joined only their own group');
  assert.ok(!fake.state.members['grp-cu'], 'never added to "Customer Users" (that group sees every device)');
  assert.strictEqual(perms.length, 2);
  assert.ok(perms.some((p) => p.roleId.id === 'role-member' && !p.entityGroupId), 'generic Farm Member');
  assert.ok(perms.some((p) => p.roleId.id === 'role-owner' && p.entityGroupId.id === dg.id.id && p.entityGroupType === 'DEVICE'), 'owner role only on own device group');
  assert.ok(!fake.state.calls.includes('POST /api/customer'), 'must not try to create a customer');
  assert.ok(!JSON.stringify(res.body).includes('session'), 'server must not hand out ThingsBoard sessions');
});

test('re-running setup for the same e-mail reuses groups and does not duplicate permissions', async () => {
  const fake = fakeThingsBoard();
  const app = makeApp(fake);
  await request(app).post('/api/account/signup').send({ email: 'a@farm.io', password: 'goodpass123' });
  fake.state.users = []; // pretend the user was deleted in ThingsBoard, then signs up again
  await request(app).post('/api/account/signup').send({ email: 'a@farm.io', password: 'goodpass123' });
  assert.strictEqual(fake.state.groups.filter((g) => g.name === 'Users a@farm.io').length, 1);
  assert.strictEqual(privacySetup(fake, 'a@farm.io').perms.length, 2);
});

test('missing roles -> clear config error and nothing created', async () => {
  const fake = fakeThingsBoard({ roles: [] });
  const res = await request(makeApp(fake)).post('/api/account/signup').send({ email: 'r@farm.io', password: 'goodpass123' });
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.body.error, 'SIGNUP_ROLES_MISSING');
  assert.strictEqual(fake.state.users.length, 0);
});

test('custom shared customer title; missing customer -> clear config error', async () => {
  const fake = fakeThingsBoard({ customers: [{ id: { id: 'cust-team' }, title: 'Team' }] });
  let res = await request(makeApp(fake, google(), { sharedCustomerTitle: 'Team' })).post('/api/account/signup').send({ email: 'b@farm.io', password: 'goodpass123' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(fake.state.users[0].customerId.id, 'cust-team');
  res = await request(makeApp(fakeThingsBoard({ customers: [] }))).post('/api/account/signup').send({ email: 'c@farm.io', password: 'goodpass123' });
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.body.error, 'SIGNUP_CUSTOMER_MISSING');
});

test('Free-plan user limit -> USER_LIMIT_REACHED; duplicate -> 409; weak/bad input -> 400', async () => {
  const full = fakeThingsBoard({ users: [existingMember], userLimit: 1 });
  let res = await request(makeApp(full)).post('/api/account/signup').send({ email: 'd@farm.io', password: 'goodpass123' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.body.error, 'USER_LIMIT_REACHED');
  const app = makeApp(fakeThingsBoard({ users: [existingMember] }));
  res = await request(app).post('/api/account/signup').send({ email: 'OLD@farm.io', password: 'goodpass123' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error, 'EMAIL_EXISTS');
  res = await request(app).post('/api/account/signup').send({ email: 'x@farm.io', password: 'short' });
  assert.strictEqual(res.body.error, 'WEAK_PASSWORD');
  res = await request(app).post('/api/account/signup').send({ email: 'not-an-email', password: 'goodpass123' });
  assert.strictEqual(res.body.error, 'INVALID_EMAIL');
});

test('Google sign-up: verified Google e-mail + chosen password, NO session returned', async () => {
  const fake = fakeThingsBoard();
  const res = await request(makeApp(fake)).post('/api/account/signup/google').send({ idToken: 'x', password: 'goodpass123' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { success: true, email: 'farmer@example.com' });
  const user = fake.state.users[0];
  assert.strictEqual(user.firstName, 'Farmer');
  assert.strictEqual(user.customerId.id, 'cust-hydro');
  assert.strictEqual(fake.state.activated[user.id.id], 'goodpass123');
});

test('Google sign-up: rejects other apps, unverified/expired e-mail, bad token, weak password, existing account', async () => {
  const post = (fake, info, body = { idToken: 'x', password: 'goodpass123' }) =>
    request(makeApp(fake, info)).post('/api/account/signup/google').send(body);
  assert.strictEqual((await post(fakeThingsBoard(), google({ aud: 'other' }))).body.error, 'GOOGLE_AUDIENCE_MISMATCH');
  assert.strictEqual((await post(fakeThingsBoard(), google({ email_verified: 'false' }))).body.error, 'GOOGLE_EMAIL_UNVERIFIED');
  assert.strictEqual((await post(fakeThingsBoard(), google({ exp: '1' }))).body.error, 'GOOGLE_TOKEN_EXPIRED');
  assert.strictEqual((await post(fakeThingsBoard(), async () => { throw new Error('x'); })).body.error, 'GOOGLE_TOKEN_INVALID');
  assert.strictEqual((await post(fakeThingsBoard(), google(), { idToken: 'x', password: '123' })).body.error, 'WEAK_PASSWORD');
  const existing = fakeThingsBoard({ users: [{ ...existingMember, email: 'farmer@example.com' }] });
  assert.strictEqual((await post(existing, google())).status, 409);
});

test('failure after user creation: reports the step and removes the half-created user', async () => {
  const fake = fakeThingsBoard();
  fake.tbNoAuth = async () => {
    throw Object.assign(new Error('bad'), { response: { status: 500, data: { message: 'internal' } } });
  };
  const res = await request(makeApp(fake)).post('/api/account/signup').send({ email: 'half@farm.io', password: 'goodpass123' });
  assert.strictEqual(res.status, 502);
  assert.deepStrictEqual({ error: res.body.error, stage: res.body.stage, tbStatus: res.body.tbStatus }, { error: 'THINGSBOARD_ERROR', stage: 'activate', tbStatus: 500 });
  assert.strictEqual(fake.state.users.length, 0, 'user removed');
});

test('extractActivateToken parses link string or object', () => {
  assert.strictEqual(extractActivateToken('https://h/api/noauth/activate?activateToken=abc%2Bd'), 'abc+d');
  assert.strictEqual(extractActivateToken({ value: 'x?activateToken=zz&y=1' }), 'zz');
  assert.throws(() => extractActivateToken('nope'));
});

test('server only exposes health + sign-up routes', async () => {
  process.env.NODE_ENV = 'test';
  const app = require('../index');
  assert.strictEqual((await request(app).get('/api/health')).body.ok, true);
  for (const [method, path] of [['get', '/api/telemetry/FARM-1'], ['post', '/api/command/FARM-1'], ['post', '/api/bind-device'], ['get', '/api/cron'], ['post', '/api/ai/analyze']]) {
    assert.strictEqual((await request(app)[method](path)).status, 404, `${path} must be gone`);
  }
});

test('sign-up also sets up push for the owner only (target = own user group + routed node); idempotent', async () => {
  const fake = fakeThingsBoard({ push: true });
  const app = makeApp(fake);
  const res = await request(app).post('/api/account/signup').send({ email: 'grower@farm.io', password: 'goodpass123' });
  assert.strictEqual(res.status, 200);
  const { ug } = privacySetup(fake, 'grower@farm.io');
  assert.strictEqual(fake.state.targets.length, 1);
  assert.deepStrictEqual(fake.state.targets[0].configuration.usersFilter, { type: 'USER_GROUP_LIST', groupsIds: [ug.id.id] });
  const md = fake.state.chainMd;
  const idx = md.nodes.findIndex((n) => n.name === '[Push] grower@farm.io');
  assert.ok(idx > 0, 'push node added');
  assert.deepStrictEqual(md.nodes[idx].configuration, {
    templateId: { entityType: 'NOTIFICATION_TEMPLATE', id: 'tpl-1' },
    targets: [fake.state.targets[0].id.id],
  });
  assert.deepStrictEqual(md.connections, [{ fromIndex: 1, toIndex: idx, type: 'grower@farm.io' }], 'routed only by the owner e-mail');

  // running the setup again (e.g. re-sign-up attempt) must not duplicate target / node
  await request(app).post('/api/account/signup').send({ email: 'grower@farm.io', password: 'goodpass123' });
  assert.strictEqual(fake.state.targets.length, 1);
  assert.strictEqual(fake.state.chainMd.nodes.filter((n) => n.name === '[Push] grower@farm.io').length, 1);
});

test('push setup failure never blocks sign-up', async () => {
  const fake = fakeThingsBoard(); // no push endpoints -> setup throws internally
  const res = await request(makeApp(fake)).post('/api/account/signup').send({ email: 'solo@farm.io', password: 'goodpass123' });
  assert.strictEqual(res.status, 200);
});
