// Network access policy: ZERO TRUST. Every request (UI assets, HTTP API and the
// WebSocket, which can approve live orders) must prove it knows the access
// token, whatever address it comes from. There is NO exemption for 127.0.0.1:
// a Cloudflare Tunnel (or any local proxy) delivers internet traffic from
// localhost, so "local" proves nothing. The only unauthenticated page is
// /login (server/security/auth-gate.js).
//
// Proof of the token, any one of:
//   - the session cookie set by /login (HttpOnly, SameSite=Strict): its value
//     is an HMAC of the token, so the token itself never sits in the browser;
//   - header X-SignalDesk-Token (scripts);
//   - ?token= on the WebSocket URL (older phone links; the page never stores it).
// Plus, for the WebSocket and cross-site HTTP requests, the Origin must be the
// terminal itself: localhost / 127.0.0.1 on the port, a private IPv4 address in
// LAN mode, or APP_PUBLIC_URL / ALLOWED_ORIGINS (e.g. the Cloudflare Tunnel
// hostname). That blocks other websites open in the same browser (CSWSH).
//
// Token: LAN_ACCESS_TOKEN (or ACCESS_TOKEN) from .env, at least 24 characters
// (32+ random recommended when the terminal is reachable from the internet);
// otherwise a random one is generated per run and printed on the console.
const crypto = require('crypto');
const os = require('os');

const LAN_ACCESS = String(process.env.LAN_ACCESS).toLowerCase() === 'true';
const MIN_TOKEN_LENGTH = 24;
const COOKIE = 'sd_session';

function resolveToken() {
  const fromEnv = process.env.LAN_ACCESS_TOKEN || process.env.ACCESS_TOKEN;
  if (fromEnv && fromEnv.length >= MIN_TOKEN_LENGTH) {
    if (fromEnv.length < 32) console.warn('[security] access token is under 32 characters; use 32+ random characters if the terminal is reachable from the internet');
    return { token: fromEnv, generated: false };
  }
  if (fromEnv) console.warn(`[security] access token is shorter than ${MIN_TOKEN_LENGTH} characters; using a generated token for this run`);
  return { token: crypto.randomBytes(24).toString('base64url'), generated: true };
}
const { token: TOKEN, generated: TOKEN_GENERATED } = resolveToken();
// Session cookie value: HMAC of the token (changing the token signs everyone out).
const SESSION = crypto.createHmac('sha256', TOKEN).update('signaldesk-session-v1').digest('base64url');

const HOST = LAN_ACCESS ? '0.0.0.0' : '127.0.0.1';

function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const isLoopbackHost = (host) => host === 'localhost' || host === '127.0.0.1';

// Extra page origins: APP_PUBLIC_URL (tunnel / public hostname) + ALLOWED_ORIGINS (comma list).
const EXTRA_ORIGINS = new Set([process.env.APP_PUBLIC_URL, ...String(process.env.ALLOWED_ORIGINS || '').split(',')]
  .map((u) => { try { return new URL(String(u).trim()).origin; } catch { return null; } }).filter(Boolean));

// Runtime additions: the Cloudflare quick tunnel's address, learned at startup (tunnel.js).
function addAllowedOrigin(url) { try { EXTRA_ORIGINS.add(new URL(url).origin); } catch { /* not a URL */ } }
function removeAllowedOrigin(url) { try { EXTRA_ORIGINS.delete(new URL(url).origin); } catch { /* not a URL */ } }

// The page's origin: exactly http://<local or LAN host>:<port>, or a configured public origin.
function isAllowedOrigin(origin, port) {
  if (!origin) return false;
  if (EXTRA_ORIGINS.has(origin)) return true;
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.protocol !== 'http:' || url.port !== String(port) || url.origin !== origin) return false;
  if (isLoopbackHost(url.hostname)) return true;
  return LAN_ACCESS && isPrivateIPv4(url.hostname);
}

function safeEqual(candidate, secret) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const tokenMatches = (candidate) => safeEqual(candidate, TOKEN);

function cookieValue(req, name = COOKIE) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Does this request carry proof of the token (cookie or header)?
const hasSession = (req) => safeEqual(cookieValue(req), SESSION) || tokenMatches(req.headers['x-signaldesk-token']);

// Decide one WebSocket upgrade. Returns { ok: true } or { ok: false, reason }.
function checkUpgrade(req, port) {
  const { pathname, searchParams } = new URL(req.url, 'http://placeholder');
  if (pathname !== '/ws') return { ok: false, reason: `path ${pathname}` };
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin, port)) return { ok: false, reason: `origin ${origin || '(none)'}` };
  if (!hasSession(req) && !tokenMatches(searchParams.get('token'))) return { ok: false, reason: `not signed in (from ${req.socket.remoteAddress})` };
  return { ok: true };
}

// Decide one HTTP request (assets and API). A browser sends Origin on cross-site
// requests: other websites are refused even with the cookie.
function checkHttp(req, port) {
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin, port)) return { ok: false, reason: `origin ${origin}` };
  if (!hasSession(req)) return { ok: false, reason: `not signed in (from ${req.socket.remoteAddress})`, login: true };
  return { ok: true };
}

// URLs to open on a phone (one per private IPv4 interface), token included.
function lanUrls(port) {
  if (!LAN_ACCESS) return [];
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && isPrivateIPv4(i.address))
    .map((i) => `http://${i.address}:${port}/?token=${TOKEN}`);
}

module.exports = { HOST, LAN_ACCESS, COOKIE, SESSION, TOKEN_GENERATED, checkUpgrade, checkHttp, hasSession, tokenMatches,
  isAllowedOrigin, addAllowedOrigin, removeAllowedOrigin, isPrivateIPv4, lanUrls, generatedToken: () => (TOKEN_GENERATED ? TOKEN : null) };
