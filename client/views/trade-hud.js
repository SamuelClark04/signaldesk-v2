// Active Trade HUD: a floating panel over the Setups chart (top right) when the
// charted symbol has open position(s). Live unrealized P&L re-marks on every
// price update, with the same maths as the Portfolio tab (portfolio-metrics.mark).
// Manual exit: PAPER positions close at the live price via CLOSE_POSITION (the
// server re-checks and books it like any exit). LIVE and adopted positions are
// closed at the broker: their exits are broker orders (or the user's own sale),
// so the button is disabled there, exactly as on the Portfolio tab.
// Real option contracts lead with the contract itself: its live premium (the
// real bid, or the modelled value when no fresh quote exists) and the option's
// own P&L; the underlying's price follows for context.
// Exposes window.SignalDesk.tradeHud.hud(o, ctx).
(() => {
  const SD = window.SignalDesk;
  const { el, money, price, size, signed, pnlClass } = SD.ui;

  // 'QQQ 761C · 30 Oct' from the position's real contract.
  function contractName(p) {
    const od = p.optionsData;
    const exp = new Date(`${od.expiration}T12:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return `${od.underlying || p.asset} ${od.strike}${od.type === 'put' ? 'P' : 'C'} · ${exp}`;
  }

  // Premium + P&L block for a real option contract (m from portfolioMetrics.mark).
  function optionBlock(p, m) {
    const od = p.optionsData;
    const n = p.positionSize;
    const head = el('div', { className: 'hud-contract' }, [el('strong', { textContent: contractName(p) }),
      el('span', { className: 'hud-muted', textContent: `${n} contract${n === 1 ? '' : 's'}` })]);
    head.title = od.contract;
    if (m.optionValue === undefined) {
      return [head, el('div', { className: 'hud-pnl hud-muted', textContent: 'No option price (no fresh quote or live underlying)' })];
    }
    const basis = m.optionBasis === 'bid' ? 'live bid' : 'modelled';
    const when = m.optionAt ? new Date(m.optionAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const premium = el('div', { className: 'hud-premium' }, [
      el('span', { className: 'hud-muted', textContent: 'Premium ' }),
      el('strong', { textContent: m.optionValue.toFixed(2) }),
      el('span', { className: `hud-basis is-${m.optionBasis}`, textContent: basis }),
      el('span', { className: 'hud-muted', textContent: ` paid ${od.debit}` }),
    ]);
    premium.title = m.optionBasis === 'bid' ? `Real bid (${od.feed || 'indicative'} feed) at ${when}` : 'No fresh quote: Black-Scholes value at the live underlying price, anchored to the entry quote';
    const pnl = el('div', { className: `hud-pnl ${pnlClass(m.gross)}` }, [el('strong', { textContent: signed(m.gross, money) }),
      el('span', { textContent: m.pctGross === null ? '' : ` ${m.pctGross >= 0 ? '+' : '−'}${Math.abs(m.pctGross * 100).toFixed(2)}%` })]);
    return [head, premium, pnl];
  }

  function underlyingLine(p, m) {
    if (!(m.price > 0)) return el('div', { className: 'hud-muted', textContent: 'Underlying: no live price' });
    const mv = m.underlyingMove;
    return el('div', { className: 'hud-muted hud-underlying', textContent: `Underlying: ${price(m.price, { market: 'stocks', entryPrice: m.price })}`
      + `${Number.isFinite(mv) ? ` (${mv >= 0 ? '+' : '−'}${Math.abs(mv * 100).toFixed(2)}% since entry at ${price(p.fillPrice, { market: 'stocks', entryPrice: p.fillPrice })})` : ''}` });
  }

  function row(p, livePrice, ctx) {
    const m = SD.portfolioMetrics.mark(p, livePrice);
    const realOption = p.market === 'options' && p.optionsData && p.optionsData.contract;
    const venue = p.adopted ? 'ADOPTED' : p.execution === 'LIVE' ? `LIVE · ${p.broker}` : 'PAPER';
    const t1 = p.targets && p.targets[0] && p.targets[0].price;
    const pnl = m.gross !== null && m.gross !== undefined
      ? el('div', { className: `hud-pnl ${pnlClass(m.gross)}` }, [el('strong', { textContent: signed(m.gross, money) }),
        el('span', { textContent: m.pctGross === null ? '' : ` ${m.pctGross >= 0 ? '+' : '−'}${Math.abs(m.pctGross * 100).toFixed(2)}%` })])
      : el('div', { className: 'hud-pnl hud-muted', textContent: !m.live ? 'No live price' : m.underlyingMove !== undefined
        ? `Underlying ${m.underlyingMove >= 0 ? '+' : '−'}${Math.abs(m.underlyingMove * 100).toFixed(2)}%` : '—' });

    const atBroker = p.execution === 'LIVE' || p.execution === 'BROKER';
    const closing = ctx.closing.has(p.id);
    const exit = el('button', {
      type: 'button',
      className: `btn hud-exit${atBroker ? '' : ' is-armed'}`,
      textContent: atBroker ? `Close at ${p.broker}` : closing ? 'Closing…' : 'Manual Exit / Close Position',
      disabled: atBroker || closing || !m.live || !ctx.online,
      title: atBroker ? (p.adopted ? 'Adopted holding: sell it at the broker (SignalDesk places no orders for it)' : 'LIVE position: its exits are orders at the broker; close it there')
        : !m.live ? 'No live price: cannot close at a known price' : !ctx.online ? 'Offline' : 'Close this paper position now at the live price',
    });
    exit.onclick = () => ctx.onClosePosition(p, m);
    return el('div', { className: 'hud-pos' }, [
      el('div', { className: 'hud-line' }, [el('span', { className: `hud-venue${p.execution === 'LIVE' ? ' is-live' : ''}`, textContent: venue }),
        el('span', { textContent: realOption ? `${p.direction.toUpperCase()} CALL` : `${p.direction.toUpperCase()} ${size(p)} @ ${price(p.fillPrice, p)}` })]),
      ...(realOption ? [...optionBlock(p, m), underlyingLine(p, m)] : [pnl]),
      ...(p.market === 'options' && !realOption ? [el('div', { className: 'hud-muted', textContent: 'Simulated spread from the old options strategy: '
        + 'no listed contract, so no live premium. Close it to retire it.' })] : []),
      el('div', { className: 'hud-levels' }, [el('span', { className: 'text-short', textContent: `${realOption ? `${p.asset} stop` : 'Stop'} ${price(p.invalidation, p)}` }),
        el('span', { className: 'text-long', textContent: `T1 ${t1 ? price(t1, p) : '—'}` }),
        ...(m.net !== null && m.net !== undefined ? [el('span', { className: 'hud-muted', textContent: `after fees ${signed(m.net, money)}` })] : [])]),
      exit,
    ]);
  }

  // ctx: { state, livePrice, online, closing:Set, onClosePosition(p, m) }
  function hud(o, ctx) {
    const positions = ((ctx.state && ctx.state.positions) || []).filter((p) => p.asset === o.asset);
    if (!positions.length) return null;
    return el('aside', { className: 'trade-hud', ariaLabel: 'Active trade' }, [
      el('div', { className: 'hud-title', textContent: `Active trade${positions.length > 1 ? `s (${positions.length})` : ''}` }),
      ...positions.map((p) => row(p, ctx.livePrice, ctx)),
    ]);
  }

  SD.tradeHud = { hud };
})();
