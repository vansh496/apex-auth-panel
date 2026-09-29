'use strict';

/**
 * db.js - SQLite database layer (uses Node's built-in node:sqlite, zero native deps)
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'panel.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password      TEXT NOT NULL,
  email         TEXT DEFAULT '',
  discord       TEXT DEFAULT '',
  hwid          TEXT DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user',
  banned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login    INTEGER DEFAULT 0,
  last_ip       TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS apps (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL,
  slug                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description          TEXT DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'online',   -- online | offline | maintenance
  maintenance_message  TEXT DEFAULT '',
  maintenance_until    INTEGER DEFAULT 0,
  version              TEXT DEFAULT '1.0.0',
  download_url         TEXT DEFAULT '',
  changelog            TEXT DEFAULT '',
  require_key          INTEGER NOT NULL DEFAULT 1,
  app_key              TEXT DEFAULT '',        -- public app id (loader init me bheja jata hai)
  secret               TEXT DEFAULT '',        -- app secret (loader se header me aata hai)
  require_secret       INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id         INTEGER NOT NULL,
  name           TEXT NOT NULL,
  slug           TEXT DEFAULT '',
  version        TEXT DEFAULT '1.0.0',
  app_key        TEXT DEFAULT '',        -- product ka apna app id (har build alag)
  secret         TEXT DEFAULT '',        -- product ka apna secret
  require_secret INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id       INTEGER NOT NULL,
  product_id   INTEGER NOT NULL DEFAULT 0,
  license_key  TEXT NOT NULL UNIQUE,
  user_id      INTEGER DEFAULT 0,
  hwid         TEXT DEFAULT '',
  plan         TEXT DEFAULT 'default',
  duration_days INTEGER NOT NULL DEFAULT 30,   -- 0 = lifetime
  expires_at   INTEGER NOT NULL DEFAULT 0,     -- 0 = lifetime
  user_limit   INTEGER NOT NULL DEFAULT 1,     -- 1 = single account, 0 = unlimited
  revoked      INTEGER NOT NULL DEFAULT 0,
  note         TEXT DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_used    INTEGER DEFAULT 0,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  hwid        TEXT DEFAULT '',
  ip          TEXT DEFAULT '',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,           -- info | login | key | admin | error
  message    TEXT NOT NULL,
  ip         TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/* migrations — safe for old databases --------------------------------- */
const licenseCols = db.prepare('PRAGMA table_info(licenses)').all().map(c => c.name);
if (!licenseCols.includes('user_limit')) {
  db.exec('ALTER TABLE licenses ADD COLUMN user_limit INTEGER NOT NULL DEFAULT 1');
}
if (!licenseCols.includes('product_id')) {
  db.exec('ALTER TABLE licenses ADD COLUMN product_id INTEGER NOT NULL DEFAULT 0');
}
const prodCols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
if (!prodCols.includes('version')) db.exec("ALTER TABLE products ADD COLUMN version TEXT DEFAULT '1.0.0'");
if (!prodCols.includes('app_key')) db.exec("ALTER TABLE products ADD COLUMN app_key TEXT DEFAULT ''");
if (!prodCols.includes('secret')) db.exec("ALTER TABLE products ADD COLUMN secret TEXT DEFAULT ''");
if (!prodCols.includes('require_secret')) {
  db.exec('ALTER TABLE products ADD COLUMN require_secret INTEGER NOT NULL DEFAULT 0');
}
const appCols = db.prepare('PRAGMA table_info(apps)').all().map(c => c.name);
if (!appCols.includes('app_key')) db.exec('ALTER TABLE apps ADD COLUMN app_key TEXT DEFAULT \'\'');
if (!appCols.includes('secret')) db.exec('ALTER TABLE apps ADD COLUMN secret TEXT DEFAULT \'\'');
if (!appCols.includes('require_secret')) {
  db.exec('ALTER TABLE apps ADD COLUMN require_secret INTEGER NOT NULL DEFAULT 0');
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const now = () => Date.now();

function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}
function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}
function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

function setting(key, fallback = '') {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    String(value)
  );
}

function log(type, message, ip = '') {
  run('INSERT INTO logs (type, message, ip, created_at) VALUES (?, ?, ?, ?)',
    type, message, ip, now());
}

/* default products for the key generator ------------------------------ */
const DEFAULT_PRODUCTS = ['Internal', 'External', 'Silent Aim', 'Silent Cover'];
function seedProducts(appId) {
  if (!get('SELECT COUNT(*) AS c FROM products WHERE app_id = ?', appId).c) {
    for (const p of DEFAULT_PRODUCTS) {
      run('INSERT INTO products (app_id, name, slug, version, app_key, secret, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        appId, p, p.toLowerCase().replace(/\s+/g, '-'), '1.0.0',
        'prd_' + crypto.randomBytes(8).toString('hex'),
        crypto.randomBytes(24).toString('hex'),
        now());
    }
  }
}

