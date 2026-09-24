// Portfolio → Portfolio Pilot: health dashboard + recommendations built from the
// server's attention alerts (DASHBOARD_INTELLIGENCE, one per open position), and
// the Capital Allocator: a deposit becomes fully formed BUY setups (volatility
// stop, 2R target) that the server stages into Opportunities → Approvals;
// nothing executes until they are approved there.
// Exposes window.SignalDesk.portfolioPilot.
(() => {
  const SD = window.SignalDesk;
  const { el, price, money, signed, pnlClass, age } = SD.ui;
  const T = () => SD.portfolioTable;

  // Alert action (server/intelligence/portfolio-monitor.js) -> recommendation.
  const RECS = {
    'Near stop': { label: 'REVIEW', urgency: 'High', tone: 'bad', change: 'Clears when price moves back away from the stop (more than 25% of the stop distance).' },
    'Held past its timeframe': { label: 'REVIEW', urgency: 'Medium', tone: 'warn', change: 'An intraday setup held overnight; closing it or accepting the longer hold resolves this.' },
    'Review taking profits': { label: 'TAKE PROFIT?', urgency: 'Medium', tone: 'warn', change: 'Shown at +10% (options: 75% of the way to T1). T1 closes the paper position automatically.' },
    'Trend check required': { label: 'CHECK', urgency: 'Low', tone: 'info', change: 'Shown after 7 days open; re-check the thesis against the current trend.' },
    'No live price': { label: 'WAIT', urgency: 'Low', tone: 'wait', change: 'Needs a fresh quote; paper stop/target checks resume when prices return.' },
    // Synced broker holdings: SignalDesk's exit rules don't run on them.
    'External holding': { label: 'BROKER', urgency: 'Low', tone: 'info', change: 'Not opened by SignalDesk: no SignalDesk stop, target or alert rules apply. Review it at the broker.' },
    'SignalDesk bracket at Coinbase': { label: 'BROKER', urgency: 'Low', tone: 'info', change: 'Its stop and target are live orders at Coinbase; they close it there. The reconciler records the fill here.' },
    Hold: { label: 'HOLD', urgency: 'Low', tone: 'ok', change: 'Becomes Take profit? at +10%, Near stop within 25% of the stop distance, Trend check after 7 days.' },
  };
  const recOf = (row) => RECS[row.alert ? row.alert.action : 'No live price'] || RECS.Hold;

  // Allocator view state (the request/answer run over the WebSocket).
  const alloc = { amount: '', pending: false, error: '', proposal: null };
  let timer = null;

  function allocationResult(proposal) {
    clearTimeout(timer);
    alloc.pending = false;
    alloc.proposal = proposal && !proposal.error ? proposal : null;
    alloc.error = !proposal ? 'No proposal returned.' : proposal.error || '';
  }

  function kpi(label, value, sub, cls = '') {
    return el('div', { className: 'pf-kpi' }, [el('span', { className: 'pf-kpi-label', textContent: label }),
      el('strong', { className: `pf-kpi-value ${cls}`, textContent: value }), el('span', { className: 'pf-kpi-sub', textContent: sub })]);
  }

  function summary(data) {
    const counts = {};
    for (const r of data.rows) { const l = recOf(r).label; counts[l] = (counts[l] || 0) + 1; }
    const act = data.rows.filter((r) => ['REVIEW', 'TAKE PROFIT?'].includes(recOf(r).label)).length;
    const title = !data.rows.length ? 'No open positions. Cash is ready to deploy.'
      : act ? `Review ${act} position${act === 1 ? '' : 's'}; keep the rest.` : 'Keep current positions. Nothing needs action.';
    return el('section', { className: `pf-card pf-summary${act ? ' is-warn' : ''}` }, [
      el('span', { className: 'pf-summary-icon', textContent: act ? '!' : '✓' }),
      el('div', {}, [el('h3', { className: 'pf-summary-title', textContent: title }),
        el('p', { className: 'pf-sub', textContent: Object.entries(counts).map(([l, n]) => `${n} ${l.toLowerCase()}`).join(' · ') || 'Nothing to review' })]),
    ]);
  }

  function recTable(data, opts) {
    const total = data.rows.reduce((s, r) => s + Math.max(0, r.m.marketValue), 0);
    const generatedAt = opts.state.intelligence && opts.state.intelligence.generatedAt;
    const body = data.rows.map((r) => {
      const rec = recOf(r);
      const tr = el('tr', { className: `row${r.p.id === opts.selectedId ? ' is-selected' : ''}` }, [
        el('td', {}, el('div', { className: 'scan-asset' }, [SD.scannerDetail.badge(r.p.asset), el('div', {}, [el('strong', { textContent: T().display(r.p) }), el('span', { textContent: SD.scannerData.nameOf(r.p.asset) })])])),
        el('td', { className: 'num', textContent: total > 0 ? `${((Math.max(0, r.m.marketValue) / total) * 100).toFixed(0)}%` : '—' }),
        el('td', {}, el('span', { className: `pf-rec is-${rec.tone}`, textContent: rec.label })),
        el('td', { className: 'pf-why', textContent: r.alert ? r.alert.detail : 'No alert yet' }),
        el('td', {}, el('span', { className: `pf-urg is-${rec.urgency.toLowerCase()}`, textContent: rec.urgency })),
        el('td', { className: 'pf-muted', textContent: r.p.execution === 'BROKER' ? `synced ${age(r.p.syncedAt)} ago` : generatedAt ? `${age(generatedAt)} ago` : '—' }),
      ]);
      tr.onclick = () => opts.onSelect(r.p.id);
      return tr;
    });
    return el('section', { className: 'pf-card' }, [
      el('div', { className: 'pf-card-head' }, [el('h3', { className: 'pf-h', textContent: 'Holdings and recommendations' })]),
      el('div', { className: 'table-wrap' }, el('table', { className: 'data-table pf-table' }, [
        el('thead', {}, el('tr', {}, ['Asset', 'Allocation', 'Recommendation', 'Why', 'Urgency', 'Evidence age'].map((h) => el('th', { textContent: h, className: h === 'Allocation' ? 'num' : '' })))),
        el('tbody', {}, body.length ? body : [el('tr', {}, el('td', { colSpan: 6, className: 'pf-empty', textContent: 'No open positions to review.' }))]),
      ])),
    ]);
  }

  function recDetail(row, opts) {
    if (!row) return el('section', { className: 'pf-card pf-rec-detail' }, el('p', { className: 'pf-muted', textContent: 'Select a holding to see its recommendation.' }));
    const { p, m, alert } = row;
    const rec = recOf(row);
    const box = (label, value, cls = '') => el('div', { className: 'pf-box' }, [el('span', { textContent: label }), el('strong', { className: cls, textContent: value })]);
    const atBroker = p.execution === 'LIVE' || p.execution === 'BROKER';
    const close = el('button', { type: 'button', className: 'btn', textContent: 'Close position', disabled: atBroker || !m.live || !opts.online, title: atBroker ? 'Close at broker' : '' });
    close.onclick = () => opts.onClose(p, m);
    const holdings = el('button', { type: 'button', className: 'btn btn-solid', textContent: 'View in Holdings' });
    holdings.onclick = () => opts.onHoldings(p.id);
    return el('section', { className: 'pf-card pf-rec-detail' }, [
      el('div', { className: 'pf-card-head' }, [SD.scannerDetail.badge(p.asset, true), el('div', { className: 'opp-title' }, [
        el('h3', { className: 'pf-h', textContent: `${T().display(p)} recommendation` }), el('span', { className: 'pf-sub', textContent: SD.scannerData.nameOf(p.asset) })]),
      el('span', { className: `pf-rec is-${rec.tone}`, textContent: rec.label })]),
      el('div', { className: `pf-callout is-${rec.tone}` }, [el('strong', { textContent: alert ? alert.action : 'No live price' }), el('span', { textContent: alert ? alert.detail : 'Waiting for the next scan.' })]),
      el('div', { className: 'pf-boxes' }, [
        box('Cost basis', money(m.cost)),
        box('Unrealized (gross)', m.gross === null ? '—' : signed(m.gross, money), m.gross === null ? '' : pnlClass(m.gross)),
        box('Est. exit cost', m.fees === null ? '—' : money(m.fees)),
        box('Stop / T1', `${price(p.invalidation, p)} / ${p.targets && p.targets[0] ? price(p.targets[0].price, p) : '—'}`),
      ]),
      el('h4', { className: 'pf-h4', textContent: 'What would change it' }),
      el('p', { className: 'pf-text', textContent: rec.change }),
      el('div', { className: 'pf-rec-actions' }, [holdings, close]),
      el('p', { className: 'pf-fine', textContent: 'Recommendation only. Closing is manual and paper-only here; live and synced broker positions are closed at the broker.' }),
    ]);
  }

  // What the server did with each buy: staged (size, stop, target) or why not.
  function setupCell(pr, r) {
    const s = (pr.setups || []).find((x) => x.asset === r.asset);
    if (!s) return el('td', { className: 'pf-muted', textContent: r.recommendedBuyAmount > 0 ? '—' : 'Nothing to buy' });
    if (!s.staged) return el('td', { className: 'pf-muted', textContent: `Not staged: ${s.reason}` });
    const p = { market: r.asset.includes('-') ? 'crypto' : 'stocks', entryPrice: s.entryPrice };
    return el('td', { className: 'text-long', textContent: `Staged ${money(s.notional)} · stop ${price(s.invalidation, p)} · no fixed target${s.cappedByAmount ? '' : ' (risk-limited)'}` });
  }

  function openApprovals(opts) {
    const b = el('button', { type: 'button', className: 'btn btn-solid', textContent: 'Open Approvals →' });
    b.onclick = () => { SD.opportunities.openApprovals(); window.location.hash = '#opportunities'; opts.rerender(); };
    return b;
  }

  function allocator(opts) {
    const input = el('input', { type: 'number', id: 'pf-alloc-amount', className: 'scan-input pf-alloc-input', min: '1', step: 'any', inputMode: 'decimal', placeholder: 'Deposit Amount (e.g., $1000)', value: alloc.amount });
    input.oninput = () => { alloc.amount = input.value; };
    const go = el('button', { type: 'submit', className: 'btn btn-solid', textContent: alloc.pending ? 'Generating…' : 'Generate buy setups', disabled: alloc.pending });
    const form = el('form', { className: 'pf-alloc-form', noValidate: true }, [input, go]);
    form.onsubmit = (e) => {
      e.preventDefault();
      const amount = Number(alloc.amount);
      if (!Number.isFinite(amount) || amount <= 0) { alloc.error = 'Enter a deposit amount above $0.'; return opts.rerender(); }
      if (!opts.online) { alloc.error = 'Offline: cannot reach the server.'; return opts.rerender(); }
      Object.assign(alloc, { pending: true, error: '' });
      opts.send({ type: 'CALCULATE_ALLOCATION', amount });
      clearTimeout(timer);
      timer = setTimeout(() => { allocationResult({ error: 'No response from the server. Try again.' }); opts.rerender(); }, 30000);
      return opts.rerender();
    };
    const pr = alloc.proposal;
    const fmtPct = (x) => `${(x * 100).toFixed(1)}%`;
    return el('section', { className: 'pf-card pf-alloc' }, [
      el('div', { className: 'pf-card-head' }, [el('h3', { className: 'pf-h', textContent: 'Capital allocator — What to buy' })]),
      el('p', { className: 'pf-sub', textContent: 'Buy-only rebalance of a deposit toward the pilot target model (BTC 40% · ETH 30% · SPY 30%), at live prices. '
        + 'Each buy becomes a setup with a volatility stop (no fixed take-profit: core holdings exit at the stop or an approved Pilot sell/trim), sized by the risk engine (never above its allocation) and sent to Opportunities → Approvals. '
        + 'Generating again replaces Pilot buys still waiting.' }),
      form,
      ...(alloc.error ? [el('p', { className: 'pf-error', textContent: alloc.error })] : []),
      ...(pr ? [
        el('p', { className: 'pf-text' }, ['Pilot holdings ', el('strong', { textContent: money(pr.portfolioValue) }), ' + deposit ', el('strong', { textContent: money(pr.deposit) }),
          ' → ', el('strong', { textContent: money(pr.newTotal) }), pr.unallocated > 0 ? ` · ${money(pr.unallocated)} left unallocated` : '']),
        el('table', { className: 'data-table pf-table pf-alloc-table' }, [
          el('thead', {}, el('tr', {}, ['Asset', 'Current', 'Target', 'Buy', '≈ Units', 'Setup'].map((h, i) => el('th', { textContent: h, className: i && i < 5 ? 'num' : '' })))),
          el('tbody', {}, pr.recommendations.map((r) => el('tr', {}, [
            el('td', {}, el('span', { className: 'asset', textContent: r.asset })),
            el('td', { className: 'num', textContent: fmtPct(r.currentWeight) }),
            el('td', { className: 'num', textContent: fmtPct(r.targetWeight) }),
            el('td', { className: `num ${r.recommendedBuyAmount > 0 ? 'text-long' : ''}`, textContent: money(r.recommendedBuyAmount) }),
            el('td', { className: 'num', textContent: r.estimatedUnits > 0 ? r.estimatedUnits.toFixed(r.estimatedUnits < 1 ? 6 : 4) : '—' }),
            setupCell(pr, r),
          ]))),
        ]),
        ...((pr.setups || []).some((x) => x.staged) ? [openApprovals(opts)] : []),
        ...(pr.notes && pr.notes.length ? [el('ul', { className: 'pf-notes' }, pr.notes.map((n) => el('li', { textContent: n })))] : []),
      ] : []),
    ]);
  }

  // opts: { state, venueLabel, selectedId, onSelect(id), onClose(p, m), onHoldings(id), send(msg), online, rerender() }
  function pilotView(data, opts) {
    const t = data.totals;
    const values = data.rows.map((r) => Math.max(0, r.m.marketValue));
    const total = values.reduce((s, v) => s + v, 0);
    const topIdx = values.indexOf(Math.max(...values, 0));
    const selected = data.rows.find((r) => r.p.id === opts.selectedId) || data.rows[0] || null;
    return el('div', { className: 'pf-pilot' }, [
      summary(data),
      el('div', { className: 'pf-kpis' }, [
        kpi('Portfolio value', money(t.accountValue), `${opts.venueLabel} · ${data.rows.length} position${data.rows.length === 1 ? '' : 's'}`),
        // Isolated per venue: paper cash never inflates live buying power (and vice versa).
        kpi('Spendable cash', `${t.cash < 0 ? '−' : ''}${money(Math.abs(t.cash))}`, t.currentBankroll > 0 ? `Bankroll ${money(t.currentBankroll)} (${t.bankrollLabel})` : 'No bankroll for this venue yet', t.cash < 0 ? 'pnl-neg' : ''),
        kpi('Concentration', total > 0 ? `${((values[topIdx] / total) * 100).toFixed(0)}%` : '—', total > 0 ? `Top holding (${data.rows[topIdx].p.asset.replace('-USD', '')})` : 'No holdings'),
        kpi('Estimated exit cost', money(t.exitFees), 'If every position shown closed now'),
        kpi('Data coverage', `${t.fresh} of ${data.rows.length} fresh`, 'Positions with a live price'),
      ]),
      el('div', { className: 'pf-pilot-grid' }, [recTable(data, opts), recDetail(selected, opts)]),
      allocator(opts),
    ]);
  }

  SD.portfolioPilot = { pilotView, allocationResult, focusId: 'pf-alloc-amount' };
})();
