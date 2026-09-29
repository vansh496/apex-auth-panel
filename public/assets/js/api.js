/* ===================== shared helpers ===================== */
/* Backend base URL.
   Default = jis host se page serve ho raha hai — matlab:
     local  -> http://localhost:3000
     live   -> https://keyauth-website-eg3o.onrender.com
   (frontend isi Render service par hai, to URL apne aap sahi aata hai)

   Agar frontend kisi ALAG host par host karna ho to <head> me ye likhein:
     <script>window.APEX_API_BASE = 'https://keyauth-website-eg3o.onrender.com';</script>
   Ya turant test ke liye URL me:
     app.html?api=https://keyauth-website-eg3o.onrender.com                     */
const API_BASE = String(
  new URLSearchParams(location.search).get('api') || window.APEX_API_BASE || ''
).replace(/\/+$/, '') || location.origin;

const API = {
  token: localStorage.getItem('bk_token') || '',
  setToken(t) { this.token = t || ''; t ? localStorage.setItem('bk_token', t) : localStorage.removeItem('bk_token'); },
  async call(method, path, body) {
    const opt = { method, headers: { 'Content-Type': 'application/json' } };
    if (this.token) opt.headers['Authorization'] = 'Bearer ' + this.token;
    if (body !== undefined) opt.body = JSON.stringify(body);
    let res, data;
    try { res = await fetch(API_BASE + path, opt); }
    catch { throw new Error('Network error — server not reachable'); }
    try { data = await res.json(); }
    catch { data = { ok: false, error: 'Bad response (' + res.status + ')' }; }
    if (res.status === 401) { API.setToken(''); }
    if (!data.ok) { const e = new Error(data.error || 'Request failed'); e.data = data; e.status = res.status; throw e; }
    return data;
  },
  get(p) { return this.call('GET', p); },
  post(p, b) { return this.call('POST', p, b || {}); },
  patch(p, b) { return this.call('PATCH', p, b || {}); },
  put(p, b) { return this.call('PUT', p, b || {}); },
  del(p) { return this.call('DELETE', p); }
};

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* toast */
function toast(title, msg, type = 'ok') {
  let box = $('#toast');
  if (!box) { box = el('div'); box.id = 'toast'; document.body.appendChild(box); }
  const t = el('div', 'toast' + (type === 'err' ? ' err' : ''));
  t.innerHTML = `<div class="tic">${type === 'err' ? '!' : '✓'}</div>
    <div><b>${esc(title)}</b>${msg ? `<p>${esc(msg)}</p>` : ''}</div>
    <button class="x">✕</button>`;
  t.querySelector('.x').onclick = () => t.remove();
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = '.3s'; setTimeout(() => t.remove(), 320); }, 4200);
}

/* modal */
function openModal(html) {
  let bg = $('#modal-bg');
  if (!bg) { bg = el('div'); bg.id = 'modal-bg'; bg.className = 'modal-bg'; document.body.appendChild(bg); }
  bg.innerHTML = `<div class="modal">${html}</div>`;
  bg.classList.add('show');
  bg.onclick = e => { if (e.target === bg) closeModals(); };
  $$('[data-close]', bg).forEach(b => b.onclick = closeModals);
  return bg;
}
function closeModals() { const bg = $('#modal-bg'); if (bg) bg.classList.remove('show'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModals(); const p = $('.palette-bg'); if (p) p.classList.remove('show'); } });

/* formatting */
function fmtDate(ms) {
  if (!ms) return 'Lifetime';
  const d = new Date(Number(ms));
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function timeAgo(ms) {
  if (!ms) return 'never';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function copyText(txt, label = 'Copied') {
  const done = () => toast(label, txt.length > 40 ? txt.slice(0, 40) + '…' : txt);
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(done).catch(() => fallback());
  else fallback();
  function fallback() {
    const ta = el('textarea'); ta.value = txt;
    ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta);
    ta.select(); try { document.execCommand('copy'); done(); } catch { toast('Copy failed', '', 'err'); }
    ta.remove();
  }
}
function licenseStatus(k) {
  if (k.revoked) return { cls: 'red', txt: 'Revoked' };
  if (k.expires_at && k.expires_at < Date.now()) return { cls: 'grey', txt: 'Expired' };
  if (k.hwid) return { cls: 'violet', txt: 'Bound' };
  return { cls: 'green', txt: 'Available' };
}
function downloadFile(name, content, type = 'text/csv') {
  const blob = new Blob([content], { type });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
async function me() {
  if (API.token) {
    try { const d = await API.get('/api/auth/me'); return d.user; } catch { }
  }
  return null;
}
function requireLogin() {
  if (!API.token) { location.href = '/login.html'; return false; }
  return true;
}
