// One-tap magic sign-in links, for the emails (tunnel ready, re-sent from
// Settings, trade approvals). A free trycloudflare.com tunnel gets a new
// hostname every run, so a phone's session cookie from the last one never
// applies; tapping a magic link signs that browser in on the new origin.
//   GET /api/auth/magic?t=<ms timestamp>&to=<in-app path>&sig=<HMAC>
//   sig = HMAC-SHA256 of "signaldesk-magic-v1\n<t>\n<to>" keyed with the access
//   token (access-policy.sign): only this server can make one, the token never
//   leaves it, and changing the token voids every link ever sent.
// A link works for TTL (MAGIC_LINK_TTL_HOURS, default 24, 1-168) from when it
// was made; `to` must be an in-app path (/, /#today, /#opportunities?tab=approvals),
// never another site. auth-gate.js serves the endpoint (rate-limited like /login).
// The links are sign-in credentials: they go only to ALERT_EMAIL_TO and are
// never printed on the console.
const policy = require('./access-policy');

const TTL_MS = (() => {
  const h = Number(process.env.MAGIC_LINK_TTL_HOURS);
  return (h >= 1 && h <= 168 ? h : 24) * 3600 * 1000;
})();
const MAX_SKEW_MS = 5 * 60 * 1000; // a link "from the future" (clock skew) is refused beyond this
const TARGET_RE = /^\/(#[a-z]+(\?tab=[a-z]+)?)?$/;
const DEFAULT_TARGET = '/#today';
const payload = (t, to) => `signaldesk-magic-v1\n${t}\n${to}`;

// A signed link on `base` (the public origin, e.g. the tunnel URL) to `to`.
function create(base, to = DEFAULT_TARGET, now = Date.now()) {
  if (!TARGET_RE.test(to)) throw new Error(`magic-link: "${to}" is not an in-app path`);
  const t = String(Math.floor(now));
  const url = new URL('api/auth/magic', `${String(base).replace(/\/*$/, '')}/`);
  url.searchParams.set('t', t);
  url.searchParams.set('to', to);
  url.searchParams.set('sig', policy.sign(payload(t, to)));
  return url.toString();
}

// Check a link's query ({ t, to, sig }): { ok: true, to } or { ok: false, reason }.
function verify(query, now = Date.now()) {
  const { t, sig } = query || {};
  const to = query && query.to !== undefined && query.to !== '' ? query.to : DEFAULT_TARGET;
  if (typeof t !== 'string' || !/^\d{10,16}$/.test(t) || typeof sig !== 'string' || typeof to !== 'string') return { ok: false, reason: 'malformed link' };
  if (!TARGET_RE.test(to)) return { ok: false, reason: 'target is not an in-app path' };
  if (!policy.safeEqual(sig, policy.sign(payload(t, to)))) return { ok: false, reason: 'bad signature' };
  const age = now - Number(t);
  if (age > TTL_MS) return { ok: false, reason: `expired (${Math.round(age / 3600000)} h old)` };
  if (age < -MAX_SKEW_MS) return { ok: false, reason: 'timestamp in the future' };
  return { ok: true, to };
}

module.exports = { create, verify, TTL_MS, DEFAULT_TARGET };
