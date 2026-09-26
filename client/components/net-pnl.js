// Net-first P&L (Phase 63): the TRUE net (what closing now would really make, after the
// entry fee, the exit fee and, for a live Coinbase sell, the gap down to the best bid)
// is the hero figure; the gross move is the secondary line with the friction that
// separates the two:
//   −$0.23 (−0.91% net)
//   Gross: +$0.43 (+1.72%) · Total friction: −$0.66 (Entry fee −$0.33 + Est. exit −$0.33)
//   Break-even: 0.2298 (+0.92% from entry)
// Figures come from the server's exit quote (p.exitQuote, every 5 s: exit-quote.js), the
// same numbers a close books; without one, portfolioMetrics.mark's gross / net.
// Exposes window.SignalDesk.netPnl: { figures(p, m), hero(p, m, opts), breakEven(p), cashoutMath(p), hurdle(h) }.
(() => {
  const SD = window.SignalDesk;
  const { el, money, price, signed, pnlClass } = SD.ui;

  const pct = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(2)}%` : null);
  const nw = (text, cls = '') => el('span', { className: `no-wrap ${cls}`.trim(), textContent: text });

  // { net, netPct, gross, grossPct, friction, entryFee, exitCost, entryActual } or null.
  function figures(p, m) {
    const q = p.exitQuote;
    if (q && Number.isFinite(q.net)) {
      const entryFee = Number.isFinite(q.entryFee) ? q.entryFee : null;
      return { net: q.net, netPct: q.netPct ?? null, gross: q.gross, grossPct: q.grossPct ?? (m && m.pctGross), friction: q.fees,
        entryFee, exitCost: entryFee === null ? null : q.exitCost ?? q.fees - entryFee, entryActual: !!q.entryFeeActual };
    }
    if (!m || m.gross === null || m.gross === undefined) return null;
    const cost = m.cost > 0 ? m.cost : null;
    return { net: m.net ?? null, netPct: m.net !== null && m.net !== undefined && cost ? m.net / cost : null, gross: m.gross, grossPct: m.pctGross,
      friction: m.fees ?? null, entryFee: null, exitCost: null, entryActual: false };
  }

  // opts.compact: the chart panel (smaller hero, one friction line).
  function hero(p, m, opts = {}) {
    const f = figures(p, m);
    if (!f) return el('div', { className: 'np np-none', textContent: m && !m.live ? 'No live price' : '—' });
    const main = f.net === null
      ? el('div', { className: `np-hero ${pnlClass(f.gross)}` }, [nw(signed(f.gross, money)), nw(` (${pct(f.grossPct) || '—'} gross; fees unknown)`, 'np-unit')])
      : el('div', { className: `np-hero ${pnlClass(f.net)}` }, [nw(signed(f.net, money)), ' ', nw(`(${pct(f.netPct) || '—'} net)`, 'np-unit')]);
    const split = f.entryFee === null ? (f.friction === null ? [] : [nw(`Total friction: ${signed(-f.friction, money)}`)])
      : [nw(`Total friction: ${signed(-f.friction, money)}`), ' ', nw(`(Entry fee${f.entryActual ? ' (actual)' : ''} ${signed(-f.entryFee, money)} + Est. exit ${signed(-f.exitCost, money)})`)];
    const sub = el('div', { className: 'np-sub' }, [nw(`Gross: ${signed(f.gross, money)}${f.grossPct === null || f.grossPct === undefined ? '' : ` (${pct(f.grossPct)})`}`),
      ...(split.length ? [' · ', ...split] : [])]);
    sub.title = 'Gross: the move at the last trade. Friction: the entry fee plus what exiting now costs (Coinbase taker fee and, for a live sell, the gap down to the best bid).';
    const be = opts.noBreakEven ? null : breakEven(p);
    return el('div', { className: `np${opts.compact ? ' is-compact' : ''}` }, [main, sub, ...(be ? [el('div', { className: 'np-be' }, [nw(be)])] : [])]);
  }

  // 'Break-even: 0.2298 (+0.92% from entry)' or null.
  function breakEven(p) {
    const q = p.exitQuote;
    if (!q || !(q.breakEven > 0)) return null;
    return `Break-even: ${price(q.breakEven, p)} (${pct(q.breakEvenPct)} from entry)`;
  }

  // The cashout arithmetic for [Close at Coinbase]: 'Est. sell at best bid ($25.42) − Coinbase fee (~$0.33) = $25.09 cashout'.
  function cashoutMath(p) {
    const q = p.exitQuote;
    if (!q || !Number.isFinite(q.cashout)) return null;
    const at = q.sellBasis === 'best bid' ? `best bid ${price(q.sellPrice, p)}` : `last price ${price(q.sellPrice || q.underlying, p)} (no fresh bid)`;
    return `Est. sell at ${at} (${money((q.sellPrice || q.underlying) * p.positionSize)}) − Coinbase fee (~${money(q.exitFee)}) = ${money(q.cashout)} cashout`;
  }

  // Upfront fee hurdle (ticket, staged approvals): 'Est. Round-Trip Fees: $0.66 (2.6% price hurdle to
  // break even)' + a yellow notice above 2.5%. h: the server's feeHurdle (risk/break-even.js).
  function hurdle(h, cls = 'np-hurdle') {
    if (!h || !Number.isFinite(h.fees)) return [];
    const line = el('p', { className: cls, textContent: `Est. Round-Trip Fees: ${money(h.fees)} (${(h.hurdlePct * 100).toFixed(2)}% price hurdle to break even)` });
    line.title = `Entry fee ${money(h.entryFee)} + exit fee ${money(h.exitFee)}${h.spreadCost > 0 ? ` + ${money(h.spreadCost)} bid/ask spread` : ''} · ${h.basis}`;
    return [line, ...(h.wide ? [el('p', { className: `${cls} is-warn`, textContent: `Wide spread / high fee drag: requires +${(h.hurdlePct * 100).toFixed(2)}% gain to reach break-even` })] : [])];
  }

  SD.netPnl = { figures, hero, breakEven, cashoutMath, hurdle };
})();
