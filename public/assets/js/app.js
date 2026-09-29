'use strict';

/* =========================================================
   APEX AUTH console
   ========================================================= */

const S = {
  me: null, admin: false, staff: false, apps: [], keys: [], users: [], logs: [],
  settings: null, products: [], section: 'dashboard',
  keyFilter: 'all', keyQ: '', keyApp: '', keyProduct: '', userQ: '', limit: 1,
  credApp: 0, showSecret: false,
  pcreds: [], pcredApp: 0, showPSecret: false
};

const SECTIONS = {
  dashboard: 'Dashboard', loaders: 'Loaders', customers: 'Customers',
  licenses: 'Licenses', logs: 'Activity Log', settings: 'Settings'
};
const ADMIN_ONLY = ['loaders', 'logs', 'customers'];
const STAFF_ONLY = [];

/* ------------------------------------------------ boot */
(async function init() {
  if (!API.token) { location.href = '/login.html'; return; }
  try { S.me = (await API.get('/api/auth/me')).user; }
  catch { location.href = '/login.html'; return; }

  S.admin = S.me.role === 'admin';
  S.staff = ['admin', 'reseller'].includes(S.me.role);
  const initials = (S.me.username || '?').slice(0, 1).toUpperCase();
  $('#me-name').textContent = S.me.username;
  $('#me-role').textContent = S.admin ? 'Owner' : S.me.role === 'reseller' ? 'Reseller' : 'Client';
  $('#me-avatar').textContent = initials;
  $('#top-avatar').textContent = initials;
  if (S.me.role === 'reseller') $('#me-avatar').className = 'avatar';

  if (!S.admin) {
    $$('[data-admin]').forEach(b => b.classList.add('hidden'));
    $('#site-settings-panel')?.classList.add('hidden');
    $('#sec-settings .grid-2eq').style.gridTemplateColumns = '1fr';
  }
  if (!S.staff) $$('[data-staff]').forEach(b => b.classList.add('hidden'));

  try {
    const d = await API.get('/api/public/status');
    if (d.site) { $('#side-brand').textContent = d.site.toUpperCase(); document.title = 'Console — ' + d.site; }
  } catch { $('#api-state').className = 'api-state bad'; $('#api-state').innerHTML = '<span class="d"></span> API offline'; }

  wireGlobal();
  window.addEventListener('hashchange', route);
  await route();
})();

/* ------------------------------------------------ routing */
const LOADER = {
  dashboard: loadDashboard, loaders: loadLoaders, customers: loadCustomers,
  licenses: loadLicenses, logs: loadLogs, settings: loadSettings
};

function go(sec) { location.hash = '#/' + sec; }
function reload() { LOADER[S.section]().catch(e => toast('Error', e.message, 'err')); }

async function route() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  let name = raw;
  if (!LOADER[name]) name = 'dashboard';
  if (!S.admin && ADMIN_ONLY.includes(name)) name = 'dashboard';
  if (!S.staff && STAFF_ONLY.includes(name)) name = 'dashboard';
  if (name !== raw) history.replaceState(null, '', '#/' + name);   // URL bhi saaf rakho
  S.section = name;

  $$('.sec').forEach(s => s.classList.toggle('show', s.id === 'sec-' + name));
  $$('.side-item').forEach(b => b.classList.toggle('active', b.dataset.sec === name));
  $('#crumb').textContent = SECTIONS[name];

  try { await LOADER[name](); }
  catch (e) { toast('Error', e.message, 'err'); }
}

/* ------------------------------------------------ small helpers */
function stat(label, num, desc, icon, cls = '') {
  return `<div class="stat">
    <div><div class="l">${label}</div><div class="n">${num}</div><div class="d">${desc}</div></div>
    <div class="ico ${cls}">${icon}</div></div>`;
}
function pill(s) { return `<span class="pill ${s}"><span class="d"></span>${s}</span>`; }
function statusSeg(a) {
  return `<div class="status-seg" data-app="${a.id}">` +
    ['online', 'offline', 'maintenance'].map(s =>
      `<button data-s="${s}" class="${a.status === s ? 'active' : ''}"><span class="d"></span>${s}</button>`
    ).join('') + `</div>`;
}
function empty(ic, title, sub) {
  return `<div class="empty"><div class="e-ic">${ic}</div><h4>${title}</h4><p>${sub || ''}</p></div>`;
}
function planLabel(days) {
  const d = Number(days);
  return ({ 0: 'Lifetime', 1: 'Daily', 7: 'Weekly', 30: 'Monthly', 90: 'Quarterly', 365: 'Yearly' })[d] || (d + ' days');
}
function wireSegs(root) {
  $$('.status-seg', root).forEach(seg => {
    if (seg.dataset.wired) return;
    seg.dataset.wired = '1';
    $$('button', seg).forEach(b => b.onclick = () => setAppStatus(Number(seg.dataset.app), b.dataset.s));
  });
}
async function refreshApps() {
  const d = S.admin ? await API.get('/api/admin/apps') : await API.get('/api/public/status');
  S.apps = d.apps || [];
}
function maintNote(a) {
  if (a.status === 'maintenance') {
    return `<div class="maint-note">⚠️<div><b>Maintenance mode</b><br>${esc(a.maintenance_message || 'Under maintenance')}${
      a.maintenance_until ? `<br><span class="tiny">Until ${fmtDateTime(a.maintenance_until)}</span>` : ''}</div></div>`;
  }
  if (a.status === 'offline') {
    return `<div class="maint-note off">⛔<div><b>Loader offline</b><br>Clients cannot log in while the loader is offline.</div></div>`;
  }
  return '';
}

/* ------------------------------------------------ loader status control */
async function setAppStatus(id, status) {
  const a = S.apps.find(x => x.id === id);
  if (!a) return;
  if (status === 'maintenance' && a.status !== 'maintenance') return openMaintenance(a);
  if (status === a.status) return;
  try {
    await API.patch('/api/admin/apps/' + id, { status });
    toast('Loader updated', `${a.name} → ${status.toUpperCase()}`);
    reload();
  } catch (e) { toast('Update failed', e.message, 'err'); reload(); }
}

function openMaintenance(a) {
  const bg = openModal(`
    <h3>Maintenance Mode <button class="x" data-close>✕</button></h3>
    <div class="sub">This message is shown inside <b>${esc(a.name)}</b> while maintenance is on.</div>
    <label class="lbl">Message</label>
    <textarea class="inp-box" id="m-msg">${esc(a.maintenance_message || 'Server under maintenance — please try again later.')}</textarea>
    <label class="lbl">Duration</label>
    <select class="inp-box" id="m-dur">
      <option value="15">15 minutes</option>
      <option value="30">30 minutes</option>
      <option value="60" selected>1 hour</option>
      <option value="180">3 hours</option>
      <option value="720">12 hours</option>
      <option value="1440">24 hours</option>
      <option value="0">Until I switch it off</option>
    </select>
    <button class="btn primary block" id="m-go" style="margin-top:20px">⚠️ Enable Maintenance</button>
  `);
  $('#m-go', bg).onclick = async () => {
    const mins = Number($('#m-dur', bg).value);
    try {
      await API.patch('/api/admin/apps/' + a.id, {
        status: 'maintenance',
        maintenance_message: $('#m-msg', bg).value.trim(),
        maintenance_until: mins ? Date.now() + mins * 60000 : 0
      });
      closeModals();
      toast('Maintenance enabled', a.name);
      reload();
    } catch (e) { toast('Failed', e.message, 'err'); }
  };
}

