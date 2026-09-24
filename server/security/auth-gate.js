// Sign-in gate (zero trust, see access-policy.js). install(app, port) must run
// BEFORE the static files and API routes:
//   GET  /login   the only page served without a session: a token form
//   POST /login   checks the token (rate-limited), sets the session cookie
//   GET  /logout  clears the cookie
//   any request carrying a valid ?token= (older phone links) gets the cookie and
//   is redirected to the same URL without the token (it never stays in the bar)
//   everything else without a session: HTML pages -> /login, the rest -> 401
// Cookie: HttpOnly, SameSite=Strict, Path=/, 30 days, Secure when served over
// HTTPS (e.g. through a Cloudflare Tunnel: X-Forwarded-Proto https).
// Failed logins: at most FAIL_LIMIT per client per window, and FAIL_GLOBAL in
// total per window (a lock that also holds if client addresses are spoofed).
const express = require('express');
const policy = require('./access-policy');

const MAX_AGE_S = 30 * 24 * 3600;
const WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 10;
const FAIL_GLOBAL = 100;
const fails = new Map(); // client -> { count, since }
let globalFails = { count: 0, since: Date.now() };

// Behind Cloudflare the TCP peer is always cloudflared (127.0.0.1); its header names the real client.
const clientOf = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?').slice(0, 64);
const isHttps = (req) => req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

function locked(client, now = Date.now()) {
  if (now - globalFails.since > WINDOW_MS) globalFails = { count: 0, since: now };
  const f = fails.get(client);
  if (f && now - f.since > WINDOW_MS) fails.delete(client);
  return globalFails.count >= FAIL_GLOBAL || ((fails.get(client) || {}).count || 0) >= FAIL_LIMIT;
}
function recordFail(client, now = Date.now()) {
  const f = fails.get(client) || { count: 0, since: now };
  f.count += 1;
  fails.set(client, f);
  globalFails.count += 1;
}

function setSession(req, res) {
  res.setHeader('Set-Cookie', `${policy.COOKIE}=${policy.SESSION}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_S}${isHttps(req) ? '; Secure' : ''}`);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loginPage(res, status, message = '') {
  res.status(status).set({
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  }).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SignalDesk sign in</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;color:#e5e7eb;font:15px system-ui,-apple-system,Segoe UI,sans-serif}
form{width:min(360px,calc(100vw - 32px));padding:24px;border:1px solid #1f2937;border-radius:12px;background:#111827}
h1{margin:0 0 6px;font-size:20px}p{margin:0 0 16px;color:#94a3b8;font-size:13px;line-height:1.5}
input{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid #334155;border-radius:8px;background:#0b1220;color:#e5e7eb;font:14px ui-monospace,monospace}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;background:#2f81f7;color:#fff;font-weight:700;font-size:14px;cursor:pointer}
.err{margin:10px 0 0;color:#fb7185;font-size:13px}
</style></head><body><form method="post" action="/login" autocomplete="off">
<h1>SignalDesk</h1><p>Enter the access token (LAN_ACCESS_TOKEN in the server's .env) to open the terminal on this device.</p>
<input type="password" name="token" aria-label="Access token" placeholder="Access token" required autofocus>
<button type="submit">Sign in</button>${message ? `<p class="err">${escapeHtml(message)}</p>` : ''}
</form></body></html>`);
}

function install(app, port) {
  app.get('/login', (req, res) => (policy.hasSession(req) ? res.redirect(303, '/') : loginPage(res, 200)));
  app.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !policy.isAllowedOrigin(origin, port)) return loginPage(res, 403, 'Sign-in from this page is not allowed.');
    const client = clientOf(req);
    if (locked(client)) {
      console.warn(`[security] login locked for ${client} (too many failed attempts)`);
      return loginPage(res, 429, 'Too many failed attempts. Try again in 15 minutes.');
    }
    if (!policy.tokenMatches(req.body && req.body.token)) {
      recordFail(client);
      console.warn(`[security] failed login from ${client}`);
      return setTimeout(() => loginPage(res, 401, 'That token is not correct.'), 600);
    }
    fails.delete(client);
    console.log(`[security] signed in: ${client}`);
    setSession(req, res);
    return res.redirect(303, '/');
  });
  app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${policy.COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.redirect(303, '/login');
  });

  // Gate for everything else (static client files, /api/*).
  app.use((req, res, next) => {
    const url = new URL(req.originalUrl, 'http://placeholder');
    const token = url.searchParams.get('token');
    if (token !== null) {
      url.searchParams.delete('token');
      const clean = `${url.pathname}${url.search}`;
      const client = clientOf(req);
      if (locked(client) || !policy.tokenMatches(token)) { recordFail(client); return res.redirect(303, '/login'); }
      setSession(req, res);
      return res.redirect(303, clean);
    }
    const verdict = policy.checkHttp(req, port);
    if (verdict.ok) return next();
    const wantsPage = req.method === 'GET' && (url.pathname === '/' || url.pathname.endsWith('.html'));
    if (wantsPage && verdict.login) return res.redirect(303, '/login');
    console.warn(`[security] refused ${req.method} ${url.pathname}: ${verdict.reason}`);
    return res.status(verdict.login ? 401 : 403).set('Cache-Control', 'no-store').json({ error: verdict.login ? 'sign in required' : 'forbidden' });
  });
}

module.exports = { install };
