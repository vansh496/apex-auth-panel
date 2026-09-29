/*
 * webhook.js — Discord realtime audit
 *   jab bhi koi key use ho (ya login / account delete), Discord channel me
 *   embed chala jaata hai (IP, location, HWID, product, plan, expiry …)
 *
 *   Setup: Site Settings → "Discord webhook (realtime audit)" me webhook URL
 *   (https://discord.com/api/webhooks/…) paste karein. Khali = band.
 */
'use strict';

const { setting } = require('./db');

const COLOR = { green: 0x2ecc71, red: 0xe74c3c, blue: 0x3498db, amber: 0xe67e22 };
const geoCache = new Map();   // ip -> { location, at } (1 ghante ki cache)
const GEO_TTL = 3600000;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function isLocalIp(ip) {
  if (!ip) return true;
  return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|localhost|::1|::ffff:127\.)/i.test(ip);
}

/** loopback = panel aur loader ek hi machine par (localhost) */
function isLoopback(ip) {
  return /^(127\.|::1$|::ffff:127\.)/i.test(String(ip || ''));
}

/** apni public IP (loader bhi usi machine par ho to location sahi chahiye) */
let selfIp = '', selfIpTried = false;   // ek hi baar try hota hai (fail ho to cache)
async function getJson(url, timeoutMs = 3000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}
async function selfPublicIp() {
  if (selfIpTried) return selfIp;
  selfIpTried = true;
  /* pehle IPv4 (chhota + familiar), nahi mila to jo bhi aaye (IPv6) */
  try {
    const v4 = await getJson('https://api4.ipify.org?format=json');
    if (v4 && v4.ip) { selfIp = v4.ip; return selfIp; }
  } catch { }
  try {
    const j = await getJson('https://ipwho.is/');
    if (j && j.success !== false && j.ip) { selfIp = j.ip; return selfIp; }
  } catch { }
  return selfIp;
}

/**
 * request IP -> dikhane wala IP + geo target
 *   loopback  -> apni public IP (kyunki client wahi machine hai)
 *   private   -> wahi IP, geo skip (bina internet ke city nahi bat sakti)
 *   public    -> wahi IP + geo
 */
async function resolveIp(ip) {
  ip = String(ip || '');
  if (isLoopback(ip)) {
    const pub = await selfPublicIp();
    return { display: pub || ip, geo: pub };
  }
  if (isLocalIp(ip)) return { display: ip, geo: '' };
  return { display: ip, geo: ip };
}