function loaderModal(a) {
  const isNew = !a;
  const v = a || { name: '', slug: '', description: '', version: '1.0.0', download_url: '', changelog: '', maintenance_message: '', require_key: 1 };
  const bg = openModal(`
    <h3>${isNew ? 'New Loader' : 'Edit Loader'} <button class="x" data-close>✕</button></h3>
    <div class="sub">${isNew ? 'Register a new loader application' : 'Update loader metadata and messages'}</div>
    <label class="lbl">Name</label>
    <input class="inp-box" id="l-name" value="${esc(v.name)}" placeholder="APEX Loader">
    <label class="lbl">Slug (API id)</label>
    <input class="inp-box" id="l-slug" value="${esc(v.slug)}" placeholder="apex" ${isNew ? '' : 'disabled'}>
    <label class="lbl">Description</label>
    <input class="inp-box" id="l-desc" value="${esc(v.description)}" placeholder="Main loader">
    <label class="lbl">Version</label>
    <input class="inp-box" id="l-ver" value="${esc(v.version)}" placeholder="1.0.0">
    <label class="lbl">Download URL</label>
    <input class="inp-box" id="l-url" value="${esc(v.download_url)}" placeholder="https://…">
    <label class="lbl">Changelog / notes</label>
    <textarea class="inp-box" id="l-log">${esc(v.changelog)}</textarea>
    <label class="lbl">Key required to use loader</label>
    <div class="seg" id="l-req">
      <button class="${v.require_key ? 'active g' : ''}" data-req="1">Required</button>
      <button class="${v.require_key ? '' : 'active v'}" data-req="0">Optional</button>
    </div>
    <div class="modal-acts">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="l-save">${isNew ? 'Create loader' : 'Save changes'}</button>
    </div>
  `);

  let req = v.require_key ? 1 : 0;
  $$('#l-req button', bg).forEach(b => b.onclick = () => {
    req = Number(b.dataset.req);
    $$('#l-req button', bg).forEach(x => { x.className = ''; });
    b.className = req ? 'active g' : 'active v';
  });

  $('#l-save', bg).onclick = async () => {
    const body = {
      name: $('#l-name', bg).value.trim(),
      slug: $('#l-slug', bg).value.trim(),
      description: $('#l-desc', bg).value.trim(),
      version: $('#l-ver', bg).value.trim(),
      download_url: $('#l-url', bg).value.trim(),
      changelog: $('#l-log', bg).value.trim(),
      require_key: req
    };
    if (!body.name) return toast('Name required', '', 'err');
    try {
      if (isNew) await API.post('/api/admin/apps', body);
      else await API.patch('/api/admin/apps/' + a.id, body);
      closeModals();
      toast(isNew ? 'Loader created' : 'Loader updated', body.name);
      reload();
    } catch (e) { toast('Failed', e.message, 'err'); }
  };
}

function confirmModal(title, sub, label, fn, danger = true) {
  const bg = openModal(`
    <h3>${title} <button class="x" data-close>✕</button></h3>
    <div class="sub">${sub}</div>
    <div class="modal-acts">
      <button class="btn" data-close>Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" id="c-yes">${label}</button>
    </div>`);
  $('#c-yes', bg).onclick = async () => {
    const b = $('#c-yes', bg); b.disabled = true;
    try { await fn(); closeModals(); }
    catch (e) { toast('Failed', e.message, 'err'); b.disabled = false; }
  };
}

