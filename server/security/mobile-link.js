// Settings → Mobile access: the live public address and a one-click re-send of
// the one-tap sign-in email (notifier.sendTunnelReadyEmail, forced).
//   GET  /api/settings/tunnel-link       { url, emailConfigured, lastEmail }
//   POST /api/settings/send-tunnel-link  emails a fresh magic link to ALERT_EMAIL_TO
// Installed AFTER the sign-in gate (auth-gate.js), so both need a session, and a
// request from another site is refused by its Origin. The response never holds
// the magic link itself: it only ever goes to the configured inbox.
// The public address: the Cloudflare quick tunnel's, else an https APP_PUBLIC_URL
// that is not this machine (a fixed tunnel hostname, say). None: nothing to send.
const tunnel = require('./tunnel-manager');
const notifier = require('../execution/notifier');

const RESEND_GAP_MS = 30 * 1000;
let lastSendAt = 0;

function publicUrl() {
  if (tunnel.url()) return tunnel.url();
  try {
    const u = new URL(String(process.env.APP_PUBLIC_URL || ''));
    return u.protocol === 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname) ? u.origin : null;
  } catch { return null; }
}

function status() {
  const last = notifier.lastTunnelEmail();
  return { url: publicUrl(), emailConfigured: notifier.emailConfigured(), lastEmail: last ? { url: last.url, at: last.at, delivered: last.delivered } : null };
}

function install(app) {
  app.get('/api/settings/tunnel-link', (req, res) => res.set('Cache-Control', 'no-store').json(status()));
  app.post('/api/settings/send-tunnel-link', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const url = publicUrl();
    if (!url) return res.status(409).json({ ok: false, error: 'No public tunnel is running, so there is no mobile link to send.', ...status() });
    if (!notifier.emailConfigured()) return res.status(409).json({ ok: false, error: 'Email is not set up (SMTP_* and ALERT_EMAIL_TO in .env).', ...status() });
    const wait = lastSendAt + RESEND_GAP_MS - Date.now();
    if (wait > 0) return res.status(429).json({ ok: false, error: `A link was just sent. Try again in ${Math.ceil(wait / 1000)} s.`, ...status() });
    lastSendAt = Date.now();
    const result = await notifier.sendTunnelReadyEmail(url, { force: true });
    console.log(`[mobile-link] Settings re-send for ${url}: ${result.delivered}${result.error ? ` (${result.error})` : ''}`);
    if (result.delivered !== 'email') return res.status(502).json({ ok: false, error: `The email could not be sent (${result.error || 'SMTP unavailable'}).`, ...status() });
    return res.json({ ok: true, ...status() });
  });
}

module.exports = { install, publicUrl };
