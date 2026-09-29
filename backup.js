'use strict';

/**
 * backup.js - panel.db ka GitHub mirror
 * ---------------------------------------------------------------
 * Render free plan par filesystem ephemeral hai: har deploy/restart
 * pe data/panel.db mit jata hai. Is module ko do tarike se use kiya
 * jata hai:
 *
 *   1) CLI (db.js boot se pehle chalata hai):
 *        node backup.js pull
 *      -> snapshot download karke local DB ko replace karta hai,
 *         SIRF tab jab local DB missing ya "fresh seed" ho.
 *         (Asli data ko kabhi uchhala nahi jata.)
 *
 *   2) In-process (server.js listen ke baad):
 *        require('./backup').start(db)
 *      -> har BACKUP_INTERVAL_MS (default 60s) me checkpoint + push,
 *         sirf tab jab bytes badle hon. SIGTERM/SIGINT pe ek final
 *         push (Render restart se pehle).
 *
 * Env:
 *   BACKUP_TOKEN   GitHub PAT (repo scope)      -> required
 *   BACKUP_REPO    "owner/name"                 -> required
 *   BACKUP_BRANCH  default "main"
 *   BACKUP_FILE    snapshot file name, default "panel.db"
 *   BACKUP_DB_PATH local DB path (default data/panel.db)
 *   BACKUP_INTERVAL_MS default 60000
 * ---------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const API = 'https://api.github.com';

const TOKEN = String(process.env.BACKUP_TOKEN || '').trim();
const REPO = String(process.env.BACKUP_REPO || '').trim();
const BRANCH = String(process.env.BACKUP_BRANCH || 'main').trim();
const DB_FILE = String(process.env.BACKUP_FILE || 'panel.db').trim();
const META_FILE = DB_FILE + '.meta.json';
const DB_PATH = process.env.BACKUP_DB_PATH || path.join(__dirname, 'data', 'panel.db');
const INTERVAL = Math.max(15000, Number(process.env.BACKUP_INTERVAL_MS || 60000));

const enabled = Boolean(TOKEN) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(REPO);

let lastHash = '';
let busy = false;

function say(...a) {
  console.log('  [backup]', ...a);
}

/* ---------- GitHub helpers -------------------------------------- */

async function gh(url, opts = {}) {
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'apex-panel-backup',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(opts.headers || {})
  };
  const init = { method: opts.method || 'GET', headers };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const res = await fetch(API + url, init);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = text;
  }
  return { status: res.status, data };
}