/* ======================================================= DASHBOARD */
async function loadDashboard() {
  await refreshApps();
  const maint = S.apps.filter(a => a.status === 'maintenance');
  const off = S.apps.filter(a => a.status === 'offline');

  const bn = $('#dash-banner');
  bn.innerHTML = maint.length
    ? `<div class="maint-banner"><div>⚠️</div><div><b>Maintenance active — ${esc(maint.map(a => a.name).join(', '))}</b>${esc(maint[0].maintenance_message || 'Scheduled maintenance in progress.')}</div></div>`
    : off.length
      ? `<div class="maint-banner off"><div>⛔</div><div><b>Offline — ${esc(off.map(a => a.name).join(', '))}</b>Clients are blocked from these loaders.</div></div>`
      : '';

  $('#dash-ver').textContent = 'v' + (S.apps[0] ? S.apps[0].version : '1.0.0');

  const box = $('#dash-stats');
  if (S.staff) {
    const st = (await API.get('/api/admin/stats')).stats;
    const online = (st.apps.find(a => a.status === 'online') || {}).count || 0;
    box.innerHTML = [
      stat('Total Keys', st.keys.toLocaleString(), 'All generated license keys', '🔑'),
      stat('Active Subscriptions', st.subscriptions.toLocaleString(), 'Customers with a valid key', '👥', 'g'),
      stat('Loaders Online', online + '/' + S.apps.length, maint.length + ' in maintenance · ' + off.length + ' offline', '⚡', maint.length ? 'a' : 'g'),
      stat('Online Now', st.online_5min, 'Sessions in the last 5 minutes', '📡', 'c')
    ].join('');
  } else {
    const lic = (await API.get('/api/me/licenses')).licenses;
    const active = lic.filter(k => k.active);
    const soon = active.filter(k => !k.lifetime).sort((a, b) => a.expires_at - b.expires_at)[0];
    box.innerHTML = [
      stat('My Keys', active.length, lic.length + ' assigned to your account', '🔑'),
      stat(soon ? 'Next Expiry' : 'Access', soon ? fmtDate(soon.expires_at) : 'Lifetime', soon ? 'in ' + Math.max(0, Math.ceil((soon.expires_at - Date.now()) / 86400000)) + ' days' : 'no expiry', '⏳', 'g'),
      stat('Loader Health', maint.length ? 'Maintenance' : off.length ? 'Degraded' : 'Online', S.apps.length + ' loader(s) registered', '⚡', maint.length ? 'a' : off.length ? 'r' : 'g'),
      stat('Last Login', timeAgo(S.me.last_login), S.me.last_ip || '—', '🕘', 'c')
    ].join('');
  }

  $('#dash-loaders').innerHTML = S.apps.length ? S.apps.map(a => `
    <div class="between" style="padding:14px 0;border-bottom:1px solid #17171c">
      <div class="flex">
        <div class="pi" style="width:36px;height:36px">⚡</div>
        <div><div style="font-weight:800">${esc(a.name)}</div>
          <div class="tiny muted mono">${esc(a.slug)} · v${esc(a.version)}</div></div>
      </div>
      <div class="flex">
        ${a.status === 'maintenance' && a.maintenance_until ? `<span class="pill amber">until ${fmtDateTime(a.maintenance_until)}</span>` : ''}
        ${S.admin ? statusSeg(a) : pill(a.status)}
      </div>
    </div>`).join('') : empty('⚡', 'No loaders registered', 'Create one from the Loaders page.');
  wireSegs($('#dash-loaders'));

  if (S.staff) {
    if (S.admin) {
      const d = await API.get('/api/admin/logs?limit=7');
      $('#dash-logs').innerHTML = d.logs.length ? d.logs.map(logRow).join('') : empty('🕘', 'No activity yet');
    } else {
      $('#dash-logs').innerHTML = empty('🕘', 'Activity log is admin-only', 'Owner hi poora event history dekh sakta hai.');
    }
    $('#dash-side-title').textContent = 'Quick Actions';
    $('#dash-side-sub').textContent = 'jump straight to a task';
    const acts = [];
    if (S.admin) acts.push('<button class="btn primary" data-go="loaders">⚙ Manage loaders</button>');
    acts.push('<button class="btn primary" data-go="licenses">🔑 Generate keys</button>');
    if (S.admin) acts.push('<button class="btn" data-go="customers">👥 Customers</button>');
    if (S.admin) acts.push('<button class="btn" data-go="logs">🕘 Activity log</button>');
    $('#dash-side').innerHTML = `
      <div class="flex" style="flex-wrap:wrap;gap:9px">${acts.join('')}</div>
      <div class="hint" style="margin-top:14px">Tip: press <b>Ctrl + K</b> to jump anywhere.${
        S.me.role === 'reseller' ? '<br>Loader status / maintenance sirf owner control karta hai.' : ''}</div>`;
    $$('#dash-side [data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  } else {
    const lic = (await API.get('/api/me/licenses')).licenses.filter(k => k.active);
    $('#dash-logs').innerHTML = empty('🕘', 'No recent activity', 'Logins and key events appear here.');
    $('#dash-side-title').textContent = 'My Subscription';
    $('#dash-side-sub').textContent = 'active licenses on this account';
    $('#dash-side').innerHTML = lic.length ? lic.map(k => `
      <div class="between" style="padding:11px 0;border-bottom:1px solid #17171c">
        <div><div style="font-weight:750">${esc(k.app_name || 'Loader')}</div>
          <div class="k tiny">${esc(k.key)}</div></div>
        <div class="right-t">
          <span class="pill ${k.hwid ? 'violet' : 'green'}">${k.hwid ? 'bound' : 'available'}</span>
          <div class="tiny muted" style="margin-top:5px">${k.lifetime ? 'Lifetime' : fmtDate(k.expires_at)}</div>
        </div>
      </div>`).join('') : empty('🔑', 'No active license', 'Redeem a key to start using the loader.');
  }
}

function logRow(l) {
  return `<div class="log"><span class="tg ${esc(l.type)}">${esc(l.type)}</span>
    <span>${esc(l.message)}</span><span class="tm">${fmtDateTime(l.created_at)}</span></div>`;
}

/* ======================================================= LOADERS */
async function loadLoaders() {
  await refreshApps();
  $('#loaders-count').textContent = S.apps.length + ' total';
  await fillCredApps();
  await loadPCreds();
  const grid = $('#loader-grid');
  grid.innerHTML = S.apps.length ? S.apps.map(a => `
    <div class="loader-card" data-status="${a.status}" data-id="${a.id}">
      <div class="lc-top">
        <div><h3>${esc(a.name)}</h3><div class="slug">${esc(a.slug)}</div></div>
        ${pill(a.status)}
      </div>
      ${statusSeg(a)}
      <div class="kv">
        <div class="c"><div class="k2">Version</div><div class="v">${esc(a.version)}</div></div>
        <div class="c"><div class="k2">Active Keys</div><div class="v">${a.keys_active}</div></div>
        <div class="c"><div class="k2">Total Keys</div><div class="v">${a.keys_total}</div></div>
        <div class="c"><div class="k2">Key Required</div><div class="v">${a.require_key ? 'Yes' : 'No'}</div></div>
      </div>
      ${maintNote(a)}
      ${a.changelog ? `<div class="hint">📌 ${esc(a.changelog)}</div>` : ''}
      <div class="between" style="margin-top:14px">
        <div class="tiny muted mono">GET /api/public/status?app=${esc(a.slug)}</div>
        <div class="acts">
          <button class="a-btn" data-act="edit" title="Edit">✎</button>
          <button class="a-btn" data-act="copy" title="Copy API slug">⧉</button>
          <button class="a-btn red" data-act="del" title="Delete">🗑</button>
        </div>
      </div>
    </div>`).join('') : empty('⚙', 'No loaders yet', 'Create your first loader to control its status.');

  wireSegs(grid);
  $$('#loader-grid .loader-card').forEach(card => {
    const id = Number(card.dataset.id);
    const a = S.apps.find(x => x.id === id);
    $$('.a-btn', card).forEach(b => b.onclick = () => {
      if (b.dataset.act === 'edit') loaderModal(a);
      if (b.dataset.act === 'copy') copyText(a.slug, 'Slug copied');
      if (b.dataset.act === 'del') confirmModal('Delete loader',
        `Delete <b>${esc(a.name)}</b> and all of its license keys? This cannot be undone.`,
        'Delete loader', async () => {
          await API.del('/api/admin/apps/' + id);
          toast('Loader deleted', a.name);
          reload();
        });
    });
  });
}

/* ============================================ LOADER CREDENTIALS (KeyAuth) */
function credRow() {
  return S.apps.find(a => a.id === Number($('#cred-app').value)) || S.apps[0] || null;
}
function maskSecret(s) {
  s = String(s || '');
  return s ? s.slice(0, 6) + '••••••••••••' + s.slice(-4) : '—';
}
function credText(a) {
  if (!a) return '';
  return [
    'host     : ' + location.origin,
    'app      : ' + a.slug,
    'name     : ' + a.name,
    'app id   : ' + (a.app_key || '-'),
    'secret   : ' + (a.secret || '-'),
    'version  : ' + (a.version || '-')
  ].join('\n');
}
function credSnippet(a) {
  if (!a) return '';
  const host = location.origin;
  return [
    '// ' + a.name + ' — panel se copy kiya gaya',
    'apex::Client api("' + host + '",',
    '                  "' + a.slug + '",              // app slug (username)',
    '                  "' + (a.secret || '') + '");    // app secret (require on ho to)',
    '',
    '// host    : ' + host,
    '// app     : ' + a.slug,
    '// app id  : ' + (a.app_key || '-'),
    '// version : ' + (a.version || '-'),
    '// secret  : ' + (a.secret || '-')
  ].join('\n');
}
function renderCreds() {
  const a = credRow();
  const set = (id, v) => { const el = $('#' + id); if (el) el.textContent = v; };
  if (!a) {
    ['cred-name', 'cred-id', 'cred-secret', 'cred-ver'].forEach(i => set(i, '—'));
    set('cred-code', '');
    const c = $('#cred-req'); if (c) c.checked = false;
    return;
  }
  set('cred-name', a.slug);
  set('cred-id', a.app_key || '—');
  set('cred-secret', S.showSecret ? (a.secret || '—') : maskSecret(a.secret));
  set('cred-ver', a.version || '—');
  $('#cred-req').checked = !!a.require_secret;
  $('#cred-code').textContent = credSnippet(a);
}
async function fillCredApps() {
  const sel = $('#cred-app');
  if (!sel) return;
  if (!S.apps.some(a => a.id === Number(S.credApp))) S.credApp = S.apps[0] ? S.apps[0].id : 0;
  sel.innerHTML = S.apps.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')
    || '<option value="">No loader</option>';
  sel.value = String(S.credApp);
  renderCreds();
}
async function patchApp(id, body) {
  const d = await API.patch('/api/admin/apps/' + id, body);
  const i = S.apps.findIndex(x => x.id === id);
  if (i >= 0 && d.app) S.apps[i] = { ...S.apps[i], ...d.app };
  return d;
}

/* ======================================== PRODUCT CREDENTIALS (per product) */
async function loadPCreds() {
  try { const d = await API.get('/api/admin/products'); S.pcreds = d.products || []; }
  catch { S.pcreds = []; }
  const sel = $('#pcred-sel');
  if (!sel) return;
  if (!S.pcreds.some(p => p.id === Number(S.pcredApp))) S.pcredApp = S.pcreds[0] ? S.pcreds[0].id : 0;
  sel.innerHTML = S.pcreds.map(p => {
    const app = S.apps.find(a => a.id === p.app_id);
    return `<option value="${p.id}">${esc(app ? app.name : 'Loader ' + p.app_id)} · ${esc(p.name)}</option>`;
  }).join('') || '<option value="">No product</option>';
  sel.value = String(S.pcredApp);
  renderPCreds();
}
function pcredRow() {
  return S.pcreds.find(p => p.id === Number($('#pcred-sel').value)) || S.pcreds[0] || null;
}
function pcredApp(p) { const a = S.apps.find(x => x.id === p.app_id); return a || null; }
function pcredText(p) {
  if (!p) return '';
  const a = pcredApp(p);
  return [
    'host     : ' + location.origin,
    'loader   : ' + (a ? a.name + ' (' + a.slug + ')' : 'id ' + p.app_id),
    'product  : ' + p.name + ' (slug ' + (p.slug || '-') + ')',
    'app id   : ' + (p.app_key || '-'),
    'secret   : ' + (p.secret || '-'),
    'version  : ' + (p.version || '-')
  ].join('\n');
}
function pcredSnippet(p) {
  if (!p) return '';
  const a = pcredApp(p);
  const slug = a ? a.slug : 'app';
  return [
    '// ' + (a ? a.name : slug) + ' · ' + p.name + ' — panel se copy kiya gaya',
    '#define APP_PRODUCT "' + p.name + '"',
    '#define APP_SECRET  "' + (p.secret || '') + '"',
    'apex::Client api("' + location.origin + '",',
    '                  "' + slug + '", APP_SECRET, APP_PRODUCT);',
    '',
    '// product : ' + p.name + ' (slug ' + (p.slug || '-') + ')',
    '// app id  : ' + (p.app_key || '-'),
    '// version : ' + (p.version || '-'),
    '// secret  : ' + (p.secret || '-')
  ].join('\n');
}
function renderPCreds() {
  const p = pcredRow();
  const set = (id, v) => { const el = $('#' + id); if (el) el.textContent = v; };
  if (!p) {
    ['pcred-name', 'pcred-id', 'pcred-secret', 'pcred-ver'].forEach(i => set(i, '—'));
    set('pcred-code', '');
    const c = $('#pcred-req'); if (c) c.checked = false;
    return;
  }
  set('pcred-name', p.name);
  set('pcred-id', p.app_key || '—');
  set('pcred-secret', S.showPSecret ? (p.secret || '—') : maskSecret(p.secret));
  set('pcred-ver', p.version || '—');
  $('#pcred-req').checked = !!p.require_secret;
  $('#pcred-code').textContent = pcredSnippet(p);
}
async function patchProduct(id, body) {
  const d = await API.patch('/api/admin/products/' + id, body);
  const i = S.pcreds.findIndex(x => x.id === id);
  if (i >= 0 && d.product) S.pcreds[i] = { ...S.pcreds[i], ...d.product };
  return d;
}

/* ======================================================= CUSTOMERS */
async function loadCustomers() {
  const d = await API.get('/api/admin/users?q=' + encodeURIComponent(S.userQ));
  S.users = d.users;
  $('#users-count').textContent = S.users.length + ' Registered';

  const bound = S.users.filter(u => u.bound_keys > 0).length;
  const activeSub = S.users.filter(u => u.active_keys > 0).length;
  const banned = S.users.filter(u => u.banned).length;
  $('#user-stats').innerHTML = [
    stat('Total Accounts', S.users.length, 'All client profiles', '👥'),
    stat('Active Subscriptions', activeSub, 'Authorized &amp; unbanned', '💳', 'g'),
    stat('Hardware Bound', bound, 'Bound to machine signature', '🖥', 'c'),
    stat('Restricted / Banned', banned, 'Blocked from auth node', '⊘', 'r')
  ].join('');

  $('#users-body').innerHTML = S.users.length ? S.users.map(u => {
    const hw = u.bound_hwid ? esc(u.bound_hwid.slice(0, 10) + '…' + u.bound_hwid.slice(-4)) : '';
    return `<tr data-id="${u.id}">
      <td><div class="u-cell"><div class="avatar ${u.banned ? '' : 'blue'}">${esc((u.username || '?')[0].toUpperCase())}</div>
        <div><div class="nm">${esc(u.username)}</div><div class="id">ID #${u.id}</div></div></div></td>
      <td><div class="flex">
        ${u.banned ? '<span class="pill red">Banned</span>' : '<span class="pill green">Active</span>'}
        ${u.sub_until ? `<span class="pill blue">${fmtDate(u.sub_until)}</span>` : '<span class="pill grey">No sub</span>'}
        ${u.role === 'admin' ? '<span class="pill violet">owner</span>'
          : u.role === 'reseller' ? '<span class="pill violet">reseller</span>' : ''}
      </div></td>
      <td>${hw ? `<span class="k">${hw}</span>` : '<span class="muted">Not bound</span>'}</td>
      <td class="muted small">${timeAgo(u.last_login)}<div class="tiny">${esc(u.last_ip || '')}</div></td>
      <td><div class="acts">
        <button class="a-btn" data-act="edit" title="Edit / extend">✎</button>
        <button class="a-btn amber" data-act="hwid" title="Reset HWID">↺</button>
        <button class="a-btn ${u.banned ? 'green' : 'red'}" data-act="ban" title="${u.banned ? 'Unban' : 'Ban'}">${u.banned ? '✓' : '⊘'}</button>
        <button class="a-btn red" data-act="del" title="Delete">🗑</button>
      </div></td></tr>`;
  }).join('') : '';

  if (!S.users.length) $('#users-body').innerHTML =
    `<tr><td colspan="5">${empty('👥', 'No users found', S.userQ ? 'Try another search.' : 'Add your first customer.')}</td></tr>`;

  $$('#users-body tr[data-id]').forEach(tr => {
    const u = S.users.find(x => x.id === Number(tr.dataset.id));
    $$('.a-btn', tr).forEach(b => b.onclick = () => userAction(b.dataset.act, u));
  });
}

function userAction(act, u) {
  if (act === 'edit') {
    const bg = openModal(`
      <h3>Edit ${esc(u.username)} <button class="x" data-close>✕</button></h3>
      <div class="sub">ID #${u.id} · ${u.banned ? 'banned' : 'active'} · ${u.active_keys} active key(s)</div>
      <label class="lbl">Add days to existing subscriptions</label>
      <div class="inp-ic"><span class="i">＋</span><input class="inp-box" id="u-days" type="number" value="0" min="0" max="730"></div>
      <label class="lbl">Set role</label>
      <select class="inp-box" id="u-role">
        <option value="user" ${u.role === 'user' ? 'selected' : ''}>Client</option>
        ${S.admin ? `<option value="reseller" ${u.role === 'reseller' ? 'selected' : ''}>Reseller (sub-user)</option>
        <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin / Owner</option>` : ''}
      </select>
      <label class="lbl">Reset password (optional)</label>
      <input class="inp-box" id="u-pass" placeholder="leave empty to keep">
      <label class="check" style="margin-top:14px"><input type="checkbox" id="u-hwid"> Reset HWID lock</label>
      <div class="modal-acts">
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" id="u-save">Save</button>
      </div>`);
    $('#u-save', bg).onclick = async () => {
      const body = { role: $('#u-role', bg).value };
      const days = Number($('#u-days', bg).value);
      if (days) body.add_days = days;
      const pass = $('#u-pass', bg).value;
      if (pass) body.password = pass;
      if ($('#u-hwid', bg).checked) body.reset_hwid = true;
      try {
        await API.patch('/api/admin/users/' + u.id, body);
        closeModals(); toast('User updated', u.username); reload();
      } catch (e) { toast('Failed', e.message, 'err'); }
    };
  }
  if (act === 'hwid') confirmModal('Reset HWID', `Clear the hardware lock for <b>${esc(u.username)}</b>?`, 'Reset HWID', async () => {
    await API.patch('/api/admin/users/' + u.id, { reset_hwid: true });
    toast('HWID reset', u.username); reload();
  }, false);
  if (act === 'ban') confirmModal(u.banned ? 'Unban user' : 'Ban user',
    (u.banned ? 'Restore access for ' : 'Block access for ') + `<b>${esc(u.username)}</b>?`,
    u.banned ? 'Unban' : 'Ban user', async () => {
      await API.patch('/api/admin/users/' + u.id, { banned: !u.banned });
      toast(u.banned ? 'Unbanned' : 'Banned', u.username); reload();
    }, !u.banned);
  if (act === 'del') confirmModal('Delete user',
    `Permanently delete <b>${esc(u.username)}</b> and their sessions?`, 'Delete user', async () => {
      await API.del('/api/admin/users/' + u.id);
      toast('User deleted', u.username); reload();
    });
}

function addUserModal() {
  const bg = openModal(`
    <h3>Add User <button class="x" data-close>✕</button></h3>
    <div class="sub">Create a customer / sub-user account manually</div>
    <label class="lbl">Username</label>
    <input class="inp-box" id="n-user" placeholder="customer01">
    <label class="lbl">Password</label>
    <input class="inp-box" id="n-pass" type="text" placeholder="min 6 characters">
    <label class="lbl">Discord (optional)</label>
    <input class="inp-box" id="n-disc" placeholder="username">
    <label class="lbl">Role</label>
    <select class="inp-box" id="n-role">
      <option value="user">Client — key use karta hai</option>
      ${S.admin ? `<option value="reseller">Reseller (sub-user) — keys generate karta hai</option>
      <option value="admin">Admin / Owner — poora control</option>` : ''}
    </select>
    <div class="modal-acts">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="n-save">Create user</button>
    </div>`);
  $('#n-save', bg).onclick = async () => {
    try {
      await API.post('/api/admin/users', {
        username: $('#n-user', bg).value.trim(),
        password: $('#n-pass', bg).value,
        discord: $('#n-disc', bg).value.trim(),
        role: $('#n-role', bg).value
      });
      closeModals(); toast('User created', $('#n-user', bg).value); reload();
    } catch (e) { toast('Failed', e.message, 'err'); }
  };
}

/* ======================================================= LICENSES */
async function fillAppSelects() {
  const opts = S.apps.map(a => `<option value="${a.id}">${esc(a.name)} <span style="color:#7c7c8a">· ${esc(a.slug)}</span></option>`).join('');
  $('#g-app').innerHTML = opts || '<option value="">No loader</option>';
  const f = $('#key-app-filter');
  f.innerHTML = `<option value="">All loaders</option>` + opts;
  if (S.apps.some(a => String(a.id) === String(S.keyApp))) f.value = S.keyApp;
  else S.keyApp = '';
  if (S.staff) await fillProducts();
}

/* --------- products (Internal / External / Silent Aim / Silent Cover) --------- */
async function fillProducts(force) {
  const appId = Number($('#g-app').value) || 0;
  if (appId && (force || S.prodApp !== appId)) {
    S.prodApp = appId;
    try {
      const d = await API.get('/api/admin/products?app_id=' + appId);
      S.products = d.products || [];
    } catch { S.products = []; }
  }
  const popts = S.products.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');

  const gp = $('#g-product');
  gp.innerHTML = popts || '<option value="">No product</option>';
  gp.value = S.products.some(p => String(p.id) === String(gp.value)) ? gp.value
    : (S.products[0] ? String(S.products[0].id) : '');

  const fp = $('#key-product-filter');
  fp.innerHTML = `<option value="">All products</option>` + popts;
  if (S.products.some(p => String(p.id) === String(S.keyProduct))) fp.value = S.keyProduct;
  else { S.keyProduct = ''; fp.value = ''; }

  $('#prod-chips').innerHTML = S.products.length
    ? S.products.map(p => `<span class="pill violet" style="padding:6px 9px;gap:8px">${esc(p.name)}
        <button class="link" data-pid="${p.id}" title="remove" style="color:#ff9fb1;font-size:14px;line-height:1">×</button></span>`).join('')
    : '<span class="tiny muted">No products yet — add one on the right</span>';
  $$('#prod-chips [data-pid]').forEach(b => b.onclick = () => deleteProduct(Number(b.dataset.pid)));
}

async function addProduct() {
  const inp = $('#prod-name');
  const name = inp.value.trim();
  if (!name) return toast('Product name required', '', 'err');
  const appId = Number($('#g-app').value) || 0;
  if (!appId) return toast('Choose a loader first', '', 'err');
  try {
    await API.post('/api/admin/products', { app_id: appId, name });
    inp.value = '';
    toast('Product added', name);
    await fillProducts(true);
  } catch (e) { toast('Failed', e.message, 'err'); }
}

function deleteProduct(id) {
  const p = S.products.find(x => x.id === id);
  if (!p) return;
  confirmModal('Delete product',
    `Remove <b>${esc(p.name)}</b>? Its keys stay, but they lose the product tag.`,
    'Delete product', async () => {
      await API.del('/api/admin/products/' + id);
      toast('Product deleted', p.name);
      await fillProducts(true);
      loadLicenses();
    });
}

async function loadLicenses() {
  await refreshApps();
  await fillAppSelects();
  $('#lic-bulk-bar').classList.toggle('hidden', !S.staff);
  $('#gen-panel').classList.toggle('hidden', !S.staff);
  $('#prod-bar').classList.toggle('hidden', !S.staff);
  /* client ke liye loader/product filter bhi bekar hain */
  $('#key-app-filter').classList.toggle('hidden', !S.staff);
  $('#key-product-filter').classList.toggle('hidden', !S.staff);

  if (S.staff) {
    const st = (await API.get('/api/admin/stats')).stats;
    $('#lic-stats').innerHTML = [
      stat('Total Keys Generated', st.keys.toLocaleString(), 'All active &amp; past keys in database', '🔑'),
      stat('Available (Unredeemed)', st.available_keys.toLocaleString(), 'Ready for customer activation', '🎯', 'g'),
      stat('Redeemed Keys', st.bound_keys.toLocaleString(), 'Bound to unique machine HWIDs', '🖥', 'c'),
      stat('Expired / Paused', (st.keys - st.active_keys).toLocaleString(), 'Not usable right now', '⏸', 'a')
    ].join('');

    const q = new URLSearchParams({ limit: '200', q: S.keyQ, app: S.keyApp, status: S.keyFilter, product: S.keyProduct });
    const d = await API.get('/api/admin/keys?' + q);
    S.keys = d.keys;
    $('#lic-matching').textContent = d.total + ' matching licenses in register';
  } else {
    const all = (await API.get('/api/me/licenses')).licenses;
    const q = S.keyQ.toLowerCase();
    S.keys = q ? all.filter(k => (k.key + k.app_name).toLowerCase().includes(q)) : all;
    const active = S.keys.filter(k => k.active);
    const soon = active.filter(k => !k.lifetime).sort((a, b) => a.expires_at - b.expires_at)[0];
    $('#lic-stats').innerHTML = [
      stat('My Keys', S.keys.length, 'Licenses on this account', '🔑'),
      stat('Active', active.length, 'Usable right now', '✓', 'g'),
      stat(soon ? 'Next Expiry' : 'Access', soon ? fmtDate(soon.expires_at) : 'Lifetime', soon ? planLabel(soon.duration_days) + ' plan' : 'permanent', '⏳', 'c'),
      stat('HWID Locked', S.keys.filter(k => k.hwid).length, 'Bound to this machine', '🖥', 'a')
    ].join('');
    $('#lic-matching').textContent = active.length + ' active license(s)';
  }
  renderKeys();
}

function renderKeys() {
  const body = $('#keys-body');
  const wrap = body.closest('.table-wrap');
  const isEmpty = !S.keys.length;

  wrap.style.display = isEmpty ? 'none' : '';
  $('#keys-empty').innerHTML = isEmpty
    ? empty('🔑', 'No licenses found', 'Try adjusting your search or filters, or generate a key.')
    : '';

  body.innerHTML = S.keys.map(k => {
    const st = licenseStatus(k);
    return `<tr data-id="${k.id}">
      <td><div class="flex" style="gap:7px"><span class="k">${esc(k.key)}</span></div></td>
      <td>${k.product_name
          ? `<div style="font-weight:700">${esc(k.product_name)}</div><div class="tiny muted">${esc(k.app_name || '')}</div>`
          : `<span class="muted">${esc(k.app_name || '—')}</span>`}</td>
      <td><span class="pill blue">${esc(k.plan || planLabel(k.duration_days))}</span></td>
      <td><span class="pill ${st.cls}"><span class="d"></span>${st.txt}</span></td>
      <td class="muted small">${k.lifetime ? 'Lifetime' : fmtDate(k.expires_at)}
        ${k.hwid ? `<div class="tiny mono">${esc(k.hwid.slice(0, 8))}…</div>` : ''}</td>
      <td><div class="acts">
        <button class="a-btn" data-act="copy" title="Copy key">⧉</button>
        ${S.staff ? `
        <button class="a-btn amber" data-act="unbind" title="Reset HWID">↺</button>
        <button class="a-btn ${k.revoked ? 'green' : 'red'}" data-act="pause" title="${k.revoked ? 'Resume' : 'Pause'}">${k.revoked ? '▶' : '⏸'}</button>
        <button class="a-btn red" data-act="del" title="Delete">🗑>` : ''}
      </div></td></tr>`;
  }).join('');

  $$('#keys-body tr[data-id]').forEach(tr => {
    const k = S.keys.find(x => x.id === Number(tr.dataset.id));
    $$('.a-btn', tr).forEach(b => b.onclick = async () => {
      const act = b.dataset.act;
      if (act === 'copy') return copyText(k.key, 'Key copied');
      if (act === 'unbind') {
        try { await API.patch('/api/admin/keys/' + k.id, { unbind: true }); toast('HWID reset', k.key); reload(); }
        catch (e) { toast('Failed', e.message, 'err'); }
      }
      if (act === 'pause') {
        try { await API.patch('/api/admin/keys/' + k.id, { revoked: k.revoked ? 0 : 1 }); toast(k.revoked ? 'Key resumed' : 'Key paused', k.key); reload(); }
        catch (e) { toast('Failed', e.message, 'err'); }
      }
      if (act === 'del') confirmModal('Delete key', `Delete <b class="mono">${esc(k.key)}</b>?`, 'Delete', async () => {
        await API.del('/api/admin/keys/' + k.id);
        toast('Key deleted', k.key); reload();
      });
    });
  });
}

async function generateKeys() {
  const btn = $('#g-gen');
  const prefix = $('#g-prefix').value.trim();
  const custom = $('#g-custom').value.trim();
  const count = Math.max(1, Math.min(100, Number($('#g-count').value) || 1));
  const days = Number($('#g-plan').value);
  const appId = Number($('#g-app').value);
  const productId = Number($('#g-product').value) || 0;
  if (!appId) return toast('Choose a loader', '', 'err');
  if (!productId) return toast('Choose a product (Internal / External / …)', '', 'err');

  btn.disabled = true;
  try {
    const d = await API.post('/api/admin/keys', {
      app_id: appId, count, duration_days: days, plan: planLabel(days),
      product_id: productId,
      prefix, custom_key: custom, user_limit: S.limit,
      note: 'generated from console'
    });
    $('#g-keys').innerHTML = d.keys.map(k => `<button title="click to copy">${esc(k)}</button>`).join('');
    $('#g-out-n').textContent = d.keys.length + ' Generated';
    $('#g-out').classList.add('show');
    $$('#g-keys button').forEach(b => b.onclick = () => copyText(b.textContent, 'Key copied'));
    const pname = ($('#g-product').selectedOptions[0] || {}).textContent || '';
    toast('Generated', `${d.keys.length} ${pname} license key(s) created.`);
    $('#g-custom').value = '';
    loadLicenses();
  } catch (e) { toast('Generation failed', e.message, 'err'); }
  finally { btn.disabled = false; }
}

/* ======================================================= LOGS */
async function loadLogs() {
  const d = await API.get('/api/admin/logs?limit=200');
  S.logs = d.logs;
  $('#logs-count').textContent = S.logs.length + ' events';
  $('#logs-list').innerHTML = S.logs.length ? S.logs.map(logRow).join('') : empty('🕘', 'Log is empty');
}

/* ======================================================= SETTINGS */
async function loadSettings() {
  if (S.admin) {
    const d = await API.get('/api/admin/settings');
    S.settings = d.settings;
    $('#s-name').value = S.settings.site_name || '';
    $('#s-url').value = S.settings.site_url || '';
    $('#s-discord').value = S.settings.discord_url || '';
    $('#s-hook').value = S.settings.discord_webhook || '';
    $('#s-owner').value = S.settings.owner || '';
    $('#s-days').value = S.settings.session_days || '30';
    const open = S.settings.signup_open === '1';
    $$('#s-signup button').forEach(b => b.classList.toggle('active', (b.dataset.open === '1') === open));
    $$('#s-signup button').forEach(b => b.classList.toggle('g', (b.dataset.open === '1') === open));
  }
}

/* ======================================================= global wiring */
function wireGlobal() {
  $$('.side-item').forEach(b => b.onclick = () => go(b.dataset.sec));

  $('#logout').onclick = async () => {
    try { await API.post('/api/auth/logout'); } catch { }
    API.setToken('');
    location.href = '/login.html';
  };

  $('#dash-refresh').onclick = () => { reload(); toast('Refreshed', 'Dashboard data reloaded'); };

  $('#new-loader').onclick = () => loaderModal(null);

  /* loader credentials */
  $('#cred-app').onchange = e => { S.credApp = Number(e.target.value); renderCreds(); };
  $('#cred-eye').onclick = () => { S.showSecret = !S.showSecret; renderCreds(); };
  $('#cred-copy').onclick = () => { const a = credRow(); if (a) copyText(credText(a), 'Credentials copied'); };
  $('#cred-snippet').onclick = () => { const a = credRow(); if (a) copyText(credSnippet(a), 'C++ snippet copied'); };
  $('#cred-regen').onclick = () => {
    const a = credRow();
    if (!a) return;
    confirmModal('Regenerate secret',
      `Purana secret <b class="mono">${esc(maskSecret(a.secret))}</b> band ho jayega — loader ko naya secret deploy karna hoga.`,
      'Regenerate', async () => {
        await patchApp(a.id, { regenerate_secret: true });
        S.showSecret = true;
        renderCreds();
        toast('New secret generated', a.slug + ' — ab loader me daal dein');
      });
  };
  $('#cred-req').onchange = async e => {
    const a = credRow();
    if (!a) return;
    try {
      await patchApp(a.id, { require_secret: e.target.checked ? 1 : 0 });
      toast(e.target.checked ? 'API secret required' : 'API secret optional', a.slug);
    } catch (err) {
      toast('Failed', err.message, 'err');
      e.target.checked = !e.target.checked;
    }
  };

  $('#pcred-sel').onchange = e => { S.pcredApp = Number(e.target.value); renderPCreds(); };
  $('#pcred-eye').onclick = () => { S.showPSecret = !S.showPSecret; renderPCreds(); };
  $('#pcred-copy').onclick = () => { const p = pcredRow(); if (p) copyText(pcredText(p), 'Product credentials copied'); };
  $('#pcred-snippet').onclick = () => { const p = pcredRow(); if (p) copyText(pcredSnippet(p), 'C++ snippet copied'); };
  $('#pcred-regen').onclick = () => {
    const p = pcredRow();
    if (!p) return;
    confirmModal('Regenerate product secret',
      `<b>${esc(p.name)}</b> ka purana secret <b class="mono">${esc(maskSecret(p.secret))}</b> band ho jayega — us build ko naya secret deploy karna hoga.`,
      'Regenerate', async () => {
        await patchProduct(p.id, { regenerate_secret: true });
        S.showPSecret = true;
        renderPCreds();
        toast('New product secret generated', p.name + ' — ab loader me daal dein');
      });
  };
  $('#pcred-req').onchange = async e => {
    const p = pcredRow();
    if (!p) return;
    try {
      await patchProduct(p.id, { require_secret: e.target.checked ? 1 : 0 });
      toast(e.target.checked ? 'Product secret required' : 'Product secret optional', p.name);
    } catch (err) {
      toast('Failed', err.message, 'err');
      e.target.checked = !e.target.checked;
    }
  };

  $('#add-user').onclick = addUserModal;
  /* reseller ke liye kuch destructive bulk actions admin-only */
  if (!S.admin) $$('[data-ubulk="ban_all"],[data-ubulk="purge_users"]').forEach(b => b.classList.add('hidden'));

  let ut;
  $('#user-search').value = S.userQ;
  $('#user-search').oninput = e => {
    clearTimeout(ut);
    ut = setTimeout(() => { S.userQ = e.target.value.trim(); loadCustomers().catch(x => toast('Error', x.message, 'err')); }, 300);
  };

  $$('[data-ubulk]').forEach(b => b.onclick = () => {
    const a = b.dataset.ubulk;
    const info = {
      reset_hwid: ['Reset All HWIDs', 'Clear every hardware lock in the system?', 'Reset HWIDs', false],
      unban_all: ['Unban All', 'Restore access for every banned account?', 'Unban all', false],
      ban_all: ['Ban All', 'Ban every account except yours and log them out?', 'Ban all', true],
      purge_users: ['Purge All Users', 'Delete every non-admin account and all their licenses?', 'Purge users', true]
    }[a];
    confirmModal(info[0], info[1], info[2], async () => {
      const d = await API.post('/api/admin/users/bulk', { action: a });
      toast('Bulk action complete', d.message);
      reload();
    }, info[3]);
  });

  /* licenses */
  $('#lic-refresh').onclick = () => { loadLicenses().catch(e => toast('Error', e.message, 'err')); };
  $('#lic-export').onclick = () => {
    if (!S.keys.length) return toast('Nothing to export', '', 'err');
    const rows = [['key', 'product', 'loader', 'plan', 'status', 'expires', 'hwid', 'note']];
    S.keys.forEach(k => rows.push([k.key, k.product_name || '', k.app_name || '', k.plan || '', licenseStatus(k).txt,
      k.lifetime ? 'lifetime' : new Date(k.expires_at).toISOString().slice(0, 10), k.hwid || '', k.note || '']));
    downloadFile('licenses.csv', rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'));
    toast('Exported', S.keys.length + ' row(s) written to licenses.csv');
  };

  let kt;
  $('#key-search').oninput = e => {
    clearTimeout(kt);
    kt = setTimeout(() => { S.keyQ = e.target.value.trim(); loadLicenses().catch(x => toast('Error', x.message, 'err')); }, 300);
  };
  $$('[data-kf]').forEach(b => b.onclick = () => {
    S.keyFilter = b.dataset.kf;
    $$('[data-kf]').forEach(x => x.classList.toggle('on', x === b));
    loadLicenses().catch(e => toast('Error', e.message, 'err'));
  });
  $('#key-app-filter').onchange = e => {
    S.keyApp = e.target.value;
    S.keyProduct = ''; S.prodApp = 0; S.products = [];   // loader badla to product filter reset
    loadLicenses().catch(err => toast('Error', err.message, 'err'));
  };
  $('#key-product-filter').onchange = e => {
    S.keyProduct = e.target.value;
    loadLicenses().catch(err => toast('Error', err.message, 'err'));
  };

  /* product chips (Licenses page) */
  $('#g-app').onchange = () => fillProducts(true).catch(e => toast('Error', e.message, 'err'));
  $('#prod-add').onclick = addProduct;
  $('#prod-name').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addProduct(); } };

  $$('[data-kbulk]').forEach(b => b.onclick = () => {
    const a = b.dataset.kbulk;
    const info = {
      reset_hwid: ['Reset All HWIDs', 'Clear every HWID binding so customers can rebind.', 'Reset HWIDs', false],
      pause_all: ['Pause All Keys', 'Revoke every key temporarily (can be resumed).', 'Pause all', true],
      resume_all: ['Resume All Keys', 'Un-revoke every revoked key.', 'Resume all', false],
      delete_unused: ['Delete Unused Keys', 'Delete keys that were never bound to an account.', 'Delete unused', true],
      purge: ['Purge All Keys', 'Delete <b>every</b> license key in the system. This cannot be undone.', 'Purge all keys', true]
    }[a];
    confirmModal(info[0], info[1], info[2], async () => {
      const d = await API.post('/api/admin/keys/bulk', { action: a, app_id: Number(S.keyApp) || 0 });
      toast('Bulk action complete', d.message);
      reload();
    }, info[3]);
  });

  $('#g-gen').onclick = generateKeys;
  $('#g-copyall').onclick = () => copyText($$('#g-keys button').map(b => b.textContent).join('\n'), 'All keys copied');
  $('#g-clear').onclick = () => { $('#g-out').classList.remove('show'); $('#g-keys').innerHTML = ''; };
  $('#g-prefix').oninput = e => {
    const p = e.target.value.trim().replace(/[^A-Za-z0-9_-]/g, '');
    $('#g-preview').textContent = p ? `${p}-XXXX-XXXX-XXXX` : 'XXXXX-XXXXX-XXXXX-XXXXX';
  };
  $('#g-count').oninput = e => {
    let v = Number(e.target.value) || 1;
    if (v > 100) { v = 100; e.target.value = 100; }
  };
  $$('#g-limit button').forEach(b => b.onclick = () => {
    S.limit = Number(b.dataset.limit);
    $$('#g-limit button').forEach(x => { x.className = ''; });
    b.className = 'active g';
    $('#g-limit-hint').textContent = S.limit ? 'One account can redeem this key' : 'Any account can redeem this key';
  });

  /* logs */
  $('#logs-refresh').onclick = () => loadLogs().catch(e => toast('Error', e.message, 'err'));
  $('#logs-clear').onclick = () => confirmModal('Clear log', 'Remove every activity log entry?', 'Clear log', async () => {
    await API.del('/api/admin/logs');
    toast('Log cleared', '');
    loadLogs();
  });

  /* settings */
  $$('#s-signup button').forEach(b => b.onclick = () => {
    $$('#s-signup button').forEach(x => { x.className = ''; });
    b.className = 'active g';
  });
  const pushSettings = () => API.put('/api/admin/settings', {
    site_name: $('#s-name').value.trim(),
    site_url: $('#s-url').value.trim(),
    discord_url: $('#s-discord').value.trim(),
    discord_webhook: $('#s-hook').value.trim(),
    owner: $('#s-owner').value.trim(),
    session_days: $('#s-days').value,
    signup_open: $('#s-signup button.active')?.dataset.open || '1'
  });

  $('#s-save').onclick = async () => {
    try {
      await pushSettings();
      toast('Settings saved', 'Site configuration updated');
      const d = await API.get('/api/public/status');
      if (d.site) $('#side-brand').textContent = d.site.toUpperCase();
    } catch (e) { toast('Failed', e.message, 'err'); }
  };

  $('#s-hook-test').onclick = async () => {
    if (!$('#s-hook').value.trim()) return toast('Webhook URL khali hai', 'Discord webhook paste karein', 'err');
    try {
      await pushSettings();
      const r = await API.post('/api/admin/settings/test-webhook', {});
      if (r && r.ok) toast('Test embed sent', 'Discord channel check karein ✅');
      else toast('Webhook failed', (r && (r.reason || r.error)) || 'URL/status check karein', 'err');
    } catch (e) { toast('Failed', e.message, 'err'); }
  };

  $('#p-save').onclick = async () => {
    const n1 = $('#p-new').value, n2 = $('#p-new2').value;
    if (n1 !== n2) return toast('Passwords do not match', '', 'err');
    try {
      await API.post('/api/auth/change-password', { old_password: $('#p-old').value, new_password: n1 });
      toast('Password changed', 'Use it on your next sign in');
      $('#p-old').value = $('#p-new').value = $('#p-new2').value = '';
    } catch (e) { toast('Failed', e.message, 'err'); }
  };

  /* quick palette */
  $('#jump').onclick = openPalette;
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  });
  $('#palette-input').oninput = () => renderPalette($('#palette-input').value);
  $('#palette-input').onkeydown = e => {
    if (e.key === 'Enter') { const f = $('#palette-items .it'); if (f) f.click(); }
  };
  $('#palette-bg').onclick = e => { if (e.target.id === 'palette-bg') $('#palette-bg').classList.remove('show'); };
}