/* password hashing: scrypt + random salt -------------------------------- */
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, 64).toString('hex');
  return `${s}:${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(check, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/* license key generator:
   default            -> XXXXX-XXXXX-XXXXX-XXXXX
   with prefix        -> prefix-XXXX-XXXX-XXXX                                */
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomBlock(len) {
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
  return out;
}
function generateKey(prefix) {
  const p = String(prefix || '').trim().replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
  if (p) return `${p}-${randomBlock(4)}-${randomBlock(4)}-${randomBlock(4)}`;
  return `${randomBlock(5)}-${randomBlock(5)}-${randomBlock(5)}-${randomBlock(5)}`;
}

/* session tokens -------------------------------------------------------- */
function createSession(userId, ttlMs, hwid = '', ip = '') {
  const token = crypto.randomBytes(32).toString('hex');
  const created = now();
  const expires = created + ttlMs;
  run(
    'INSERT INTO sessions (token, user_id, hwid, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    token, userId, hwid, ip, created, expires
  );
  return { token, expires };
}

function getSession(token) {
  if (!token) return null;
  const row = get('SELECT * FROM sessions WHERE token = ?', token);
  if (!row) return null;
  if (row.expires_at < now()) {
    run('DELETE FROM sessions WHERE token = ?', token);
    return null;
  }
  return row;
}

function destroySession(token) {
  run('DELETE FROM sessions WHERE token = ?', token);
}

/* seed data -------------------------------------------------------------- */
function seed() {
  const userCount = get('SELECT COUNT(*) AS c FROM users').c;
  if (userCount === 0) {
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    run(
      `INSERT INTO users (username, password, email, discord, role, created_at)
       VALUES (?, ?, '', '', 'admin', ?)`,
      'admin',
      hashPassword(adminPass),
      now()
    );
    log('admin', `Admin account created: admin / ${adminPass}`);
    console.log(`\n  [!] Default admin account ->  admin / ${adminPass}\n  [!] Change it after first login.\n`);
  }

  const appCount = get('SELECT COUNT(*) AS c FROM apps').c;
  if (appCount === 0) {
    run(
      `INSERT INTO apps (name, slug, description, status, version, changelog, require_key, created_at)
       VALUES (?, ?, ?, 'online', ?, ?, 1, ?)`,
      'APEX LOADER',
      'apex',
      'Main loader application',
      '1.0.0',
      'Initial release',
      now()
    );
    log('info', 'Default loader app created: apex');
  }
  /* har loader ke liye default products (Internal / External / Silent Aim / Silent Cover) */
  for (const a of all('SELECT id FROM apps')) seedProducts(a.id);
  /* har loader ke app credentials (app id + secret) */
  for (const a of all('SELECT id, app_key, secret FROM apps')) {
    if (!a.app_key || !a.secret) {
      run('UPDATE apps SET app_key = ?, secret = ? WHERE id = ?',
        a.app_key || 'app_' + crypto.randomBytes(8).toString('hex'),
        a.secret || crypto.randomBytes(24).toString('hex'),
        a.id);
    }
  }
  /* migration: delete hone wale loaders ke orphan products safai */
  run('DELETE FROM products WHERE app_id NOT IN (SELECT id FROM apps)');
  run('UPDATE licenses SET product_id = 0 WHERE product_id NOT IN (SELECT id FROM products)');
  /* har product ke apne credentials (app id + secret + version) */
  for (const p of all('SELECT id, app_key, secret FROM products')) {
    if (!p.app_key || !p.secret) {
      run('UPDATE products SET app_key = ?, secret = ? WHERE id = ?',
        p.app_key || 'prd_' + crypto.randomBytes(8).toString('hex'),
        p.secret || crypto.randomBytes(24).toString('hex'),
        p.id);
    }
  }

  const defaults = {
    site_name: 'APEX AUTH',
    site_url: 'http://localhost:3000',
    session_days: '30',
    signup_open: '1',
    discord_url: '',
    discord_webhook: '',
    owner: 'APEX'
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (setting(k, '__none__') === '__none__') setSetting(k, v);
  }
}

seed();

module.exports = {
  db,
  now,
  get,
  all,
  run,
  setting,
  setSetting,
  log,
  hashPassword,
  verifyPassword,
  generateKey,
  seedProducts,
  createSession,
  getSession,
  destroySession
};
