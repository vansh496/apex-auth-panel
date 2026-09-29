/*
 * APEX AUTH - non-destructive smoke test
 *   chalane:  node test/smoke.js        (server chalu hona chahiye)
 *   ye test apna alag "smoke-test" loader banata hai, khatam karne par
 *   use delete kar deta hai — aapke asli data ko chhuta nahi.
 */
'use strict';

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_USER = process.env.SMOKE_ADMIN || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
let pass = 0, fail = 0;

async function api(method, path, body, token, extraHeaders) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opt.headers.Authorization = 'Bearer ' + token;
  if (extraHeaders) Object.assign(opt.headers, extraHeaders);
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opt);
  let data = {};
  try { data = await res.json(); } catch { }
  return { status: res.status, data };
}
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + String(extra).slice(0, 160) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function () {
  console.log('\nAPEX AUTH smoke test -> ' + BASE + '\n');

  /* ---------- pages ---------- */
  for (const [p, want] of [['/', 200], ['/login.html', 200], ['/app.html', 200], ['/nope', 404]]) {
    const r = await fetch(BASE + p);
    check('GET ' + p + ' -> ' + r.status, r.status === want);
  }

  /* ---------- auth ---------- */
  const st = await api('GET', '/api/public/status');
  check('public status + site name', st.data.ok && !!st.data.site);

  const admin = await api('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASSWORD });
  const A = admin.data.token;
  check('admin login', !!A, JSON.stringify(admin.data).slice(0, 90));
  if (!A) { console.log('\n' + pass + ' passed, ' + fail + ' failed (admin password changed? ADMIN_PASSWORD / SMOKE_ADMIN env use karein)\n'); process.exit(1); }

  check('wrong password rejected', (await api('POST', '/api/auth/login', { username: ADMIN_USER, password: 'nope' })).status === 401);
  check('bad token rejected', (await api('GET', '/api/auth/me', undefined, 'invalid')).status === 401);

  /* ---------- apna test loader ---------- */
  const slug = 'smoke-test';
  let app = (await api('GET', '/api/admin/apps', undefined, A)).data.apps.find(a => a.slug === slug);
  if (!app) {
    await api('POST', '/api/admin/apps', { name: 'Smoke Test', slug, description: 'automated test' }, A);
    app = (await api('GET', '/api/admin/apps', undefined, A)).data.apps.find(a => a.slug === slug);
  }
  check('test loader created', !!app);
  if (!app) { console.log('\n' + pass + ' passed, ' + fail + ' failed\n'); process.exit(1); }
  const id = app.id;

  /* ---------- online / offline / maintenance switch ---------- */
  await api('PATCH', '/api/admin/apps/' + id, { status: 'maintenance', maintenance_message: 'smoke maintenance', maintenance_until: Date.now() + 600000 }, A);
  const gate = await api('POST', '/api/loader/login', { app: slug, username: 'x', password: 'y' });
  check('maintenance blocks loader (503/MAINTENANCE)', gate.status === 503 && gate.data.code === 'MAINTENANCE', JSON.stringify(gate.data));
  const init = await api('POST', '/api/loader/init', { app: slug, version: '1.0.0' });
  check('init answers during maintenance', init.data.app.status === 'maintenance' && !!init.data.message);

  await api('PATCH', '/api/admin/apps/' + id, { status: 'offline', maintenance_message: '' }, A);
  const off = await api('POST', '/api/loader/login', { app: slug, username: 'x', password: 'y' });
  check('offline blocks loader (503/OFFLINE)', off.status === 503 && off.data.code === 'OFFLINE');

  await api('PATCH', '/api/admin/apps/' + id, { status: 'online', maintenance_message: '' }, A);
  check('back online', (await api('POST', '/api/loader/init', { app: slug, version: '1.0.0' })).data.app.status === 'online');

  /* ---------- app credentials (secret / app id) ---------- */
  const appRow = (await api('GET', '/api/admin/apps', undefined, A)).data.apps.find(a => a.id === id);
  check('app credentials issued (app id + secret + version)',
    !!(appRow && appRow.app_key && appRow.secret && appRow.version),
    JSON.stringify(appRow && { app_key: appRow.app_key, secret_len: appRow.secret.length }));

  const pubTxt = await (await fetch(BASE + '/api/public/status')).text();
  check('secret never leaks in public API', !!appRow && !pubTxt.includes(appRow.secret));
  const pubApp = (JSON.parse(pubTxt).apps || []).find(a => a.id === id);
  check('public app carries app id (not secret)', !!pubApp && pubApp.app_key === appRow.app_key);

  await api('PATCH', '/api/admin/apps/' + id, { require_secret: 1 }, A);
  const noSec = await api('POST', '/api/loader/init', { app: slug, version: '1.0.0' });
  const badSec = await api('POST', '/api/loader/init', { app: slug, version: '1.0.0' },
    undefined, { 'x-api-key': 'wrong-secret-123456' });
  const goodSec = await api('POST', '/api/loader/init', { app: slug, version: '1.0.0' },
    undefined, { 'x-api-key': appRow.secret });
  check('require secret: missing -> 403 BAD_SECRET',
    noSec.status === 403 && noSec.data.code === 'BAD_SECRET', JSON.stringify(noSec.data));
  check('require secret: wrong -> 403', badSec.status === 403, JSON.stringify(badSec.data));
  check('require secret: correct -> loader works',
    goodSec.data.ok === true && goodSec.data.app.status === 'online', JSON.stringify(goodSec.data).slice(0, 120));
  await api('PATCH', '/api/admin/apps/' + id, { require_secret: 0 }, A);
  check('secret toggle restored (loader works again)',
    (await api('POST', '/api/loader/init', { app: slug, version: '1.0.0' })).data.ok === true);

  /* app lock product ke saath bhi lagta hai (product field app lock ko bypass nahi karta) */
  await api('PATCH', '/api/admin/apps/' + id, { require_secret: 1 }, A);
  const withProd = await api('POST', '/api/loader/init', { app: slug, product: 'External', version: '1.0.0' });
  const withProdSec = await api('POST', '/api/loader/init', { app: slug, product: 'External', version: '1.0.0' },
    undefined, { 'x-api-key': appRow.secret });
  check('app lock stays with product field',
    withProd.status === 403 && withProd.data.code === 'BAD_SECRET', JSON.stringify(withProd.data));
  check('loader (master) secret accepted with product',
    withProdSec.data.ok === true && withProdSec.data.app.status === 'online', JSON.stringify(withProdSec.data).slice(0, 120));
  await api('PATCH', '/api/admin/apps/' + id, { require_secret: 0 }, A);

  /* ---------- product credentials (per product secret) ---------- */
  const prods = (await api('GET', '/api/admin/products?app_id=' + id, undefined, A)).data.products || [];
  check('every product has its own id + secret + version',
    prods.length === 4 && prods.every(p => p.app_key && p.secret && p.version),
    JSON.stringify(prods.map(p => p.name)));
  check('product secrets are unique',
    new Set(prods.map(p => p.secret)).size === prods.length && !prods.some(p => p.secret === appRow.secret));

  const prodIn = prods.find(p => p.name === 'Internal');
  await api('PATCH', '/api/admin/products/' + prodIn.id, { require_secret: 1 }, A);
  const pNo = await api('POST', '/api/loader/init', { app: slug, product: 'Internal', version: '1.0.0' });
  const pBad = await api('POST', '/api/loader/init', { app: slug, product: 'Internal', version: '1.0.0' },
    undefined, { 'x-api-key': 'z'.repeat(48) });
  const pOk = await api('POST', '/api/loader/init', { app: slug, product: 'Internal', version: '1.0.0' },
    undefined, { 'x-api-key': prodIn.secret });
  const pOther = await api('POST', '/api/loader/init', { app: slug, product: 'External', version: '1.0.0' });
  const pById = await api('POST', '/api/loader/init', { app: slug, product: prodIn.id, version: '1.0.0' },
    undefined, { 'x-api-key': prodIn.secret });
  check('product secret: missing -> 403 BAD_SECRET', pNo.status === 403 && pNo.data.code === 'BAD_SECRET', JSON.stringify(pNo.data));
  check('product secret: wrong -> 403', pBad.status === 403, JSON.stringify(pBad.data));
  check('product secret: correct -> ok + product echoed',
    pOk.data.ok === true && pOk.data.product && pOk.data.product.name === 'Internal', JSON.stringify(pOk.data.product));
  check('product identified by id too', pById.data.ok === true && pById.data.product.id === prodIn.id);
  check('other product stays free', pOther.data.ok === true && pOther.data.product.name === 'External');
  await api('PATCH', '/api/admin/products/' + prodIn.id, { require_secret: 0 }, A);
  check('product secret toggle restored',
    (await api('POST', '/api/loader/init', { app: slug, product: 'Internal', version: '1.0.0' })).data.ok === true);

  /* ---------- keys ---------- */
  const gen = await api('POST', '/api/admin/keys',
    { app_id: id, count: 2, duration_days: 30, plan: 'Monthly', prefix: 'smoke', user_limit: 1 }, A);
  check('generate 2 keys', (gen.data.keys || []).length === 2, JSON.stringify(gen.data));
  check('prefix format', /^SMOKE-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test((gen.data.keys || [''])[0]), (gen.data.keys || [''])[0]);

  const custom = await api('POST', '/api/admin/keys',
    { app_id: id, custom_key: 'SMOKE-CUSTOM-KEY-0001', duration_days: 0, plan: 'Lifetime' }, A);
  check('custom key honoured', (custom.data.keys || [])[0] === 'SMOKE-CUSTOM-KEY-0001', JSON.stringify(custom.data));

  const dup = await api('POST', '/api/admin/keys', { app_id: id, custom_key: 'SMOKE-CUSTOM-KEY-0001' }, A);
  check('duplicate custom key rejected', !dup.data.ok, JSON.stringify(dup.data));

  /* ---------- register + activate ---------- */
  const uname = 'smoke_' + Date.now().toString(36);
  const reg = await api('POST', '/api/auth/register', { username: uname, password: 'smoke1234' });
  check('register client', !!reg.data.token);
  const userId = reg.data.user && reg.data.user.id;

  const ll = await api('POST', '/api/loader/login', { app: slug, username: uname, password: 'smoke1234', hwid: 'SMOKE-HWID' });
  check('loader login', ll.data.ok && !!ll.data.token);

  const act = await api('POST', '/api/loader/activate',
    { app: slug, key: gen.data.keys[0], hwid: 'SMOKE-HWID' }, ll.data.token);
  check('activate binds hwid', act.data.ok && act.data.license.hwid === 'SMOKE-HWID', JSON.stringify(act.data).slice(0, 140));

  const reAct = await api('POST', '/api/loader/activate',
    { app: slug, key: gen.data.keys[0], hwid: 'DIFFERENT-HWID' }, ll.data.token);
  check('foreign hwid rejected', !reAct.data.ok, JSON.stringify(reAct.data));

  const second = await api('POST', '/api/auth/register', { username: 'smoke2_' + Date.now().toString(36), password: 'smoke1234' });
  const ll2 = await api('POST', '/api/loader/login',
    { app: slug, username: second.data.user.username, password: 'smoke1234', hwid: 'HWID-2' });
  const steal = await api('POST', '/api/loader/activate',
    { app: slug, key: gen.data.keys[0], hwid: 'HWID-2' }, ll2.data.token);
  check('single-user key cannot be re-claimed', !steal.data.ok, JSON.stringify(steal.data));

  /* ---------- key-only (guest) flow — bina login (AdiAuth style loader) ---------- */
  const gKeys = (await api('POST', '/api/admin/keys',
    { app_id: id, count: 1, duration_days: 0, plan: 'Lifetime', prefix: 'guest' }, A)).data.keys || [];
  const gKey = gKeys[0];
  const gAct = await api('POST', '/api/loader/activate', { app: slug, key: gKey, hwid: 'GUEST-HWID' });
  check('guest activate without login',
    gAct.data.ok === true && gAct.data.guest === true && gAct.data.license.hwid === 'GUEST-HWID',
    JSON.stringify(gAct.data).slice(0, 150));
  const gReset = await api('POST', '/api/loader/reset-hwid', { app: slug, key: gKey });
  check('guest hwid reset', gReset.data.ok === true && gReset.data.reset === 1, JSON.stringify(gReset.data));
  const gAgain = await api('POST', '/api/loader/activate', { app: slug, key: gKey, hwid: 'GUEST-HWID-2' });
  check('guest re-activate after reset',
    gAgain.data.ok === true && gAgain.data.license.hwid === 'GUEST-HWID-2', JSON.stringify(gAgain.data).slice(0, 150));
  const gSteal = await api('POST', '/api/loader/activate', { app: slug, key: gen.data.keys[0], hwid: 'GUEST-HWID' });
  check('account-linked key not usable guest-style', gSteal.status === 401, JSON.stringify(gSteal.data));
  const gResetClaimed = await api('POST', '/api/loader/reset-hwid', { app: slug, key: gen.data.keys[0] });
  check('guest reset rejected for claimed key', gResetClaimed.status === 401, JSON.stringify(gResetClaimed.data));

  /* ---------- Discord webhook (realtime audit) ---------- */
  const { createServer } = require('node:http');
  let hookBody = null;
  const receiver = createServer((rq, rs) => {
    let b = '';
    rq.on('data', c => b += c);
    rq.on('end', () => { hookBody = b; rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end('{"ok":true}'); });
  });
  await new Promise(r => receiver.listen(0, '127.0.0.1', r));
  const hookUrl = 'http://127.0.0.1:' + receiver.address().port + '/hook';
  const hookBefore = (await api('GET', '/api/admin/settings', undefined, A)).data.settings.discord_webhook || '';
  await api('PUT', '/api/admin/settings', { discord_webhook: hookUrl }, A);

  const wKey = (await api('POST', '/api/admin/keys',
    { app_id: id, count: 1, duration_days: 0, plan: 'Monthly', prefix: 'hook' }, A)).data.keys[0];
  await api('POST', '/api/loader/activate', { app: slug, key: wKey, hwid: 'HOOK-HWID' });
  for (let i = 0; i < 90 && !hookBody; i++) await sleep(100);   // public IP + geo lookup ka time

  const wj = hookBody ? JSON.parse(hookBody) : null;
  const wf = (wj && wj.embeds && wj.embeds[0] && wj.embeds[0].fields) || [];
  const has = n => wf.some(f => f.name.includes(n));
  check('webhook fired on key use', !!(wj && wj.embeds && wj.embeds.length), String(hookBody).slice(0, 140));
  check('webhook embed carries ip/location/product/hwid',
    has('IP Address') && has('Location') && has('Product') && has('HWID') && has('Plan') && has('License Key'),
    JSON.stringify(wf.map(f => f.name)));
  check('webhook embed masks the license key',
    wf.some(f => f.name.includes('License Key') && f.value.includes('****')),
    JSON.stringify(wf.find(f => f.name.includes('License Key'))));

  hookBody = null;
  const hookTest = await api('POST', '/api/admin/settings/test-webhook', {}, A);
  for (let i = 0; i < 60 && !hookBody; i++) await sleep(100);
  check('webhook test endpoint delivers', hookTest.data.ok === true && !!hookBody, JSON.stringify(hookTest.data));

  /* login par webhook NAHI aana chahiye — sirf key use par */
  hookBody = null;
  await api('POST', '/api/loader/login',
    { app: slug, username: uname, password: 'smoke1234', hwid: 'SMOKE-HWID' });
  await sleep(500);
  check('login does NOT fire webhook (sirf key use par)', hookBody === null,
    String(hookBody).slice(0, 140));

  await api('PUT', '/api/admin/settings', { discord_webhook: hookBefore }, A);
  receiver.close();

  const ping = await api('POST', '/api/loader/ping', { app: slug }, ll.data.token);
  check('heartbeat', ping.data.ok);

  /* ---------- permissions ---------- */
  check('client blocked from admin api', (await api('GET', '/api/admin/stats', undefined, ll.data.token)).status === 403);
  check('stats shape', (await api('GET', '/api/admin/stats', undefined, A)).data.stats.keys >= 0);

  /* ---------- bulk (sirf test app ke against) ---------- */
  const bu = await api('POST', '/api/admin/keys/bulk', { action: 'delete_unused', app_id: id }, A);
  check('bulk delete_unused scoped', bu.data.ok && typeof bu.data.changed === 'number', JSON.stringify(bu.data));
  const pa = await api('POST', '/api/admin/keys/bulk', { action: 'pause_all', app_id: id }, A);
  check('bulk pause_all', pa.data.ok, JSON.stringify(pa.data));
  const rs = await api('POST', '/api/admin/keys/bulk', { action: 'reset_hwid', app_id: id }, A);
  check('bulk reset_hwid', rs.data.ok, JSON.stringify(rs.data));

  /* ---------- cleanup: apna test data ---------- */
  await api('DELETE', '/api/admin/apps/' + id, undefined, A);
  if (userId) await api('DELETE', '/api/admin/users/' + userId, undefined, A);
  if (second.data.user) await api('DELETE', '/api/admin/users/' + second.data.user.id, undefined, A);
  const left = (await api('GET', '/api/admin/apps', undefined, A)).data.apps.find(a => a.slug === slug);
  check('test loader cleaned up', !left);

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('smoke crashed:', e.message); process.exit(1); });
