// Settings → Mobile access: the live public tunnel address and "Send Mobile Link
// to Email", which emails a fresh one-tap sign-in link to ALERT_EMAIL_TO
// (server/security/mobile-link.js). Plain same-origin fetches: the session
// cookie authenticates them. Refreshed when Settings is opened, every 30 s while
// it is on screen, and after each send.
// Exposes window.SignalDesk.settingsMobile: { refresh() }.
(() => {
  const SD = window.SignalDesk;
  const { $, el, age } = SD.ui;

  let busy = false;

  function status(text, kind = '') {
    const s = $('settings-link-status');
    s.textContent = text;
    s.className = `settings-status${kind ? ` is-${kind}` : ''}`;
  }

  function render(info) {
    const box = $('settings-tunnel');
    const last = info.lastEmail;
    box.replaceChildren(...(info.url
      ? ['Public address: ', el('a', { href: info.url, textContent: info.url, target: '_blank', rel: 'noopener noreferrer', className: 'settings-tunnel-url' }),
        last && last.url === info.url ? ` · last emailed ${age(last.at)} ago${last.delivered === 'email' ? '' : ' (not delivered)'}` : '']
      : ['No public tunnel is running (cloudflared not found, TUNNEL=off, or still starting). Only this PC and your LAN can reach SignalDesk.']));
    if (!info.emailConfigured) box.append(' Email is not set up: add SMTP_* and ALERT_EMAIL_TO to .env.');
    $('settings-send-link').disabled = busy || !info.url || !info.emailConfigured;
  }

  async function refresh() {
    try {
      const r = await fetch('/api/settings/tunnel-link', { cache: 'no-store' });
      if (r.ok) render(await r.json());
    } catch { /* offline: keep what is shown */ }
  }

  async function send() {
    busy = true;
    $('settings-send-link').disabled = true;
    status('Sending…');
    try {
      const r = await fetch('/api/settings/send-tunnel-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = await r.json().catch(() => ({}));
      if (body.url !== undefined) render(body);
      if (r.ok && body.ok) status('Sent. Tap "Open SignalDesk on Phone" in the email.', 'ok');
      else status(body.error || `Not sent (HTTP ${r.status}).`, 'error');
    } catch {
      status('Offline: cannot reach the server.', 'error');
    } finally {
      busy = false;
      refresh();
    }
  }

  $('settings-send-link').addEventListener('click', send);
  const onSettings = () => location.hash.startsWith('#settings');
  window.addEventListener('hashchange', () => { if (onSettings()) refresh(); });
  setInterval(() => { if (onSettings() && !document.hidden) refresh(); }, 30000);
  refresh();

  SD.settingsMobile = { refresh };
})();