async function ghRaw(url) {
  const res = await fetch(API + url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github.raw',
      'User-Agent': 'apex-panel-backup',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!res.ok) return { status: res.status, buf: null };
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

const refOf = (f) => encodeURIComponent(f) + '?ref=' + encodeURIComponent(BRANCH);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/* ---------- local DB ka haal ------------------------------------ */

/**
 * @returns {{exists:boolean, fresh:boolean, users:number, licenses:number, reason:string}}
 */
function inspectLocal() {
  if (!fs.existsSync(DB_PATH)) {
    return { exists: false, fresh: true, users: 0, licenses: 0, reason: 'local db missing' };
  }
  let d = null;
  try {
    d = new DatabaseSync(DB_PATH);
    const u = d.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const l = d.prepare('SELECT COUNT(*) AS c FROM licenses').get().c;
    return { exists: true, fresh: u <= 1 && l === 0, users: u, licenses: l, reason: `users=${u} licenses=${l}` };
  } catch (e) {
    return { exists: true, fresh: true, users: 0, licenses: 0, reason: 'unreadable (' + e.message + ')' };
  } finally {
    try { if (d) d.close(); } catch (_) {}
  }
}

/* ---------- 1) PULL --------------------------------------------- */

async function pull() {
  if (!enabled) return { restored: false, reason: 'disabled' };

  const meta = await gh('/repos/' + REPO + '/contents/' + refOf(META_FILE));
  if (meta.status === 404) return { restored: false, reason: 'snapshot nahi hai (pehli baar)' };
  if (meta.status !== 200) return { restored: false, reason: 'meta http ' + meta.status };

  let savedAt = 0;
  try {
    const raw = Buffer.from(meta.data.content, 'base64').toString('utf8');
    savedAt = JSON.parse(raw).savedAt || 0;
  } catch (_) {}

  const local = inspectLocal();
  if (local.exists && !local.fresh) {
    return { restored: false, reason: 'local data rakha gaya (' + local.reason + ')' };
  }

  const got = await ghRaw('/repos/' + REPO + '/contents/' + refOf(DB_FILE));
  if (got.status !== 200 || !got.buf || !got.buf.length) {
    return { restored: false, reason: 'download http ' + got.status };
  }

  const tmp = DB_PATH + '.pull.tmp';
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(tmp, got.buf);
  fs.renameSync(tmp, DB_PATH);
  for (const side of ['-wal', '-shm']) {
    try { if (fs.existsSync(DB_PATH + side)) fs.unlinkSync(DB_PATH + side); } catch (_) {}
  }
  lastHash = sha256(got.buf);
  return { restored: true, size: got.buf.length, savedAt, reason: local.reason };
}

/* ---------- 2) PUSH --------------------------------------------- */

async function push(db) {
  if (!enabled) return { pushed: false, reason: 'disabled' };
  if (busy) return { pushed: false, reason: 'pehle wala push chal raha hai' };
  busy = true;
  try {
    if (!fs.existsSync(DB_PATH)) return { pushed: false, reason: 'local db nahi hai' };

    /* WAL ko main file me bhijwao taaki poora data file me ho */
    if (db && db.db) {
      try { db.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (_) {}
    }

    const bytes = fs.readFileSync(DB_PATH);
    const hash = sha256(bytes);
    if (hash === lastHash) return { pushed: false, reason: 'unchanged' };

    const existing = await gh('/repos/' + REPO + '/contents/' + refOf(DB_FILE));
    const snapshotExists = existing.status === 200;

    /* guard: khali/fresh DB good snapshot ko overwrite na kare */
    if (snapshotExists && db) {
      let licenses = -1;
      try { licenses = db.get('SELECT COUNT(*) AS c FROM licenses').c; } catch (_) {}
      if (licenses === 0) return { pushed: false, reason: 'guard: local khali hai, snapshot bachaya' };
    }

    const meta = { savedAt: Date.now(), sha256: hash, size: bytes.length };

    const ref = await gh('/repos/' + REPO + '/git/ref/heads/' + encodeURIComponent(BRANCH));
    if (ref.status !== 200) return { pushed: false, reason: 'ref http ' + ref.status };
    const headSha = ref.data.object.sha;

    const head = await gh('/repos/' + REPO + '/git/commits/' + headSha);
    if (head.status !== 200) return { pushed: false, reason: 'head commit http ' + head.status };
    const baseTree = head.data.tree.sha;

    const blob1 = await gh('/repos/' + REPO + '/git/blobs', {
      method: 'POST',
      body: { content: bytes.toString('base64'), encoding: 'base64' }
    });
    if (blob1.status !== 201) return { pushed: false, reason: 'blob http ' + blob1.status };

    const blob2 = await gh('/repos/' + REPO + '/git/blobs', {
      method: 'POST',
      body: { content: Buffer.from(JSON.stringify(meta)).toString('base64'), encoding: 'base64' }
    });
    if (blob2.status !== 201) return { pushed: false, reason: 'meta blob http ' + blob2.status };

    const tree = await gh('/repos/' + REPO + '/git/trees', {
      method: 'POST',
      body: {
        base_tree: baseTree,
        tree: [
          { path: DB_FILE, mode: '100644', type: 'blob', sha: blob1.data.sha },
          { path: META_FILE, mode: '100644', type: 'blob', sha: blob2.data.sha }
        ]
      }
    });
    if (tree.status !== 201) return { pushed: false, reason: 'tree http ' + tree.status };

    const c = await gh('/repos/' + REPO + '/git/commits', {
      method: 'POST',
      body: {
        message: `backup ${new Date(meta.savedAt).toISOString()} (${bytes.length}B)`,
        tree: tree.data.sha,
        parents: [headSha]
      }
    });
    if (c.status !== 201) return { pushed: false, reason: 'commit http ' + c.status };

    const upd = await gh('/repos/' + REPO + '/git/refs/heads/' + encodeURIComponent(BRANCH), {
      method: 'PATCH',
      body: { sha: c.data.sha }
    });
    if (upd.status !== 200) return { pushed: false, reason: 'ref update http ' + upd.status };

    lastHash = hash;
    return { pushed: true, size: bytes.length, sha: hash.slice(0, 12), licenses: snapshotExists ? 'n/a' : 'first' };
  } finally {
    busy = false;
  }
}

/* ---------- in-process scheduler -------------------------------- */

function start(db, onLog) {
  if (!enabled) {
    say('disabled (BACKUP_TOKEN/BACKUP_REPO nahi mile) — data sirf local rahega');
    return false;
  }
  const note = typeof onLog === 'function' ? onLog : say;

  const tick = () => {
    push(db)
      .then((r) => { if (r.pushed) note('pushed', r.size + 'B', 'sha=' + r.sha); })
      .catch((e) => note('push FAILED:', e.message));
  };

  setInterval(tick, INTERVAL).unref();
  tick();

  const bye = (sig) => {
    say(sig + ' mila — final push...');
    push(db)
      .then((r) => say(r.pushed ? 'final push OK (' + r.size + 'B)' : 'final push skip: ' + r.reason))
      .catch((e) => say('final push FAILED: ' + e.message))
      .then(() => process.exit(0));
  };
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('SIGINT', () => bye('SIGINT'));
  say('scheduler ON — har ' + Math.round(INTERVAL / 1000) + 's (sirf jab data badla)');
  return true;
}

async function flush(db) {
  if (!enabled) return { pushed: false, reason: 'disabled' };
  return push(db);
}

/* ---------- CLI --------------------------------------------------- */

async function cli() {
  const mode = (process.argv[2] || 'pull').toLowerCase();
  if (mode === 'pull') {
    const r = await pull();
    say('pull:', r.restored ? `RESTORED ${r.size}B (${r.reason})` : 'skip — ' + r.reason);
    process.exit(0);
  }
  if (mode === 'push') {
    /* CLI push: apna connection le kar checkpoint kare */
    let d = null;
    if (fs.existsSync(DB_PATH)) {
      try {
        d = new DatabaseSync(DB_PATH);
        d.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch (_) { d = null; }
    }
    const fake = {
      db: d,
      get: (sql) => (d ? d.prepare(sql).get() : { c: -1 })
    };
    const r = await push(fake);
    say('push:', r.pushed ? `OK ${r.size}B sha=${r.sha}` : 'skip — ' + r.reason);
    if (d) { try { d.close(); } catch (_) {} }
    process.exit(r.pushed || r.reason === 'unchanged' ? 0 : 1);
  }
  say('usage: node backup.js [pull|push]');
  process.exit(2);
}

module.exports = { enabled, pull, push, start, flush, DB_PATH, INTERVAL };

if (require.main === module) {
  cli().catch((e) => {
    say('ERROR:', e.message);
    process.exit(1);
  });
}
