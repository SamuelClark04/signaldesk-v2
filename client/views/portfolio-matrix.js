// Portfolio → Pilot: the 4-action matrix (server/strategies/pilot-matrix.js,
// PILOT_MATRIX once per pipeline pass). One verdict per open holding:
//   SELL + ROTATE  under the 200-day SMA: the sell waits in Approvals, with a
//                  paired rotation buy into the #1 ranked leader
//   TRIM           over 30% of the account, > 50% above the 200-day SMA, or far
//                  above the 50-day SMA: sell a third (Approvals)
//   ADD            a winner pulled back to its 20/50-day SMA, under 18% weight:
//                  the add is staged as a buy setup (Approvals)
//   HOLD           healthy: its buffer over the 200-day SMA and its weight
// Exposes window.SignalDesk.portfolioMatrix: { card(state) }.
(() => {
  const SD = window.SignalDesk;
  const { el, age, money } = SD.ui;

  const TONE = { 'SELL + ROTATE': 'bad', TRIM: 'warn', ADD: 'info', HOLD: 'ok', WAIT: 'wait' };
  const pct = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%` : '—');

  function card(state) {
    const m = state.pilotMatrix;
    const rows = (m && m.rows) || [];
    const counts = {};
    for (const r of rows) counts[r.action] = (counts[r.action] || 0) + 1;
    const toApprovals = el('button', { type: 'button', className: 'btn', textContent: 'Open Approvals →' });
    toApprovals.onclick = () => { SD.opportunities.openApprovals(); window.location.hash = '#opportunities'; };
    const acting = rows.some((r) => r.action !== 'HOLD' && r.action !== 'WAIT');
    return el('section', { className: 'pf-card pf-matrix' }, [
      el('div', { className: 'pf-card-head' }, [el('h3', { className: 'pf-h', textContent: 'Portfolio matrix: hold · add · trim · sell + rotate' }),
        el('span', { className: 'pf-sub', textContent: m && m.at ? `checked ${age(m.at)} ago · equity ${money(m.equity)}` : 'Waiting for the first pipeline pass' })]),
      el('p', { className: 'pf-sub', textContent: 'Every holding against its 200/50/20-day averages and the trend ranker, once a minute. '
        + 'Sells, trims and the paired rotation / add buys wait in Approvals; nothing executes until you approve it.' }),
      rows.length ? el('div', { className: 'table-wrap' }, el('table', { className: 'data-table pf-table' }, [
        el('thead', {}, el('tr', {}, ['Asset', 'Action', 'Weight', 'vs 200d SMA', 'Trend score', 'Why'].map((h, i) => el('th', { textContent: h, className: i >= 2 && i <= 4 ? 'num' : '' })))),
        el('tbody', {}, rows.map((r) => el('tr', {}, [
          el('td', { className: 'asset', textContent: SD.oppDetail.displaySymbol({ asset: r.asset, market: r.asset.includes('-') ? 'crypto' : 'stocks' }) }),
          el('td', {}, el('span', { className: `pf-rec is-${TONE[r.action] || 'info'}`, textContent: r.action })),
          el('td', { className: 'num', textContent: Number.isFinite(r.weight) ? `${(r.weight * 100).toFixed(1)}%` : 'broker', title: Number.isFinite(r.weight) ? '' : 'LIVE / adopted holding: no paper weight' }),
          el('td', { className: `num ${r.buffer200 < 0 ? 'text-short' : 'text-long'}`, textContent: pct(r.buffer200) }),
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