function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return '';
  return String.fromCodePoint(
    ...cc.toUpperCase().split('').map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/* geo providers — pehla jo chal jaye wahi (offline / rate-limit ke against fallback) */
const GEO_PROVIDERS = [
  async ip => {                                    // ipwho.is (https, no key)
    const j = await getJson('https://ipwho.is/' + encodeURIComponent(ip));
    if (!j || j.success === false) return null;
    return { city: j.city, region: j.region, country: j.country, cc: j.country_code };
  },
  async ip => {                                    // ipapi.co (https, no key)
    const j = await getJson('https://ipapi.co/' + encodeURIComponent(ip) + '/json/');
    if (!j || j.error) return null;
    return { city: j.city, region: j.region_name || j.region, country: j.country_name, cc: j.country_code };
  },
  async ip => {                                    // ip-api.com (http, 45/min)
    const j = await getJson('http://ip-api.com/json/' + encodeURIComponent(ip) +
                            '?fields=status,city,regionName,country,countryCode');
    if (!j || j.status !== 'success') return null;
    return { city: j.city, region: j.regionName, country: j.country, cc: j.countryCode };
  }
];

/** ip -> "🇮🇳 Ludhiana, Punjab, India"
 *  success → 1 ghante cache, fail → sirf 60 sec (jaldi retry, taaki city phir se aaye) */
async function geoLookup(ip) {
  if (!ip) return { location: 'LAN / private IP', country: '', cc: '' };
  if (isLocalIp(ip)) return { location: 'Localhost / LAN', country: '', cc: '' };

  const hit = geoCache.get(ip);
  if (hit) {
    if (Date.now() - hit.at < (hit.fail ? 60000 : GEO_TTL)) return hit;
    geoCache.delete(ip);
  }

  for (const p of GEO_PROVIDERS) {
    try {
      const g = await p(ip);
      if (!g || (!g.city && !g.country)) continue;
      const parts = [g.city, g.region, g.country].filter(Boolean);
      const flag = flagEmoji(g.cc || '');
      const location = parts.length
        ? (flag ? flag + ' ' : '') + parts.join(', ')
        : (((flag ? flag + ' ' : '') + (g.country || '')).trim() || ip);
      const out = { location, country: g.country || '', cc: g.cc || '', at: Date.now() };
      geoCache.set(ip, out);
      return out;
    } catch { }
  }

  const out = { location: ip + ' (location unavailable)', country: '', cc: '',
                at: Date.now(), fail: true };
  geoCache.set(ip, out);
  return out;
}

/** PolarX-1234-5678-9ABC-DEF0 -> PolarX-****-****-****-DEF0 */
function maskKey(k) {
  const p = String(k || '').split('-').filter(Boolean);
  if (p.length < 2) return String(k || '—');
  return p[0] + '-' + p.slice(1, -1).map(() => '****').join('-') + '-' + p[p.length - 1];
}

/** 0 -> Lifetime, future ms -> "in a month (2026-10-27)" */
function humanExpiry(ms) {
  ms = Number(ms) || 0;
  if (!ms) return 'Lifetime';
  const d = ms - Date.now();
  if (d <= 0) return 'Expired';
  const days = Math.floor(d / 86400000);
  const label = days >= 27 && days < 32 ? 'in a month'
              : days >= 2  ? `in ${days} days`
              : days === 1  ? 'tomorrow'
              : 'today';
  const date = new Date(ms).toISOString().slice(0, 10);
  return `${label} (${date})`;
}

/** "HWID-3-…6FBA" jaisa chhota format */
function shortHwid(h) {
  h = String(h || '').trim();
  if (!h) return '—';
  if (h.length <= 16) return h;
  return h.slice(0, 8) + '-…-' + h.slice(-4);
}

/** loader ka client naam (screenshot: "Windows Loader") */
function clientOf(ua) {
  const s = String(ua || '').trim();
  if (!s) return 'Windows Loader';
  if (/blazeloader|apexloader/i.test(s)) return 'Windows Loader';
  return s.slice(0, 80);
}

function fld(name, value) {
  return { name, value: String(value || '—').slice(0, 1024), inline: true };
}

/* ------------------------------------------------------------------ */
/* sender                                                              */
/* ------------------------------------------------------------------ */

async function send(embed) {
  const url = String(setting('discord_webhook', '') || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'webhook not configured' };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'APEX AUTH', embeds: [embed] })
    });
    clearTimeout(t);
    const txt = r.ok ? '' : String(await r.text().catch(() => '')).slice(0, 200);
    return { ok: r.ok, status: r.status, reason: txt };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function baseFooter() {
  return { text: 'APEX AUTH Security System — Realtime Audit' };
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

/** koi bhi key use hui (guest ho ya logged-in) — screenshot wala embed */
async function keyUsed(req, d) {
  const r = await resolveIp((req && req.ip) || '');
  const g = await geoLookup(r.geo);
  const embed = {
    title: 'User Authentication Successful',
    description: `User **${d.username}** has successfully authenticated to **${d.product}**.`,
    color: COLOR.green,
    fields: [
      fld('👤 User', d.username),
      fld('🧩 Product', d.product),
      fld('💳 Plan', d.plan),
      fld('🌐 IP Address', r.display || '—'),
      fld('📍 Location', g.location),
      fld('🔑 HWID', shortHwid(d.hwid)),
      fld('💻 Client', clientOf(req && req.get ? req.get('user-agent') : '')),
      fld('⏳ Expires', humanExpiry(d.expiresAt)),
      fld('✅ Status', d.status || 'Authorized'),
      fld('🎟 License Key', maskKey(d.key))
    ],
    footer: baseFooter(),
    timestamp: new Date().toISOString()
  };
  return send(embed);
}

/** admin ne user delete kiya (screenshot wala "Account Removed") */
async function accountRemoved(req, d) {
  const r = await resolveIp((req && req.ip) || '');
  const g = await geoLookup(r.geo);
  const embed = {
    title: 'Account Removed',
    description: `User account **${d.username}** was permanently removed.`,
    color: COLOR.red,
    fields: [
      fld('👤 User', d.username),
      fld('👮 Removed by', d.by || '—'),
      fld('🌐 IP Address', r.display || '—'),
      fld('📍 Location', g.location),
      fld('💻 Client', clientOf(req && req.get ? req.get('user-agent') : '')),
      fld('🎟 Keys revoked', d.keys || 0)
    ],
    footer: baseFooter(),
    timestamp: new Date().toISOString()
  };
  return send(embed);
}

/** Site Settings ka "Test" button */
async function testEmbed(req) {
  const r = await resolveIp((req && req.ip) || '');
  const g = await geoLookup(r.geo);
  const embed = {
    title: '🔔 Webhook test',
    description: 'APEX AUTH panel se bheja gaya test embed — agar ye dikh raha hai to setup sahi hai.',
    color: COLOR.blue,
    fields: [
      fld('🌐 IP Address', r.display || '—'),
      fld('📍 Location', g.location),
      fld('💻 Client', clientOf(req && req.get ? req.get('user-agent') : '')),
      fld('🕒 Server time', new Date().toISOString())
    ],
    footer: baseFooter(),
    timestamp: new Date().toISOString()
  };
  return send(embed);
}

module.exports = { keyUsed, accountRemoved, testEmbed, send, geoLookup, maskKey, humanExpiry };
