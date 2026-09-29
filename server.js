'use strict';

/**
 * APEX AUTH - KeyAuth style auth + loader control panel
 * Node.js + Express + SQLite (node:sqlite, zero native dependencies)
 *
 *   node server.js            -> http://localhost:3000
 *   PORT=8080 node server.js  -> custom port
 */

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const db = require('./db');

const {
  now, get, all, run, setting, setSetting, log,
  hashPassword, verifyPassword, generateKey, seedProducts,
  createSession, getSession, destroySession
} = db;
const webhook = require('./webhook');
const backup = require('./backup');

/** fire-and-forget Discord audit (loader ko kabhi slow nahi karna) */
function audit(promise) {
  Promise.resolve(promise).then(r => {
    if (r && r.ok === false && r.reason !== 'webhook not configured') {
      log('webhook', 'discord rejected: ' + (r.reason || ('HTTP ' + r.status) || 'error'), '');
    }
  }).catch(e => log('webhook', 'send failed: ' + e.message, ''));
}

const PORT = Number(process.env.PORT || 3000);
const DAY = 86400000;
const app = express();
app.disable('x-powered-by');

/* ---------------------------------------------------------------------------
   CORS — hosted frontend (alag origin) se bhi calls bina ruke chalein.
   Same-origin (frontend isi server par hai) ho to headers sirf extra hain,
   nuksan nahi karte. OPTIONS (preflight) ka reply yahin 204 ho jata hai.
   Equivalent to: cors({ origin: '*', ... }) — bina kisi extra dependency.
--------------------------------------------------------------------------- */
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
  res.set('Access-Control-Expose-Headers', 'Content-Length');
  res.set('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

/* nginx/reverse proxy ke peeche ho to asli client IP chahiye (audit webhook ke liye):
     TRUST_PROXY=1 node server.js        — default OFF (proxy ke bina spoof ho sakta) */
const tp = String(process.env.TRUST_PROXY || '').toLowerCase();
if (tp === '1' || tp === 'true' || tp === 'yes') app.set('trust proxy', true);

/* ------------------------------------------------------------------ */
/* middleware                                                          */
/* ------------------------------------------------------------------ */

app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

/* tiny in-memory rate limiter (auth endpoints) */
const buckets = new Map();
function rateLimit(limit = 20, windowMs = 60000) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.baseUrl}${req.path}`;
    const t = now();
    const b = buckets.get(key);
    if (!b || t - b.start > windowMs) {
      buckets.set(key, { start: t, count: 1 });
      return next();
    }
    b.count++;
    if (b.count > limit) {
      return res.status(429).json({ ok: false, error: 'Too many attempts, slow down.' });
    }
    next();
  };
}
setInterval(() => {
  const t = now();
  for (const [k, v] of buckets) if (t - v.start > 300000) buckets.delete(k);
}, 60000).unref();

function tokenFrom(req) {
  const h = req.get('authorization') || '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  if (req.get('x-api-key')) return req.get('x-api-key').trim();
  return (req.body && req.body.token) || '';
}

function currentUser(req) {
  const s = getSession(tokenFrom(req));
  if (!s) return null;
  const u = get('SELECT * FROM users WHERE id = ?', s.user_id);
  if (!u || u.banned) return null;
  return { user: u, session: s };
}

function requireAuth(req, res, next) {
  const ctx = currentUser(req);
  if (!ctx) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  req.ctx = ctx;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.ctx.user.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Admin only' });
    }
    next();
  });
}

/* staff = admin + reseller (sub-user): keys / customers dekh-sakta hai,
   lekin loader control, logs aur site settings admin tak mehdood hain   */
function requireStaff(req, res, next) {
  requireAuth(req, res, () => {
    if (!['admin', 'reseller'].includes(req.ctx.user.role)) {
      return res.status(403).json({ ok: false, error: 'Staff access only (admin / reseller)' });
    }
    next();
  });
}

function bad(res, msg, code = 400) {
  return res.status(code).json({ ok: false, error: msg });
}

/* ------------------------------------------------------------------ */
/* helper functions                                                    */
/* ------------------------------------------------------------------ */

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    discord: u.discord,
    role: u.role,
    banned: !!u.banned,
    created_at: u.created_at,
    last_login: u.last_login,
    last_ip: u.last_ip,
    hwid: u.hwid
  };
}

function publicApp(a) {
  return {
    id: a.id,
    name: a.name,
    slug: a.slug,
    app_key: a.app_key || '',      // public app id (loader isko bhejta hai)
    description: a.description,
    status: a.status,
    maintenance_message: a.maintenance_message,
    maintenance_until: a.maintenance_until,
    maintenance_active: a.status === 'maintenance' &&
      (!a.maintenance_until || a.maintenance_until > now()),
    version: a.version,
    download_url: a.download_url,
    changelog: a.changelog,
    require_key: !!a.require_key,
    created_at: a.created_at
  };
}

function licenseActive(k) {
  if (k.revoked) return false;
  if (k.expires_at !== 0 && k.expires_at < now()) return false;
  return true;
}

function publicLicense(k) {
  return {
    id: k.id,
    key: k.license_key,
    app_id: k.app_id,
    app_name: k.app_name || undefined,
    product_id: Number(k.product_id) || 0,
    product_name: k.product_name || undefined,
    user_id: k.user_id,
    username: k.username || undefined,
    plan: k.plan,
    duration_days: k.duration_days,
    user_limit: k.user_limit === 0 ? 0 : 1,
    expires_at: k.expires_at,
    lifetime: k.expires_at === 0,
    hwid: k.hwid,
    revoked: !!k.revoked,
    note: k.note,
    active: licenseActive(k),
    created_at: k.created_at,
    last_used: k.last_used
  };
}

function findApp(req) {
  const slug = (req.body && (req.body.app || req.body.slug)) ||
    req.query.app || req.query.slug;
  if (!slug) return null;
  return get('SELECT * FROM apps WHERE slug = ? OR id = ?', String(slug), Number(slug) || -1);
}

/** Gate: blocks every loader call while the loader is in maintenance/offline */
function loaderGate(appRow, res) {
  if (!appRow) { bad(res, 'Unknown application', 404); return false; }
  if (appRow.status === 'maintenance') {
    res.status(503).json({
      ok: false,
      code: 'MAINTENANCE',
      error: appRow.maintenance_message || 'Server is under maintenance. Please try again later.',
      until: appRow.maintenance_until || 0
    });
    return false;
  }
  if (appRow.status === 'offline') {
    res.status(503).json({ ok: false, code: 'OFFLINE', error: 'Loader is currently offline.' });
    return false;
  }
  return true;
}

/**
 * Loader ke body me `product` (id / naam / slug) bheja jaye to wahi product
 * choose hota hai — uske apne alag secret/version ki verification hogi.
 */
function findProduct(a, req) {
  const raw = req.body ? (req.body.product !== undefined ? req.body.product
    : (req.body.product_id !== undefined ? req.body.product_id : req.body.product_name)) : undefined;
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).toLowerCase().trim();
  return get('SELECT * FROM products WHERE app_id = ? AND (id = ? OR LOWER(name) = ? OR slug = ?)',
    a.id, Number(s) || -1, s, s);
}

/**
 * PRODUCT GATE — key sirf apne product par chalega.
 *   product_id = 0    -> app-wide key (kisi bhi product par chalegi)
 *   product_id = <id> -> sirf us product par
 *
 * Request me product nahi bheja (purana loader) -> chalne do (backward compat).
 * Request me product bheja -> EXACT match zaroori, warna 403.
 * Iske bina Internal ki key Silent Aim me bhi activate ho jati thi.
 */
function productGate(a, req, k, res) {
  if (!k || !Number(k.product_id)) return true;               // app-wide key
  const raw = req.body ? (req.body.product !== undefined ? req.body.product
    : (req.body.product_id !== undefined ? req.body.product_id : req.body.product_name)) : undefined;
  if (raw === undefined || raw === null || raw === '') return true;   // loader ne product nahi bheja

  const p = findProduct(a, req);
  if (p && Number(p.id) === Number(k.product_id)) return true;

  const want = p ? p.name : String(raw);
  const own  = get('SELECT name FROM products WHERE id = ?', k.product_id);
  const ownName = own ? own.name : ('#' + k.product_id);
  log('key', `Product mismatch: key is for "${ownName}", loader asked "${want}"`, req.ip);
  res.status(403).json({
    ok: false,
    code: 'WRONG_PRODUCT',
    error: `This key is for ${ownName}, not ${want}`
  });
  return false;
}

/**
 * Agar loader ne "Require API secret" on kiya hai to har loader call ke saath
 * `x-api-key: <secret>` header (ya body me `secret`) aana chahiye.
 * Target = product (agar loader ne product bheja) warna loader (app).
 * Default OFF hai — purana loader bina secret ke chalta rahe.
 */
function appSecret(a, req, res) {
  if (!a) return true;
  const prod = findProduct(a, req);
  const need = Number(a.require_secret) || (prod && Number(prod.require_secret));
  if (!need) return true;
  const got = (req.get('x-api-key') || '').trim() || String((req.body && req.body.secret) || '').trim();
  if (got) {
    if (a.secret && got === a.secret) return true;                       // loader (master) key
    if (prod && prod.secret && got === prod.secret) return true;         // product key
  }
  log('loader', `Missing/bad app secret for ${a.slug}${prod ? ' / ' + prod.name : ''}`, req.ip);
  res.status(403).json({ ok: false, code: 'BAD_SECRET', error: 'Invalid application secret' });
  return false;
}

function newCredentials() {
  return {
    app_key: 'app_' + crypto.randomBytes(8).toString('hex'),
    secret: crypto.randomBytes(24).toString('hex')
  };
}

/* ================================================================== */
/* PUBLIC / LOADER API                                                 */
/* ================================================================== */

/** quick status probe (no auth) - used for the landing page + loader splash */
app.get('/api/public/status', (req, res) => {
  const a = findApp(req);
  if (!a) {
    const apps = all('SELECT * FROM apps').map(publicApp);
    return res.json({ ok: true, site: setting('site_name'), apps });
  }
  res.json({ ok: true, app: publicApp(a) });
});

/** loader boot: version + maintenance check */
app.post('/api/loader/init', rateLimit(60), (req, res) => {
  const a = findApp(req);
  if (!a) return bad(res, 'Unknown application', 404);
  if (!appSecret(a, req, res)) return;
  const clientVersion = String((req.body && req.body.version) || '');
  const info = publicApp(a);
  const prod = findProduct(a, req);
  res.json({
    ok: a.status !== 'offline',
    app: info,
    product: prod ? { id: prod.id, name: prod.name, version: prod.version } : undefined,
    update_available: !!(clientVersion && clientVersion !== a.version),
    download_url: a.download_url,
    message: a.status === 'maintenance'
      ? (a.maintenance_message || 'Under maintenance')
      : ''
  });
});

/** username/password login from the loader */
app.post('/api/loader/login', rateLimit(15), (req, res) => {
  const a = findApp(req);
  if (!loaderGate(a, res)) return;
  if (!appSecret(a, req, res)) return;

  const { username, password, hwid } = req.body || {};
  if (!username || !password) return bad(res, 'Username and password required');

  const u = get('SELECT * FROM users WHERE username = ?', String(username));
  if (!u || !verifyPassword(password, u.password)) {
    log('login', `Failed login for "${username}"`, req.ip);
    return bad(res, 'Invalid username or password', 401);
  }
  if (u.banned) return bad(res, 'Account banned', 403);

  const session = createSession(u.id, Number(setting('session_days', '30')) * DAY,
    String(hwid || ''), req.ip);
  run('UPDATE users SET last_login = ?, last_ip = ? WHERE id = ?', now(), req.ip, u.id);

  /* PRODUCT GATE: sirf us product (ya app-wide) key return ho — warna
     Internal ki key user ko Silent Aim ka license dikha deti thi */
  const rawProd = (req.body && (req.body.product !== undefined ? req.body.product
    : (req.body.product_id !== undefined ? req.body.product_id : req.body.product_name)));
  const prod = findProduct(a, req);
  let prodSql = '';
  const kp = [u.id, a.id, now()];
  if (rawProd !== undefined && rawProd !== null && rawProd !== '') {
    prodSql = prod ? 'AND (l.product_id = 0 OR l.product_id = ?)' : 'AND l.product_id = 0';
    if (prod) kp.push(prod.id);
  }

  const activeKey = get(
    `SELECT l.*, a.name AS app_name FROM licenses l
       JOIN apps a ON a.id = l.app_id
      WHERE l.user_id = ? AND l.app_id = ? AND l.revoked = 0
        AND (l.expires_at = 0 OR l.expires_at > ?)
        ${prodSql}
      ORDER BY l.expires_at DESC LIMIT 1`,
    ...kp
  );

  log('login', `${u.username} logged in to ${a.slug}`, req.ip);
  res.json({
    ok: true,
    token: session.token,
    expires: session.expires,
    user: publicUser(u),
    license: activeKey ? publicLicense(activeKey) : null
  });
});

/** license key activation (bind to HWID)
 *  - token ke saath: key account par claim hoti hai (purana flow)
 *  - bina token (key-only loader): sirf unclaimed key chalti hai, machine bind hoti hai */
app.post('/api/loader/activate', rateLimit(30), (req, res) => {
  const a = findApp(req);
  if (!loaderGate(a, res)) return;
  if (!appSecret(a, req, res)) return;

  const { key, hwid } = req.body || {};
  if (!key) return bad(res, 'License key required');
  const ctx = currentUser(req);

  const k = get('SELECT * FROM licenses WHERE license_key COLLATE NOCASE = ?', String(key).trim());
  if (!k) return bad(res, 'Key not found', 404);
  if (k.app_id !== a.id) return bad(res, 'Key belongs to another application');
  if (k.revoked) return bad(res, 'Key revoked');
  if (k.expires_at !== 0 && k.expires_at < now()) return bad(res, 'Key expired');
  if (!productGate(a, req, k, res)) return;      // Internal ki key Silent Aim me NA chale

  const id = String(hwid || (ctx ? ctx.session.hwid : '') || '');
  if (k.user_limit === 1 && k.user_id && (!ctx || k.user_id !== ctx.user.id)) {
    return bad(res, ctx ? 'Key is already assigned to another account'
      : 'Login first — this key is linked to an account', ctx ? 403 : 401);
  }
  if (k.hwid && k.hwid !== id) return bad(res, 'Key is bound to another HWID', 403);

  const owner = ctx ? ctx.user.id : (k.user_id || 0);
  if (ctx && !k.user_id) run('UPDATE licenses SET user_id = ? WHERE id = ?', ctx.user.id, k.id);
  if (!k.hwid) run('UPDATE licenses SET hwid = ?, user_id = ?, last_used = ? WHERE id = ?',
    id, owner, now(), k.id);
  else run('UPDATE licenses SET last_used = ? WHERE id = ?', now(), k.id);

  const fresh = get(
    `SELECT l.*, a.name AS app_name FROM licenses l JOIN apps a ON a.id = l.app_id WHERE l.id = ?`,
    k.id
  );
  log('key', `${ctx ? ctx.user.username : 'guest'} activated key ${k.license_key}`, req.ip);

  /* ---------- Discord realtime audit: key use ho gayi ---------- */
  const prdRow = fresh.product_id ? get('SELECT name FROM products WHERE id = ?', fresh.product_id) : null;
  let who = ctx ? ctx.user.username : 'guest';
  if (!ctx && fresh.user_id) {
    const ou = get('SELECT username FROM users WHERE id = ?', fresh.user_id);
    if (ou) who = ou.username;
  }
  audit(webhook.keyUsed(req, {
    username: who,
    product: prdRow ? prdRow.name : fresh.app_name,
    plan: fresh.plan,
    hwid: fresh.hwid || id,
    expiresAt: fresh.expires_at,
    key: fresh.license_key,
    status: 'Authorized'
  }));

  res.json({ ok: true, license: publicLicense(fresh), guest: !ctx });
});

/** machine reset — account session se apni sab keys, ya (key-only loader) unclaimed key */
app.post('/api/loader/reset-hwid', rateLimit(10), (req, res) => {
  const a = findApp(req);
  if (!loaderGate(a, res)) return;
  if (!appSecret(a, req, res)) return;
  const ctx = currentUser(req);
  const key = req.body && req.body.key;

  if (ctx) {
    /* sirf isi product (+ app-wide) key unbind ho — doosre product ki key safe rahe */
    const rp = findProduct(a, req);
    let rsql = 'UPDATE licenses SET hwid = ? WHERE app_id = ? AND user_id = ?';
    const ra = ['', a.id, ctx.user.id];
    if (rp) { rsql += ' AND (product_id = 0 OR product_id = ?)'; ra.push(rp.id); }
    const n = run(rsql, ...ra).changes;
    log('key', `HWID reset by ${ctx.user.username} (${n} key${rp ? ' / ' + rp.name : ''})`, req.ip);
    return res.json({ ok: true, reset: n });
  }
  if (key) {
    const k = get('SELECT * FROM licenses WHERE license_key COLLATE NOCASE = ?', String(key).trim());
    if (!k || k.app_id !== a.id) return bad(res, 'Key not found', 404);
    if (k.revoked) return bad(res, 'Key revoked');
    if (k.expires_at !== 0 && k.expires_at < now()) return bad(res, 'Key expired');
    if (k.user_id) return bad(res, 'Login first — this key is linked to an account', 401);
    run('UPDATE licenses SET hwid = ? WHERE id = ?', '', k.id);
    log('key', `HWID reset for key ${k.license_key}`, req.ip);
    return res.json({ ok: true, reset: 1 });
  }
  return bad(res, 'Login first', 401);
});

/** ping / heartbeat: keeps "online users" fresh */
app.post('/api/loader/ping', rateLimit(120), (req, res) => {
  const ctx = currentUser(req);
  if (!ctx) return bad(res, 'Not authenticated', 401);
  const a = findApp(req);
  if (a && !appSecret(a, req, res)) return;
  run('UPDATE sessions SET expires_at = ? WHERE token = ?',
    now() + Number(setting('session_days', '30')) * DAY, ctx.session.token);
  if (a) {
    run('UPDATE licenses SET last_used = ? WHERE user_id = ? AND app_id = ?',
      now(), ctx.user.id, a.id);
  }
  res.json({ ok: true, status: a ? a.status : 'online', server_time: now() });
});

app.post('/api/loader/logout', (req, res) => {
  destroySession(tokenFrom(req));
  res.json({ ok: true });
});

/* ================================================================== */
/* PANEL AUTH                                                          */
/* ================================================================== */

app.post('/api/auth/register', rateLimit(8), (req, res) => {
  if (setting('signup_open', '1') !== '1') return bad(res, 'Registration is closed', 403);
  const { username, password, email = '', discord = '' } = req.body || {};
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_]{3,24}$/.test(name)) {
    return bad(res, 'Username must be 3-24 chars (a-z, 0-9, _)');
  }
  if (!password || String(password).length < 6) return bad(res, 'Password must be 6+ characters');
  if (get('SELECT id FROM users WHERE username = ?', name)) return bad(res, 'Username already taken');

  /* hamesha CLIENT account banta hai — reseller (sub-user) accounts sirf
     admin panel se banaye jaate hain (ya reseller_signup on ho to wahi)   */
  const role = 'user';

  run(
    `INSERT INTO users (username, password, email, discord, role, created_at, last_ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    name, hashPassword(password), String(email).slice(0, 100),
    String(discord).slice(0, 60), role, now(), req.ip
  );
  const u = get('SELECT * FROM users WHERE username = ?', name);
  const s = createSession(u.id, Number(setting('session_days', '30')) * DAY, '', req.ip);
  log('login', `New registration: ${name}`, req.ip);
  res.json({ ok: true, token: s.token, user: publicUser(u) });
});

