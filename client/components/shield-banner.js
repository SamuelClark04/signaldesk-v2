// Entry-shield banners (Phase 81, server risk/entry-shields.js ENTRY_SHIELDS): one line at the top of Today and
// Opportunities ([data-shield] boxes).
//   DAILY KILL SWITCH ACTIVE (Paper): -$150 loss limit reached (that book only; Phase 83)
//   PAUSED FOR MACRO EVENT: CPI · Resumes at 8:45 AM ET      (stocks / options; crypto only if opted in)
//   otherwise a quiet "next blackout" note when one is due within 18 hours, else nothing.
// Open trades, stops, targets and closes are never paused. Exposes window.SignalDesk.shieldBanner.
(() => {
  const SD = window.SignalDesk;
  const { el, money } = SD.ui;
  let last = null;

  const scopeText = (m) => (m.crypto ? 'stocks, options and crypto' : 'stocks and options (crypto keeps trading)');

  function content(s) {
    // Phase 83: one switch per book (s.kill = { paper, live }); the other book keeps trading.
    const hit = s && s.kill ? ['live', 'paper'].map((b) => s.kill[b]).filter((k) => k && k.active) : [];
    if (hit.length) {
      const name = (k) => (k.book === 'live' ? 'Live' : 'Paper');
      const other = hit.length === 2 ? '' : ` ${hit[0].book === 'live' ? 'Paper' : 'Live'} trading is not affected.`;
      return ['is-stop', `DAILY KILL SWITCH ACTIVE (${hit.map(name).join(' + ')}): ${hit.map((k) => `-${money(k.limit)}`).join(' / ')} loss limit reached`,
        `${hit.map((k) => `${name(k)} P/L today ${k.pnl < 0 ? '-' : '+'}${money(Math.abs(k.pnl))}`).join('; ')}. No new ${hit.map((k) => k.book).join(' or ')} entries until tomorrow; `
        + `open trades, stops, targets and closes keep working.${other} Settings > Risk Management changes the limits.`];
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
