// Net-first P&L (Phase 63): the TRUE net (what closing now would really make, after the
// entry fee, the exit fee and, for a live Coinbase sell, the gap down to the best bid)
// is the hero figure; the gross move is the secondary line with the friction that
// separates the two:
//   −$0.21 (−2.56% net)
//   Gross (at bid): −$0.04 (−0.52%) · Fees: −$0.17 (Entry −$0.07 + Exit fee −$0.10)
//   Break-even sell price: 0.002155 (+2.08% from entry)
// Phase 65: computed HERE from one tick (the last price in state.prices and the best bid in
// state.bids, both refreshed together by POSITION_MARKS every 5 s) with the quote's fixed
// inputs (size, fill, entry fee, exit fee rate), so Live price, Position value, Gross, the
// exit fee, the cashout and the net can never come from different snapshots:
//   gross = (sell - fill) x size · exit fee = sell x size x rate · net = gross - entry - exit
// The break-even is the quote's fixed sell price. Options: the server quote as is.
// Exposes window.SignalDesk.netPnl: { figures(p, m), live(p, m), hero(p, m, opts), breakEven(p), cashoutMath(p, m), hurdle(h) }.
(() => {
  const SD = window.SignalDesk;
  const { el, money, price, signed, pnlClass } = SD.ui;

  const pct = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(2)}%` : null);
  const nw = (text, cls = '') => el('span', { className: `no-wrap ${cls}`.trim(), textContent: text });

  const bidOf = (asset) => { const b = SD.app && SD.app.state && SD.app.state.bids; return b && b[asset] > 0 ? b[asset] : null; };

  // A stock / crypto position re-marked on the client's current tick (null: not re-markable).
  function live(p, m) {
    const q = p.exitQuote;
    if (!q || p.market === 'options' || !(q.exitRate >= 0) || !(p.positionSize > 0) || !Number.isFinite(q.entryFee)) return null;
    const last = m && m.price > 0 ? m.price : q.underlying;
    const atBid = q.sellBasis === 'best bid';
    const sell = atBid ? bidOf(p.asset) || q.bid : last;
    if (!(sell > 0)) return null;
    const size = p.positionSize;
    const sign = p.direction === 'short' ? -1 : 1;
    const cost = p.fillPrice * size;
    const gross = (sell - p.fillPrice) * size * sign;
    const exitFee = sell * size * q.exitRate;
    const net = gross - q.entryFee - exitFee;
    return { net, netPct: cost > 0 ? net / cost : null, gross, grossPct: cost > 0 ? gross / cost : null, friction: q.entryFee + exitFee, entryFee: q.entryFee, exitCost: exitFee,
      entryActual: !!q.entryFeeActual, atBid, sell, last, exitFee, cashout: sign > 0 ? sell * size - exitFee : null };
  }

  // { net, netPct, gross, grossPct, friction, entryFee, exitCost, entryActual, atBid?, sell?, cashout? } or null.
  function figures(p, m) {
    const q = p.exitQuote;
    const now = live(p, m);
    if (now) return now;
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
    // Phase 65: Gross (at the sell price) + Fees = Net, to the cent; the exit fee is Coinbase's fee alone.
    const split = f.entryFee === null ? (f.friction === null ? [] : [nw(`Fees: ${signed(-f.friction, money)}`)])
      : [nw(`Fees: ${signed(-f.friction, money)}`), ' ', nw(`(Entry${f.entryActual ? ' (actual)' : ''} ${signed(-f.entryFee, money)} + Exit fee ${signed(-f.exitCost, money)})`)];
    const sub = el('div', { className: 'np-sub' }, [nw(`Gross${f.atBid ? ' (at bid)' : ''}: ${signed(f.gross, money)}${f.grossPct === null || f.grossPct === undefined ? '' : ` (${pct(f.grossPct)})`}`),
      ...(split.length ? [' · ', ...split] : [])]);
    sub.title = f.atBid ? `Gross at the best bid ${price(f.sell, p)} (a market sell fills there; last trade ${price(f.last, p)}). Fees: the entry fee + Coinbase's taker fee on the sale.`
      : 'Gross at the last price (no fresh bid). Fees: the entry fee + the modelled exit fee.';
    const be = opts.noBreakEven ? null : breakEven(p);
    return el('div', { className: `np${opts.compact ? ' is-compact' : ''}` }, [main, sub, ...(be ? [el('div', { className: 'np-be' }, [nw(be)])] : [])]);
  }

  // 'Break-even sell price: 0.1492 (+1.72% from entry)' (fixed: the bid at which the net is $0.00) or null.
  function breakEven(p) {
    const q = p.exitQuote;
    if (!q || !(q.breakEven > 0)) return null;
    return `Break-even sell price: ${price(q.breakEven, p)} (${pct(q.breakEvenPct)} from entry)`;
  }

  // The cashout arithmetic for [Close at Coinbase]: 'Est. sell at best bid 0.2292 ($25.42) − Coinbase fee (~$0.33) = $25.09 cashout'.
  function cashoutMath(p, m) {
    const f = live(p, m);
    const q = p.exitQuote;
    if (f && Number.isFinite(f.cashout)) {
      const thin = q && q.thinBid ? ` · the best bid holds only ${q.bidQty} (a market sell may fill lower)` : ''; // Phase 66
      return `Est. sell at ${f.atBid ? 'best bid' : 'last price'} ${price(f.sell, p)} (${money(f.sell * p.positionSize)})${f.atBid ? '' : ' (no fresh bid)'} − Coinbase fee (~${money(f.exitFee)}) = ${money(f.cashout)} cashout${thin}`;
    }
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

  SD.netPnl = { figures, live, hero, breakEven, cashoutMath, hurdle };
})();