app.post('/api/auth/login', rateLimit(12), (req, res) => {
  const { username, password } = req.body || {};
  const u = get('SELECT * FROM users WHERE username = ?', String(username || '').trim());
  if (!u || !verifyPassword(password || '', u.password)) {
    log('login', `Panel login failed: ${username || '?'}`, req.ip);
    return bad(res, 'Invalid username or password', 401);
  }
  if (u.banned) return bad(res, 'Account banned', 403);
  const s = createSession(u.id, Number(setting('session_days', '30')) * DAY, '', req.ip);
  run('UPDATE users SET last_login = ?, last_ip = ? WHERE id = ?', now(), req.ip, u.id);
  log('login', `${u.username} logged into panel`, req.ip);
  res.json({ ok: true, token: s.token, user: publicUser(u) });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: publicUser(req.ctx.user) });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  destroySession(req.ctx.session.token);
  res.json({ ok: true });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!verifyPassword(old_password || '', req.ctx.user.password)) return bad(res, 'Wrong current password');
  if (!new_password || String(new_password).length < 6) return bad(res, 'New password must be 6+ characters');
  run('UPDATE users SET password = ? WHERE id = ?', hashPassword(new_password), req.ctx.user.id);
  log('admin', `${req.ctx.user.username} changed password`, req.ip);
  res.json({ ok: true });
});

