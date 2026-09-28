// Journal > Strategy Scorecard (Phase 77): closed trades by strategy (lib/scorecard.js does the math) with an
// All / Live / Paper filter, and the book's risk right now (PORTFOLIO_RISK: open risk vs the ceiling, bullish /
// bearish equity trades vs the direction limit). Exposes window.SignalDesk.journalScorecard.
(() => {
  const SD = window.SignalDesk;
  const { $, el, money, signed, pnlClass } = SD.ui;
  const FILTERS = [['all', 'All'], ['LIVE', 'Live'], ['PAPER', 'Paper']];
  let filter = 'all';
  let journal = [];

  const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
  const rText = (x) => (x === null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`);
  const pfText = (r) => (!r.trades ? '—' : r.profitFactor === null ? (r.wins ? '∞ (no losses)' : '—') : r.profitFactor.toFixed(2));
  const cell = (text, className = 'num', title = '') => el('td', { className, textContent: text, title });

  function renderFilter() {
    $('scorecard-filter').replaceChildren(...FILTERS.map(([k, label]) => {
      const b = el('button', { type: 'button', className: `pf-venue-seg${k === filter ? ' is-active' : ''}`, textContent: label });
      b.setAttribute('aria-pressed', String(k === filter));
      b.onclick = () => { filter = k; render(); };
      return b;
    }));
  }

  function row(r, total = false) {
    return el('tr', { className: total ? 'sc-total' : '' }, [
      el('td', {}, [el('strong', { textContent: total ? 'All strategies' : r.label }), ...(r.live && filter === 'all' ? [el('span', { className: 'sub', textContent: ` ${r.live} live` })] : [])]),
      cell(String(r.trades)),
      cell(pct(r.winRate), 'num', r.trades ? `${r.wins} of ${r.trades} trades netted more than $0` : ''),
      cell(rText(r.avgR), `num ${pnlClass(r.avgR || 0)}`, 'Average net R per trade (net P/L ÷ the trade\'s original 1R): the expectancy'),
      cell(pfText(r), `num ${r.profitFactor !== null && r.profitFactor < 1 ? 'pnl-neg' : ''}`, r.trades ? `Gross wins ${money(r.grossWin)} ÷ gross losses ${money(r.grossLoss)} (after fees). Over 1 = the strategy made money.` : ''),
      cell(signed(r.net, money), `num ${pnlClass(r.net)}`),
    ]);
  }

  function render(trades) {
    if (trades) journal = trades;
    renderFilter();
    const sc = SD.scorecard.build(journal, filter);
    $('scorecard-body').replaceChildren(...sc.rows.map((r) => row(r)), ...(sc.rows.length > 1 ? [row(sc.total, true)] : []));
    $('scorecard-empty').hidden = sc.rows.length > 0;
    $('scorecard-empty').textContent = filter === 'all' ? 'No closed trades yet.' : `No closed ${filter === 'LIVE' ? 'live' : 'paper'} trades yet.`;
    const few = sc.rows.filter((r) => r.trades > 0 && r.trades < 30).map((r) => r.label);
    $('scorecard-note').textContent = `One row per strategy; a T1 partial and its runner count as one trade. Net of fees.${few.length ? ` Under 30 trades (${few.join(', ')}): too few to judge an edge yet.` : ''}`;
  }

  // PORTFOLIO_RISK: one line per book.
  function renderRisk(r) {
    const box = $('scorecard-risk');
    if (!r || !r.books) { box.replaceChildren(); return; }
    box.replaceChildren(...r.books.map((b) => {
      const over = b.cap !== null && b.risk > b.cap + 1e-9;
      const bits = [`${money(b.risk)} at risk on ${b.open} open trade${b.open === 1 ? '' : 's'}`];
      if (b.pct !== null) bits.push(`${(b.pct * 100).toFixed(1)}% of ${money(b.bankroll)} (ceiling ${(r.maxOpenRiskPct * 100).toFixed(1)}% = ${money(b.cap)})`);
      if (b.bullish !== undefined) bits.push(`${b.bullish} bullish / ${b.bearish} bearish equity trades (max ${r.maxEquityPerDirection} each)`);
      const full = over || (b.bullish >= r.maxEquityPerDirection && b.bearish >= r.maxEquityPerDirection);
      return el('div', { className: `sc-risk${over ? ' is-over' : ''}`, title: over ? 'Over the ceiling: new setups in this book are held back until open risk comes down' : '' },
        [el('strong', { textContent: `${b.label}: ` }), bits.join(' · '), ...(over ? [el('span', { className: 'sc-flag', textContent: ' · new setups paused' })] : full ? [el('span', { className: 'sc-flag', textContent: ' · both directions full' })] : [])]);
    }));
  }

  SD.journalScorecard = { render, renderRisk };
})();