const PALETTE = () => [
  { i: '▦', t: 'Dashboard', go: () => go('dashboard') },
  { i: '⚙', t: 'Loaders — online / offline / maintenance', admin: 1, go: () => go('loaders') },
  { i: '👥', t: 'Customers', admin: 1, go: () => go('customers') },
  { i: '🔑', t: 'Licenses / key generator', go: () => go('licenses') },
  { i: '🕘', t: 'Activity log', admin: 1, go: () => go('logs') },
  { i: '🛠', t: 'Settings', go: () => go('settings') },
  { i: '＋', t: 'Create new loader', admin: 1, go: () => { go('loaders'); setTimeout(() => loaderModal(null), 350); } },
  { i: '✨', t: 'Generate license keys', staff: 1, go: () => { go('licenses'); setTimeout(() => $('#g-gen')?.focus(), 400); } },
  { i: '⏻', t: 'Sign out', go: () => $('#logout').click() }
];

function openPalette() {
  $('#palette-bg').classList.add('show');
  $('#palette-input').value = '';
  renderPalette('');
  setTimeout(() => $('#palette-input').focus(), 30);
}
function renderPalette(q) {
  const items = PALETTE().filter(p => (!p.admin || S.admin) && (!p.staff || S.staff) && p.t.toLowerCase().includes((q || '').toLowerCase()));
  $('#palette-items').innerHTML = items.length
    ? items.map((p, idx) => `<div class="it ${idx === 0 ? 'sel' : ''}" data-i="${idx}"><span>${p.i}</span> ${esc(p.t)}${idx === 0 ? '<span class="kbd">↵ enter</span>' : ''}</div>`).join('')
    : '<div class="it">No match</div>';
  $$('#palette-items .it[data-i]').forEach(el => el.onclick = () => {
    $('#palette-bg').classList.remove('show');
    items[Number(el.dataset.i)].go();
  });
}