/* ------------------------- user area ------------------------------- */

app.get('/api/me/licenses', requireAuth, (req, res) => {
  const rows = all(
    `SELECT l.*, a.name AS app_name, p.name AS product_name, u.username
       FROM licenses l JOIN apps a ON a.id = l.app_id
       LEFT JOIN products p ON p.id = l.product_id
       LEFT JOIN users u ON u.id = l.user_id
      WHERE l.user_id = ? ORDER BY l.created_at DESC`,
    req.ctx.user.id
  );
  res.json({ ok: true, licenses: rows.map(publicLicense) });
});

app.post('/api/me/hwid-reset', requireAuth, rateLimit(5), (req, res) => {
  const r = run('UPDATE licenses SET hwid = ? WHERE user_id = ? AND revoked = 0', '', req.ctx.user.id);
  log('key', `${req.ctx.user.username} reset HWID (${r.changes} keys)`, req.ip);
  res.json({ ok: true, changed: r.changes });
});

/* ================================================================== */
/* ADMIN API                                                           */
/* ================================================================== */

app.get('/api/admin/stats', requireStaff, (req, res) => {
  const users = get('SELECT COUNT(*) c FROM users').c;
  const keys = get('SELECT COUNT(*) c FROM licenses').c;
  const activeKeys = get('SELECT COUNT(*) c FROM licenses WHERE revoked = 0 AND (expires_at = 0 OR expires_at > ?)', now()).c;
  const availableKeys = get("SELECT COUNT(*) c FROM licenses WHERE revoked = 0 AND hwid = '' AND (expires_at = 0 OR expires_at > ?)", now()).c;
  const boundKeys = get("SELECT COUNT(*) c FROM licenses WHERE revoked = 0 AND hwid != '' AND (expires_at = 0 OR expires_at > ?)", now()).c;
  const banned = get('SELECT COUNT(*) c FROM users WHERE banned = 1').c;
  const subs = get('SELECT COUNT(DISTINCT user_id) c FROM licenses WHERE revoked = 0 AND (expires_at = 0 OR expires_at > ?)', now()).c;
  const online = get('SELECT COUNT(*) c FROM sessions WHERE expires_at > ?', now()).c;
  const recent = get('SELECT COUNT(DISTINCT user_id) c FROM sessions WHERE expires_at > ?', now() - 5 * 60000).c;
  const apps = all('SELECT status, COUNT(*) c FROM apps GROUP BY status');
  res.json({
    ok: true,
    stats: {
      users, keys, active_keys: activeKeys, available_keys: availableKeys,
      bound_keys: boundKeys, banned, subscriptions: subs,
      sessions_active: online, online_5min: recent,
      apps: apps.map(a => ({ status: a.status, count: a.c }))
    }
  });
});

