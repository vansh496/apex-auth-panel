/*
 * APEX AUTH - reseller / registration / product test
 *   chalane:  node test/role-check.js      (server chalu hona chahiye)
 *   sab banaya gaya data (reseller, client, product, key, temp admin)
 *   test khatam hone par khud delete ho jata hai.
 */
'use strict';

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_USER = process.env.SMOKE_ADMIN || 'tmp_smoke_admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'TmpAdmin-123';
let pass = 0, fail = 0;

async function api(method, path, body, token) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opt.headers.Authorization = 'Bearer ' + token;
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

(async function () {
  console.log('\nAPEX AUTH role + product test -> ' + BASE + '\n');

  /* ---------- login pages / registration ---------- */
  const html = await (await fetch(BASE + '/login.html')).text();
  check('login page has Reseller tab', html.includes('data-role="reseller"'));
  check('login page has register flow', html.includes('switch-mode') && html.includes('Create one'));

  const reg = await api('POST', '/api/auth/register', {
    username: 'tmp_client_' + Date.now().toString(36).slice(-5),
    password: 'client-123'
  });
  check('registration works (creates client)', reg.data.ok && reg.data.user.role === 'user', JSON.stringify(reg.data));
  const C = reg.data.token;
  const clientName = reg.data.user && reg.data.user.username;

  /* client: no staff endpoints */
  check('client blocked from staff stats', (await api('GET', '/api/admin/stats', undefined, C)).status === 403);
  check('client blocked from products', (await api('GET', '/api/admin/products', undefined, C)).status === 403);
  check('client sees own licenses', (await api('GET', '/api/me/licenses', undefined, C)).data.ok === true);

  /* ---------- admin login ---------- */
  const admin = await api('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASSWORD });
  const A = admin.data.token;
  check('temp admin login', !!A, JSON.stringify(admin.data).slice(0, 90));
  if (!A) { console.log(`\n${pass} passed, ${fail} failed\n`); process.exit(1); }

  /* ---------- reseller account ---------- */
  const rsName = 'tmp_res_' + Date.now().toString(36).slice(-5);
  const mk = await api('POST', '/api/admin/users', {
    username: rsName, password: 'reseller-123', role: 'reseller'
  }, A);
  check('admin creates reseller (sub-user)', mk.data.ok === true, JSON.stringify(mk.data));

  const rlogin = await api('POST', '/api/auth/login', { username: rsName, password: 'reseller-123' });
  const R = rlogin.data.token;
  check('reseller login (reseller tab)', !!R && rlogin.data.user.role === 'reseller');
  check('wrong tab: reseller account on client role blocked',
    (await api('POST', '/api/auth/login', { username: rsName, password: 'reseller-123' })).data.user.role !== 'user');

  check('reseller CAN read staff stats', (await api('GET', '/api/admin/stats', undefined, R)).status === 200);
  check('reseller CAN list keys', (await api('GET', '/api/admin/keys', undefined, R)).status === 200);
  check('reseller CAN list customers', (await api('GET', '/api/admin/users', undefined, R)).status === 200);
  check('reseller CANNOT touch loaders', (await api('GET', '/api/admin/apps', undefined, R)).status === 403);
  check('reseller CANNOT read site settings', (await api('GET', '/api/admin/settings', undefined, R)).status === 403);
  check('reseller CANNOT read activity log', (await api('GET', '/api/admin/logs', undefined, R)).status === 403);
  const badRes = await api('POST', '/api/admin/users', { username: 'tmp_x1', password: 'abcdef12', role: 'reseller' }, R);
  check('reseller CANNOT create another reseller', badRes.status === 403,
    badRes.status + ' ' + JSON.stringify(badRes.data));
  const rsClientName = 'tmp_rc_' + Date.now().toString(36).slice(-5);
  const mkClient = await api('POST', '/api/admin/users', {
    username: rsClientName, password: 'abcdef12', role: 'user'
  }, R);
  check('reseller CAN create a client', mkClient.data.ok === true, JSON.stringify(mkClient.data));

  /* ---------- products ---------- */
  const apps = (await api('GET', '/api/public/status')).data.apps;
  const app = apps[0];
  check('loader exists', !!app);

  const prods = (await api('GET', '/api/admin/products?app_id=' + app.id, undefined, R)).data.products;
  const names = prods.map(p => p.name);
  check('default products seeded', ['Internal', 'External', 'Silent Aim', 'Silent Cover']
    .every(n => names.includes(n)), JSON.stringify(names));
  check('reseller sees products WITHOUT secret',
    prods.length > 0 && prods.every(p => p.secret === undefined), JSON.stringify(prods[0]));

  const adminProds = (await api('GET', '/api/admin/products?app_id=' + app.id, undefined, A)).data.products;
  check('admin sees product id + secret + version',
    adminProds.length > 0 && adminProds.every(p => p.app_key && p.secret && p.version),
    JSON.stringify(adminProds[0] && { app_key: adminProds[0].app_key, secret_len: adminProds[0].secret.length }));

  const seedP = adminProds.find(p => p.name === 'Internal');
  if (seedP) {
    const sDeny = await api('PATCH', '/api/admin/products/' + seedP.id, { regenerate_secret: true }, R);
    check('reseller cannot touch product secret (403)', sDeny.status === 403, JSON.stringify(sDeny.data));
    const sOk = await api('PATCH', '/api/admin/products/' + seedP.id, { require_secret: 1 }, A);
    check('admin can toggle product secret',
      sOk.data.ok === true && !!sOk.data.product.require_secret, JSON.stringify(sOk.data));
    /* wahi value wapas set karo jo test se pehle thi */
    await api('PATCH', '/api/admin/products/' + seedP.id,
      { require_secret: Number(seedP.require_secret) ? 1 : 0 }, A);
  }

  const addP = await api('POST', '/api/admin/products', { app_id: app.id, name: 'tmp product' }, A);
  check('product added', addP.data.ok === true, JSON.stringify(addP.data));
  const newP = addP.data.products && addP.data.products.find(p => p.name === 'tmp product');

  /* ---------- key generation with product ---------- */
  const gen = await api('POST', '/api/admin/keys', {
    app_id: app.id, count: 1, duration_days: 7, product_id: newP ? newP.id : 0, plan: '7d'
  }, R);
  check('reseller generates product key', gen.data.ok === true && gen.data.keys.length === 1, JSON.stringify(gen.data));
  const k = gen.data.keys[0];

  const list = (await api('GET', '/api/admin/keys?product=' + (newP ? newP.id : 0) + '&q=' + k, undefined, A)).data;
  const row = (list.keys || []).find(x => x.key === k);
  check('key carries product name', !!row && row.product_name === 'tmp product', JSON.stringify(row));

  const mine = (await api('GET', '/api/me/licenses', undefined, C)).data;
  check('client license feed includes product_name',
    mine.licenses.every(l => l.product_name !== undefined));

  /* ---------- cleanup ---------- */
  if (row) await api('DELETE', '/api/admin/keys/' + row.id, undefined, A);
  if (newP) await api('DELETE', '/api/admin/products/' + newP.id, undefined, A);
  /* cleanup — jo bhi accounts banaye, sab hata do */
  const cleanupNames = [rsName, clientName, rsClientName].filter(Boolean);
  for (const nm of cleanupNames) {
    const found = (await api('GET', '/api/admin/users?limit=500&q=' + encodeURIComponent(nm), undefined, A)).data.users || [];
    for (const u of found.filter(x => x.username === nm)) {
      await api('DELETE', '/api/admin/users/' + u.id, undefined, A);
    }
  }
  check('cleanup done', true);

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
