// Entry-shield banners (Phase 81, server risk/entry-shields.js ENTRY_SHIELDS): one line at the top of Today and
// Opportunities ([data-shield] boxes).
//   DAILY KILL SWITCH ACTIVE: -$150 loss limit reached       (no new entries until tomorrow)
//   PAUSED FOR MACRO EVENT: CPI · Resumes at 8:45 AM ET      (stocks / options; crypto only if opted in)
//   otherwise a quiet "next blackout" note when one is due within 18 hours, else nothing.
// Open trades, stops, targets and closes are never paused. Exposes window.SignalDesk.shieldBanner.
(() => {
  const SD = window.SignalDesk;
  const { el, money } = SD.ui;
  let last = null;

  const scopeText = (m) => (m.crypto ? 'stocks, options and crypto' : 'stocks and options (crypto keeps trading)');

  function content(s) {
    const k = s && s.kill;
    if (k && k.active) {
      return ['is-stop', `DAILY KILL SWITCH ACTIVE: -${money(k.limit)} loss limit reached`,
        `Today's P/L ${k.pnl < 0 ? '-' : '+'}${money(Math.abs(k.pnl))} (tripped at ${money(Math.abs(k.trippedPnl))} down). No new entries until tomorrow; open trades, stops, targets and closes keep working. Settings > Risk Management changes the limit.`];
    }
    const m = s && s.macro;
    if (m && m.enabled && m.active) {
      return ['is-warn', `PAUSED FOR MACRO EVENT: ${m.event} · Resumes at ${m.resumesClock}`,
        `Release at ${m.releaseClock}: no new ${scopeText(m)} entries from 30 min before to 15 min after. Open trades, stops and closes keep working.`];
    }
    const next = m && m.enabled && (m.upcoming || []).find((e) => e.releaseTime > s.at && e.releaseTime - s.at <= 18 * 3600e3);
    if (next) {
      const when = new Date(next.releaseTime).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
      return ['is-info', `Next macro blackout: ${next.event} ${when} ${next.clock}`, `New ${scopeText(m)} entries pause from 30 min before to 15 min after the release.`];
    }
    return null;
  }

  function render(s) {
    if (s) last = s;
    const c = content(last);
    for (const box of document.querySelectorAll('[data-shield]')) {
      box.hidden = !c;
      box.className = `shield-banner${c ? ` ${c[0]}` : ''}`;
      box.replaceChildren(...(c ? [el('strong', { textContent: c[1] }), el('span', { className: 'shield-sub', textContent: c[2] })] : []));
    }
  }

  SD.shieldBanner = { render, content };
})();