/* --------------------------- loaders ------------------------------- */

app.get('/api/admin/apps', requireAdmin, (req, res) => {
  res.json({ ok: true, apps: all('SELECT * FROM apps ORDER BY id').map(a => ({
    ...publicApp(a),
    secret: a.secret || '',            // sirf admin ko (public API me kabhi nahi)
    require_secret: !!a.require_secret,
    keys_total: get('SELECT COUNT(*) c FROM licenses WHERE app_id = ?', a.id).c,
    keys_active: get('SELECT COUNT(*) c FROM licenses WHERE app_id = ? AND revoked = 0 AND (expires_at = 0 OR expires_at > ?)', a.id, now()).c
  })) });
});

app.post('/api/admin/apps', requireAdmin, (req, res) => {
  const { name, slug, description = '', version = '1.0.0' } = req.body || {};
  const s = String(slug || name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').trim();
  if (!name || !s) return bad(res, 'Name is required');
  if (get('SELECT id FROM apps WHERE slug = ?', s)) return bad(res, 'Slug already exists');
  const cred = newCredentials();
  run(
    `INSERT INTO apps (name, slug, description, version, app_key, secret, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    String(name).slice(0, 60), s, String(description).slice(0, 300), String(version).slice(0, 20),
    cred.app_key, cred.secret, now()
  );
  const created = get('SELECT id FROM apps WHERE slug = ?', s);
  seedProducts(created.id);   /* default: Internal / External / Silent Aim / Silent Cover */
  log('admin', `Loader created: ${name} (${s})`, req.ip);
  res.json({ ok: true });
});

/** the important one: online / offline / maintenance switch */
app.patch('/api/admin/apps/:id', requireAdmin, (req, res) => {
  const a = get('SELECT * FROM apps WHERE id = ?', Number(req.params.id));
  if (!a) return bad(res, 'Not found', 404);
  const b = req.body || {};
  const allowed = ['name', 'description', 'status', 'maintenance_message',
    'maintenance_until', 'version', 'download_url', 'changelog', 'require_key', 'require_secret', 'secret'];
  const updates = [];
  const params = [];
  for (const f of allowed) {
    if (b[f] === undefined) continue;
    let v = b[f];
    if (f === 'status') {
      v = String(v);
      if (!['online', 'offline', 'maintenance'].includes(v)) return bad(res, 'Bad status');
    }
    if (f === 'secret') {
      v = String(v).trim();
      if (v && v.length < 16) return bad(res, 'Secret must be 16+ characters');
    }
    if (f === 'maintenance_until' || f === 'require_key' || f === 'require_secret') v = Number(v) || 0;
    updates.push(`${f} = ?`);
    params.push(v);
  }
  /* purana app secret maar do — naya generate (loader ko dobara deploy karna hoga) */
  if (b.regenerate_secret) {
    const cred = newCredentials();
    updates.push('secret = ?');
    params.push(cred.secret);
    log('admin', `App secret regenerated for "${a.name}"`, req.ip);
  }
  if (!updates.length) return bad(res, 'Nothing to update');
  params.push(a.id);
  run(`UPDATE apps SET ${updates.join(', ')} WHERE id = ?`, ...params);

  if (b.status && b.status !== a.status) {
    const labels = { online: 'ONLINE', offline: 'OFFLINE', maintenance: 'MAINTENANCE' };
    log('admin', `Loader "${a.name}" switched to ${labels[b.status]}`, req.ip);
  } else if (!b.regenerate_secret) {
    log('admin', `Loader "${a.name}" settings updated`, req.ip);
  }
  const fresh = get('SELECT * FROM apps WHERE id = ?', a.id);
  res.json({
    ok: true,
    app: { ...publicApp(fresh), secret: fresh.secret || '', require_secret: !!fresh.require_secret }
  });
});

app.delete('/api/admin/apps/:id', requireAdmin, (req, res) => {
  const a = get('SELECT * FROM apps WHERE id = ?', Number(req.params.id));
  if (!a) return bad(res, 'Not found', 404);
  run('DELETE FROM apps WHERE id = ?', a.id);
  /* us loader ke products bhi hata do (unke keys ka product tag khatam) */
  run('UPDATE licenses SET product_id = 0 WHERE product_id IN (SELECT id FROM products WHERE app_id = ?)', a.id);
  run('DELETE FROM products WHERE app_id = ?', a.id);
  log('admin', `Loader deleted: ${a.name}`, req.ip);
  res.json({ ok: true });
});

/* ---------------------------- keys --------------------------------- */

app.get('/api/admin/keys', requireStaff, (req, res) => {
  const { q = '', app = '', product = '', status = 'all', limit = 100, offset = 0 } = req.query;
  const where = [];
  const params = [];
  if (q) { where.push('(l.license_key LIKE ? OR l.note LIKE ? OR l.hwid LIKE ? OR u.username LIKE ?)');
    const like = `%${q}%`; params.push(like, like, like, like); }
  if (app) { where.push('l.app_id = ?'); params.push(Number(app)); }
  if (product) { where.push('l.product_id = ?'); params.push(Number(product)); }
  if (status === 'active') where.push('l.revoked = 0 AND (l.expires_at = 0 OR l.expires_at > ' + now() + ')');
  if (status === 'expired') where.push('l.revoked = 0 AND l.expires_at != 0 AND l.expires_at <= ' + now());
  if (status === 'revoked') where.push('l.revoked = 1');
  if (status === 'unused') where.push("l.hwid = ''");
  const sql = `SELECT l.*, a.name AS app_name, p.name AS product_name, u.username
                 FROM licenses l JOIN apps a ON a.id = l.app_id
                 LEFT JOIN products p ON p.id = l.product_id
                 LEFT JOIN users u ON u.id = l.user_id
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY l.created_at DESC LIMIT ? OFFSET ?`;
  const rows = all(sql, ...params, Math.min(Number(limit) || 100, 500), Number(offset) || 0);
  const total = get(
    `SELECT COUNT(*) c FROM licenses l LEFT JOIN users u ON u.id = l.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, ...params
  ).c;
  res.json({ ok: true, keys: rows.map(publicLicense), total });
});

app.post('/api/admin/keys', requireStaff, (req, res) => {
  const { app_id, count = 1, plan = 'default', duration_days = 30, note = '',
    prefix = '', custom_key = '', user_limit = 1, product_id = 0 } = req.body || {};
  /* default prefix: khali chhoda to key hamesha APEX-XXXX-XXXX-XXXX banegi */
  const pfx = String(prefix || '').trim() || 'APEX';
  const appId = Number(app_id);
  const a = get('SELECT * FROM apps WHERE id = ?', appId);
  if (!a) return bad(res, 'Choose a loader first');
  const prodId = Number(product_id) || 0;
  if (prodId && !get('SELECT id FROM products WHERE id = ?', prodId)) return bad(res, 'Product not found');
  const custom = String(custom_key || '').trim();
  const n = custom ? 1 : Math.max(1, Math.min(Number(count) || 1, 500));
  const days = Math.max(0, Number(duration_days) || 0);
  const expires = days === 0 ? 0 : now() + days * DAY;
  const ulimit = Number(user_limit) === 0 ? 0 : 1;
  const created = [];
  for (let i = 0; i < n; i++) {
    let key;
    if (custom) {
      key = custom.toUpperCase();
      if (get('SELECT id FROM licenses WHERE license_key COLLATE NOCASE = ?', key)) return bad(res, 'That key already exists');
    } else {
      key = generateKey(pfx);
      while (get('SELECT id FROM licenses WHERE license_key COLLATE NOCASE = ?', key)) key = generateKey(pfx);
    }
    run(
      `INSERT INTO licenses (app_id, product_id, license_key, plan, duration_days, expires_at, user_limit, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      appId, prodId, key, String(plan).slice(0, 40), days, expires, ulimit,
      String(note).slice(0, 120), now()
    );
    created.push(key);
  }
  const pname = prodId ? (get('SELECT name FROM products WHERE id = ?', prodId) || {}).name : 'any product';
  log('admin', `Generated ${n} key(s) for ${a.slug} · ${pname} (${days === 0 ? 'lifetime' : days + 'd'})`, req.ip);
  res.json({ ok: true, keys: created });
});

/* ---------------------------- products ----------------------------- */
/* key generator ke product options: Internal / External / Silent Aim / Silent Cover */

app.get('/api/admin/products', requireStaff, (req, res) => {
  const appId = Number(req.query.app_id) || 0;
  const rows = appId
    ? all('SELECT * FROM products WHERE app_id = ? ORDER BY id', appId)
    : all('SELECT * FROM products ORDER BY id');
  const isAdmin = req.ctx.user.role === 'admin';
  /* secret sirf admin ko — reseller ko sirf naam/version/id dikhta hai */
  res.json({
    ok: true,
    products: rows.map(p => {
      if (isAdmin) return p;
      const { secret, ...rest } = p;
      return rest;
    })
  });
});

app.post('/api/admin/products', requireStaff, (req, res) => {
  const { app_id, name = '', version = '1.0.0' } = req.body || {};
  const appId = Number(app_id);
  const a = get('SELECT * FROM apps WHERE id = ?', appId);
  if (!a) return bad(res, 'Choose a loader first');
  const nm = String(name).trim().slice(0, 40);
  if (!nm) return bad(res, 'Product name required');
  if (get('SELECT id FROM products WHERE app_id = ? AND name = ?', appId, nm)) {
    return bad(res, 'That product already exists');
  }
  const cred = newCredentials();
  run('INSERT INTO products (app_id, name, slug, version, app_key, secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    appId, nm, nm.toLowerCase().replace(/\s+/g, '-'), String(version).trim().slice(0, 20) || '1.0.0',
    'prd_' + cred.app_key.slice(4), cred.secret, now());
  log('admin', `Product added: ${nm} (${a.slug})`, req.ip);
  res.json({ ok: true, products: all('SELECT * FROM products WHERE app_id = ? ORDER BY id', appId) });
});

/** product ka naam/version + uska apna secret (regenerate / require toggle) */
app.patch('/api/admin/products/:id', requireStaff, (req, res) => {
  const p = get('SELECT * FROM products WHERE id = ?', Number(req.params.id));
  if (!p) return bad(res, 'Not found', 404);
  const b = req.body || {};
  const isAdmin = req.ctx.user.role === 'admin';
  const credFields = ['secret', 'regenerate_secret', 'require_secret', 'app_key'];
  if (credFields.some(f => b[f] !== undefined) && !isAdmin) {
    return bad(res, 'Admin only (product secret)', 403);
  }
  const updates = [], params = [];
  for (const f of ['name', 'slug', 'version']) {
    if (b[f] === undefined) continue;
    const v = String(b[f]).trim().slice(0, 40);
    if (f === 'name' && !v) return bad(res, 'Product name required');
    if (!v) continue;
    updates.push(`${f} = ?`);
    params.push(v);
  }
  if (b.require_secret !== undefined) {
    updates.push('require_secret = ?');
    params.push(Number(b.require_secret) ? 1 : 0);
  }
  if (b.secret !== undefined && b.secret !== '') {
    const v = String(b.secret).trim();
    if (v.length < 16) return bad(res, 'Secret must be 16+ characters');
    updates.push('secret = ?');
    params.push(v);
  }
  if (b.regenerate_secret) {
    updates.push('secret = ?');
    params.push(crypto.randomBytes(24).toString('hex'));
    log('admin', `Product secret regenerated: ${p.name}`, req.ip);
  }
  if (!updates.length) return bad(res, 'Nothing to update');
  params.push(p.id);
  run(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`, ...params);
  if (!b.regenerate_secret) log('admin', `Product updated: ${p.name}`, req.ip);
  const fresh = get('SELECT * FROM products WHERE id = ?', p.id);
  res.json({
    ok: true,
    product: isAdmin ? fresh : (({ secret, ...rest }) => rest)(fresh)
  });
});

app.delete('/api/admin/products/:id', requireStaff, (req, res) => {
  const p = get('SELECT * FROM products WHERE id = ?', Number(req.params.id));
  if (!p) return bad(res, 'Not found', 404);
  run('UPDATE licenses SET product_id = 0 WHERE product_id = ?', p.id);
  run('DELETE FROM products WHERE id = ?', p.id);
  log('admin', `Product deleted: ${p.name}`, req.ip);
  res.json({ ok: true });
});

/** bulk license operations (bulk bar buttons) */
app.post('/api/admin/keys/bulk', requireStaff, (req, res) => {
  const action = String((req.body && req.body.action) || '');
  const appId = Number((req.body && req.body.app_id) || 0);
  const scope = appId ? ' AND app_id = ' + appId : '';
  let changed = 0, msg = '';
  switch (action) {
    case 'reset_hwid':
      changed = run(`UPDATE licenses SET hwid = '' WHERE revoked = 0${scope}`).changes;
      msg = `${changed} HWID lock(s) reset`;
      break;
    case 'delete_unused':
      changed = run(`DELETE FROM licenses WHERE hwid = '' AND user_id = 0${scope}`).changes;
      msg = `${changed} unused key(s) deleted`;
      break;
    case 'pause_all':
      changed = run(`UPDATE licenses SET revoked = 1 WHERE revoked = 0${scope}`).changes;
      msg = `${changed} key(s) paused`;
      break;
    case 'resume_all':
      changed = run(`UPDATE licenses SET revoked = 0 WHERE revoked = 1${scope}`).changes;
      msg = `${changed} key(s) resumed`;
      break;
    case 'purge':
      changed = run(`DELETE FROM licenses WHERE 1=1${scope}`).changes;
      msg = `${changed} key(s) purged`;
      break;
    default:
      return bad(res, 'Unknown bulk action');
  }
  log('admin', `Bulk "${action}": ${msg}`, req.ip);
  res.json({ ok: true, changed, message: msg });
});

app.patch('/api/admin/keys/:id', requireStaff, (req, res) => {
  const k = get('SELECT * FROM licenses WHERE id = ?', Number(req.params.id));
  if (!k) return bad(res, 'Not found', 404);
  const b = req.body || {};
  if (b.revoked !== undefined) run('UPDATE licenses SET revoked = ? WHERE id = ?', b.revoked ? 1 : 0, k.id);
  if (b.unbind) run('UPDATE licenses SET hwid = ? WHERE id = ?', '', k.id);
  if (b.note !== undefined) run('UPDATE licenses SET note = ? WHERE id = ?', String(b.note).slice(0, 120), k.id);
  if (b.add_days !== undefined) {
    const extra = Number(b.add_days) || 0;
    const base = k.expires_at === 0 || k.expires_at < now() ? now() : k.expires_at;
    run('UPDATE licenses SET expires_at = ? WHERE id = ?', base + extra * DAY, k.id);
  }
  log('admin', `Key ${k.license_key} updated`, req.ip);
  res.json({ ok: true });
});

app.delete('/api/admin/keys/:id', requireStaff, (req, res) => {
  const k = get('SELECT * FROM licenses WHERE id = ?', Number(req.params.id));
  if (!k) return bad(res, 'Not found', 404);
  run('DELETE FROM licenses WHERE id = ?', k.id);
  log('admin', `Key deleted: ${k.license_key}`, req.ip);
  res.json({ ok: true });
});

/* ---------------------------- users -------------------------------- */

app.get('/api/admin/users', requireStaff, (req, res) => {
  const q = String(req.query.q || '');
  const params = [];
  let where = '';
  if (q) {
    where = 'WHERE username LIKE ? OR email LIKE ? OR discord LIKE ?';
    const like = `%${q}%`; params.push(like, like, like);
  }
  const rows = all(
    `SELECT u.*, (SELECT COUNT(*) FROM licenses l WHERE l.user_id = u.id AND l.revoked = 0
                    AND (l.expires_at = 0 OR l.expires_at > ?)) AS active_keys,
            (SELECT MAX(expires_at) FROM licenses l WHERE l.user_id = u.id
                    AND l.revoked = 0 AND l.expires_at != 0) AS sub_until,
            (SELECT COUNT(*) FROM licenses l WHERE l.user_id = u.id AND l.hwid != '') AS bound_keys,
            (SELECT l.hwid FROM licenses l WHERE l.user_id = u.id AND l.hwid != '' LIMIT 1) AS bound_hwid
       FROM users u ${where} ORDER BY u.created_at DESC LIMIT 300`,
    now(), ...params
  );
  res.json({ ok: true, users: rows.map(u => ({
    ...publicUser(u),
    active_keys: u.active_keys,
    sub_until: u.sub_until || 0,
    bound_keys: u.bound_keys || 0,
    bound_hwid: u.bound_hwid || '',
    sessions: get('SELECT COUNT(*) c FROM sessions WHERE user_id = ? AND expires_at > ?', u.id, now()).c
  })) });
});

/** staff creates a customer (or admin creates a sub-user / reseller) */
app.post('/api/admin/users', requireStaff, rateLimit(20), (req, res) => {
  const { username, password, email = '', discord = '', role = 'user' } = req.body || {};
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_]{3,24}$/.test(name)) return bad(res, 'Username must be 3-24 chars (a-z, 0-9, _)');
  if (!password || String(password).length < 6) return bad(res, 'Password must be 6+ characters');
  if (get('SELECT id FROM users WHERE username = ?', name)) return bad(res, 'Username already taken');
  if (role !== 'user' && req.ctx.user.role !== 'admin') {
    return bad(res, 'Only admin can create reseller / admin accounts', 403);
  }
  run(
    `INSERT INTO users (username, password, email, discord, role, created_at, last_ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    name, hashPassword(password), String(email).slice(0, 100), String(discord).slice(0, 60),
    ['user', 'reseller', 'admin'].includes(role) ? role : 'user', now(), req.ip
  );
  log('admin', `Customer created: ${name}`, req.ip);
  res.json({ ok: true });
});

app.patch('/api/admin/users/:id', requireStaff, (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) return bad(res, 'Not found', 404);
  const actor = req.ctx.user;
  const isActorAdmin = actor.role === 'admin';
  if (u.role === 'admin' && !isActorAdmin) return bad(res, 'Admin accounts are admin-only', 403);
  const b = req.body || {};
  if (b.banned !== undefined) {
    run('UPDATE users SET banned = ? WHERE id = ?', b.banned ? 1 : 0, u.id);
    if (b.banned) run('DELETE FROM sessions WHERE user_id = ?', u.id);
    log('admin', `${u.username} ${b.banned ? 'BANNED' : 'unbanned'}`, req.ip);
  }
  if (b.role !== undefined && ['user', 'reseller', 'admin'].includes(b.role)) {
    if (b.role !== 'user' && !isActorAdmin) return bad(res, 'Only admin can change to reseller / admin', 403);
    run('UPDATE users SET role = ? WHERE id = ?', b.role, u.id);
    log('admin', `${u.username} role -> ${b.role}`, req.ip);
  }
  if (b.add_days !== undefined) {
    const extra = Number(b.add_days) || 0;
    let changed = 0;
    for (const k of all('SELECT * FROM licenses WHERE user_id = ? AND revoked = 0', u.id)) {
      const base = k.expires_at === 0 || k.expires_at < now() ? now() : k.expires_at;
      if (k.expires_at !== 0) {
        run('UPDATE licenses SET expires_at = ? WHERE id = ?', base + extra * DAY, k.id);
        changed++;
      }
    }
    log('admin', `${extra} days added to ${u.username} (${changed} keys)`, req.ip);
  }
  if (b.reset_hwid) {
    run('UPDATE licenses SET hwid = ? WHERE user_id = ?', '', u.id);
    run('UPDATE users SET hwid = ? WHERE id = ?', '', u.id);
    log('admin', `HWID reset for ${u.username}`, req.ip);
  }
  if (b.password) {
    if (String(b.password).length < 6) return bad(res, 'Password must be 6+ characters');
    run('UPDATE users SET password = ? WHERE id = ?', hashPassword(b.password), u.id);
    log('admin', `Password reset for ${u.username}`, req.ip);
  }
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireStaff, (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) return bad(res, 'Not found', 404);
  if (u.id === req.ctx.user.id) return bad(res, 'You cannot delete yourself');
  if (u.role === 'admin' && req.ctx.user.role !== 'admin') return bad(res, 'Admin accounts are admin-only', 403);
  const keyCount = get('SELECT COUNT(*) c FROM licenses WHERE user_id = ?', u.id);
  run('DELETE FROM users WHERE id = ?', u.id);
  log('admin', `User deleted: ${u.username}`, req.ip);

  /* ---------- Discord audit: account removed ---------- */
  audit(webhook.accountRemoved(req, {
    username: u.username,
    by: req.ctx.user.username,
    keys: keyCount ? keyCount.c : 0
  }));

  res.json({ ok: true });
});

/** bulk customer actions */
app.post('/api/admin/users/bulk', requireStaff, (req, res) => {
  const action = String((req.body && req.body.action) || '');
  const meId = req.ctx.user.id;
  if (['purge_users', 'ban_all'].includes(action) && req.ctx.user.role !== 'admin') {
    return bad(res, 'Only admin can run this bulk action', 403);
  }
  let changed = 0, msg = '';
  switch (action) {
    case 'reset_hwid':
      changed = run('UPDATE licenses SET hwid = ? WHERE revoked = 0', '').changes;
      run('UPDATE users SET hwid = ?', '');
      msg = `${changed} HWID lock(s) reset`;
      break;
    case 'unban_all':
      changed = run('UPDATE users SET banned = 0 WHERE banned = 1 AND id != ?', meId).changes;
      msg = `${changed} account(s) unbanned`;
      break;
    case 'ban_all':
      changed = run('UPDATE users SET banned = 1 WHERE banned = 0 AND id != ?', meId).changes;
      run('DELETE FROM sessions WHERE user_id != ?', meId);
      msg = `${changed} account(s) banned`;
      break;
    case 'purge_users':
      changed = run('DELETE FROM users WHERE id != ? AND role != ?', meId, 'admin').changes;
      msg = `${changed} user(s) purged`;
      break;
    default:
      return bad(res, 'Unknown bulk action');
  }
  log('admin', `Bulk "${action}": ${msg}`, req.ip);
  res.json({ ok: true, changed, message: msg });
});

/* -------------------------- logs/settings --------------------------- */

app.get('/api/admin/logs', requireAdmin, (req, res) => {
  const rows = all('SELECT * FROM logs ORDER BY id DESC LIMIT ?', Math.min(Number(req.query.limit) || 100, 500));
  res.json({ ok: true, logs: rows });
});

app.delete('/api/admin/logs', requireAdmin, (req, res) => {
  run('DELETE FROM logs');
  log('admin', 'Logs cleared', req.ip);
  res.json({ ok: true });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const keys = ['site_name', 'site_url', 'session_days', 'signup_open', 'discord_url',
                'discord_webhook', 'owner'];
  const out = {};
  for (const k of keys) out[k] = setting(k);
  res.json({ ok: true, settings: out });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const allowed = ['site_name', 'site_url', 'session_days', 'signup_open', 'discord_url',
                   'discord_webhook', 'owner'];
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      let v = String(req.body[k]).slice(0, 400).trim();
      if (k === 'discord_webhook' && v && !/^https?:\/\//i.test(v)) {
        return bad(res, 'Webhook must be a http(s) URL');
      }
      setSetting(k, v);
    }
  }
  log('admin', 'Site settings updated', req.ip);
  res.json({ ok: true });
});

/** Site Settings → "Send test" : ek sample embed Discord par bhejta hai */
app.post('/api/admin/settings/test-webhook', requireAdmin, async (req, res) => {
  const url = String(setting('discord_webhook', '') || '').trim();
  if (!url) return bad(res, 'Pehle webhook URL save karein');
  const r = await webhook.testEmbed(req);
  log('admin', `Webhook test: ${r.ok ? 'sent' : 'failed ' + (r.reason || r.status || '')}`, req.ip);
  res.json({ ok: r.ok, status: r.status || 0, reason: r.reason || '' });
});

/* ================================================================== */
/* static site + fallback                                              */
/* ================================================================== */

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'), err => {
    if (err) res.status(404).send('Not found');
  });
});

app.use((err, req, res, next) => {
  console.error(err.message || err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) log('error', String(err.message || err), req.ip);
  if (res.headersSent) return next(err);
  res.status(status).json({
    ok: false,
    error: err.type === 'entity.parse.failed' ? 'Invalid JSON body' : (err.message || 'Internal server error')
  });
});

app.listen(PORT, () => {
  const a = get("SELECT username, password FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  console.log('');
  console.log('  APEX AUTH panel running');
  console.log(`  Home    : http://localhost:${PORT}/`);
  console.log(`  Console : http://localhost:${PORT}/app.html`);
  console.log(`  API     : http://localhost:${PORT}/api/public/status`);
  if (a && verifyPassword('admin123', a.password)) {
    console.log(`  Admin   : ${a.username} / admin123  (change it after first login)`);
  } else {
    console.log(`  Admin   : ${a ? a.username : 'admin'} — login panel se karein (password badal chuka ho to)`);
  }
  console.log('');
  /* Render free = ephemeral disk -> data ko GitHub repo me mirror karo */
  backup.start(db);
});
