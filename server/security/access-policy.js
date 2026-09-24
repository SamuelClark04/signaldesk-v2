// Network access policy for the terminal's WebSocket (the socket can approve
// live orders and change settings, so who may open it matters).
//
// Default (LAN_ACCESS unset): the server listens on 127.0.0.1 only, and only
// the terminal's own localhost origins may open the socket.
//
// LAN mode (LAN_ACCESS=true): the server listens on all interfaces so a phone on
// the same Wi-Fi can reach it. Two checks then apply:
//   1. Origin must be the terminal on localhost or a PRIVATE IPv4 address
//      (10/8, 172.16/12, 192.168/16) on the same port, which blocks other
//      websites open in a browser (CSWSH);
//   2. any connection NOT from this machine must present the access token.
//      An Origin header is trivial to fake outside a browser, so the token is
//      what keeps other devices on the network out.
// The token comes from LAN_ACCESS_TOKEN (min 24 chars) or is generated per run.
const crypto = require('crypto');
const os = require('os');

const LAN_ACCESS = String(process.env.LAN_ACCESS).toLowerCase() === 'true';
const MIN_TOKEN_LENGTH = 24;

function resolveToken() {
  if (!LAN_ACCESS) return null;
  const fromEnv = process.env.LAN_ACCESS_TOKEN;
  if (fromEnv && fromEnv.length >= MIN_TOKEN_LENGTH) return fromEnv;
  if (fromEnv) console.warn(`[security] LAN_ACCESS_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters; using a generated token instead`);
  return crypto.randomBytes(24).toString('base64url');
}
const TOKEN = resolveToken();

const HOST = LAN_ACCESS ? '0.0.0.0' : '127.0.0.1';

function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const isLoopbackHost = (host) => host === 'localhost' || host === '127.0.0.1';

// Origin must be exactly http://<allowed host>:<port>: no path, other port or https.
function isAllowedOrigin(origin, port) {
  if (!origin) return false;
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.protocol !== 'http:' || url.port !== String(port) || url.origin !== origin) return false;
  if (isLoopbackHost(url.hostname)) return true;
  return LAN_ACCESS && isPrivateIPv4(url.hostname);
}

// Where the TCP connection really comes from (not a header a client can set).
function isLoopbackSocket(req) {
  const addr = (req.socket && req.socket.remoteAddress) || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function tokenMatches(candidate) {
  if (!TOKEN || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Decide one WebSocket upgrade. Returns { ok: true } or { ok: false, reason }.
function checkUpgrade(req, port) {
  const { pathname, searchParams } = new URL(req.url, 'http://placeholder');
  if (pathname !== '/ws') return { ok: false, reason: `path ${pathname}` };
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin, port)) return { ok: false, reason: `origin ${origin || '(none)'}` };
  if (LAN_ACCESS && !isLoopbackSocket(req) && !tokenMatches(searchParams.get('token'))) {
    return { ok: false, reason: `missing/invalid access token from ${req.socket.remoteAddress}` };
  }
  return { ok: true };
}

// URLs to open on a phone (one per private IPv4 interface), token included.
function lanUrls(port) {
  if (!LAN_ACCESS) return [];
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && isPrivateIPv4(i.address))
    .map((i) => `http://${i.address}:${port}/?token=${TOKEN}`);
}

module.exports = { HOST, LAN_ACCESS, checkUpgrade, isAllowedOrigin, isPrivateIPv4, lanUrls };
