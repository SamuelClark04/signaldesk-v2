// Portfolio → Pilot: the 4-action matrix (server/strategies/pilot-matrix.js,
// PILOT_MATRIX once per pipeline pass). One verdict per open holding:
//   SELL + ROTATE  under the 200-day SMA: the sell waits in Approvals, with a
//                  paired rotation buy into the #1 ranked leader
//   TRIM           over 30% of the account, > 50% above the 200-day SMA, or far
//                  above the 50-day SMA: sell a third (Approvals)
//   ADD            a winner pulled back to its 20/50-day SMA, under 18% weight:
//                  the add is staged as a buy setup (Approvals)
//   HOLD           healthy: its buffer over the 200-day SMA and its weight
// Every holding is judged, each weighted against ITS OWN book (Phase 54): paper
// positions vs the paper equity, real holdings (LIVE, broker-synced, manual
// Robinhood / other) vs the REAL equity only; the paper bankroll never dilutes a
// real weight. The venue filter chooses which rows (and which equity) are shown.
// Exposes window.SignalDesk.portfolioMatrix: { card(state) }.
(() => {
  const SD = window.SignalDesk;
  const { el, age, money } = SD.ui;

  const TONE = { 'SELL + ROTATE': 'bad', TRIM: 'warn', ADD: 'info', HOLD: 'ok', WAIT: 'wait' };
  const pct = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%` : '—');

  const isPaper = (r) => !r.execution || r.execution === 'PAPER';
  const SHOW = { paper: isPaper, crypto: (r) => !isPaper(r), combined: () => true };
  const where = (r) => (r.external === 'manual' ? `MANUAL · ${r.broker}` : r.external === 'broker' || r.execution === 'LIVE' ? `LIVE · ${r.broker}` : 'PAPER');

  // The weight denominator shown: each row's own book. Combined with only real
  // rows is the real equity (the paper bankroll never dilutes it).
  function equityText(m, rows, state) {
    const venue = SD.venue.current(state);
    if (venue === 'paper') return `paper equity ${money(m.paperEquity)}`;
    if (m.realPending) return 'real equity: waiting for the Coinbase sync (real weights pending, no weight-based trims)';
    if (venue === 'crypto') return `real equity ${money(m.realEquity)}`;
    if (!rows.some(isPaper)) return `combined equity ${money(m.realEquity)} (live + external; no paper holdings)`;
    return `combined equity ${money(m.realEquity + m.paperEquity)} · weights per book: real ${money(m.realEquity)}, paper ${money(m.paperEquity)}`;
  }

  function card(state) {
    const m = state.pilotMatrix;
    const rows = ((m && m.rows) || []).filter(SHOW[SD.venue.current(state)] || SHOW.combined);
    const counts = {};
    for (const r of rows) counts[r.action] = (counts[r.action] || 0) + 1;
    const toApprovals = el('button', { type: 'button', className: 'btn', textContent: 'Open Approvals →' });
    toApprovals.onclick = () => { SD.opportunities.openApprovals(); window.location.hash = '#opportunities'; };
    const acting = rows.some((r) => r.action !== 'HOLD' && r.action !== 'WAIT');
    return el('section', { className: 'pf-card pf-matrix' }, [
      el('div', { className: 'pf-card-head' }, [el('h3', { className: 'pf-h', textContent: 'Portfolio matrix: hold · add · trim · sell + rotate' }),
        el('span', { className: 'pf-sub', textContent: !(m && m.at) ? 'Waiting for the first pipeline pass' : `checked ${age(m.at)} ago · ${equityText(m, rows, state)}` })]),
      el('p', { className: 'pf-sub', textContent: 'Every holding against its 200/50/20-day averages and the trend ranker, once a minute. '
        + 'Sells, trims and the paired rotation / add buys wait in Approvals; nothing executes until you approve it.' }),
      rows.length ? el('div', { className: 'table-wrap' }, el('table', { className: 'data-table pf-table' }, [
        el('thead', {}, el('tr', {}, ['Asset', 'Action', 'Weight', 'vs trend SMA', 'Trend score', 'Why'].map((h, i) => el('th', { textContent: h, className: i >= 2 && i <= 4 ? 'num' : '' })))),
        el('tbody', {}, rows.map((r) => el('tr', {}, [
          el('td', {}, [el('span', { className: 'asset', textContent: SD.oppDetail.displaySymbol({ asset: r.asset, market: r.asset.includes('-') ? 'crypto' : 'stocks' }) }),
            el('span', { className: `pf-venue${r.external === 'manual' ? ' is-manual' : isPaper(r) ? '' : ' is-live'}`, textContent: where(r) })]),
          el('td', {}, el('span', { className: `pf-rec is-${TONE[r.action] || 'info'}`, textContent: r.action })),
          el('td', { className: 'num', textContent: Number.isFinite(r.weight) ? `${(r.weight * 100).toFixed(1)}%` : '—', title: Number.isFinite(r.equity) ? `Share of its book's equity: ${money(r.equity)}` : '' }),
          el('td', { className: `num ${r.buffer200 < 0 ? 'text-short' : 'text-long'}`, textContent: `${pct(r.buffer200)}${r.basis ? ` (${r.basis}d)` : ''}`,
            title: r.basis && r.basis < 200 ? `Newer listing: its ${r.basis}-day SMA stands in for the 200-day` : 'vs the 200-day SMA' }),
          el('td', { className: 'num', textContent: Number.isFinite(r.score) ? String(r.score) : '—' }),
          el('td', { className: 'pf-why', textContent: r.reason }),
        ]))),
      ])) : el('p', { className: 'pf-muted', textContent: 'No stock or crypto holdings to review (options and intraday trades have their own exits).' }),
      el('p', { className: 'pf-sub', textContent: Object.entries(counts).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(' · ') }),
      ...(acting ? [toApprovals] : []),
    ]);
  }

  SD.portfolioMatrix = { card };
})();
