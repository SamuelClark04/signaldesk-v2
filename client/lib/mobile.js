// iPhone shell (Phase 55, <= 768px; styles/mobile.css). Desktop ignores all of it.
//   Bottom tab bar   Today · Setups · Approvals [badge] · Portfolio · Settings,
//                    fixed above the home indicator (env(safe-area-inset-bottom))
//   Status bar       the top bar gains the Account Value (active venue, the same
//                    totals as Today / Portfolio) and a Scan button next to the
//                    venue badge (Paper / LIVE)
//   Card tables      every .data-table cell gets data-label = its column header,
//                    so mobile.css can lay each row out as a 2-column card
//                    (no horizontal scroll). Labelled on every DOM change.
// app.js calls SD.mobile.sync(tab, state) after each render.
// Exposes window.SignalDesk.mobile.
(() => {
  const SD = window.SignalDesk;
  const { $, el, money } = SD.ui;

  const ICONS = { // 24x24 stroke icons
    today: 'M4 5h16v15H4zM4 10h16M9 3v4M15 3v4',
    setups: 'M3 17l6-6 4 4 8-8M15 7h6v6',
    approvals: 'M5 12l5 5L20 7',
    portfolio: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  };
  const TABS = [['today', 'Today', 'today'], ['setups', 'Setups', 'opportunities?tab=setups'], ['approvals', 'Approvals', 'opportunities?tab=approvals'],
    ['portfolio', 'Portfolio', 'portfolio'], ['settings', 'Settings', 'settings']];
  const NS = 'http://www.w3.org/2000/svg';

  function icon(key) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', ICONS[key]);
    svg.append(p);
    return svg;
  }

  let built = false;
  function build() {
    const bar = $('m-tabbar');
    if (!bar || built) return;
    built = true;
    bar.replaceChildren(...TABS.map(([key, label, hash]) => {
      const b = el('button', { type: 'button', className: 'm-tab', dataset: { key } }, [icon(key), el('span', { className: 'm-tab-label', textContent: label })]);
      b.onclick = () => { history.pushState(null, '', `#${hash}`); SD.app.showTab(hash); window.scrollTo({ top: 0 }); };
      return b;
    }));
    const scan = $('m-scan');
    if (scan) scan.onclick = () => { SD.app.send({ type: 'RUN_SCAN' }); scan.disabled = true; scan.textContent = 'Scanning…'; };
  }

  function sync(tab, state) {
    build();
    const active = tab === 'opportunities' ? (SD.opportunities.subTab() === 'approvals' ? 'approvals' : 'setups') : tab;
    const waiting = SD.oppApprovals.count(state);
    document.querySelectorAll('.m-tab').forEach((b) => {
      const on = b.dataset.key === active;
      b.classList.toggle('is-active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      let badge = b.querySelector('.m-tab-badge');
      if (b.dataset.key === 'approvals' && waiting) {
        if (!badge) { badge = el('span', { className: 'm-tab-badge' }); b.append(badge); }
        badge.textContent = waiting > 99 ? '99+' : String(waiting);
      } else if (badge) badge.remove();
    });
    const acct = $('m-account');
    if (acct) {
      let v = null;
      try { v = SD.portfolioMetrics.metrics(state, SD.venue.current(state)).totals.accountValue; } catch { /* state not loaded yet */ }
      acct.textContent = Number.isFinite(v) && v > 0 ? money(v) : '—';
      acct.title = `Account value · ${SD.venue.LABEL[SD.venue.current(state)]}`;
    }
    const scan = $('m-scan');
    if (scan) {
      const running = !!(state.scan && state.scan.running);
      scan.disabled = running || !SD.app.isOnline();
      scan.textContent = running ? 'Scanning…' : 'Scan';
    }
  }

  // ---------- Card tables: each cell labelled with its column header ----------
  function labelTable(table) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    if (!heads.length) return;
    for (const tr of table.querySelectorAll('tbody tr')) {
      let i = 0;
      for (const td of tr.children) {
        const label = heads[i] || '';
        if (td.dataset.label !== label) td.dataset.label = label;
        i += td.colSpan || 1;
      }
    }
  }
  let queued = false;
  const labelAll = () => { queued = false; document.querySelectorAll('table.data-table').forEach(labelTable); };
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(labelAll); } })
    .observe(document.body, { childList: true, subtree: true });

  SD.mobile = { sync, labelTable };
})();
