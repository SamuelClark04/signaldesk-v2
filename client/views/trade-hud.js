// Active Trade HUD: a floating panel over the Setups chart (top right) when the
// charted symbol has open position(s). Live unrealized P&L re-marks on every
// price update, with the same maths as the Portfolio tab (portfolio-metrics.mark).
// Manual exit: PAPER positions close at the live price via CLOSE_POSITION (the
// server re-checks and books it like any exit). LIVE and adopted positions are
// closed at the broker: their exits are broker orders (or the user's own sale),
// so the button is disabled there, exactly as on the Portfolio tab.
// Exposes window.SignalDesk.tradeHud.hud(o, ctx).
(() => {
  const SD = window.SignalDesk;
  const { el, money, price, size, signed, pnlClass } = SD.ui;

  function row(p, livePrice, ctx) {
    const m = SD.portfolioMetrics.mark(p, livePrice);
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
        el('span', { textContent: `${p.direction.toUpperCase()} ${size(p)} @ ${price(p.fillPrice, p)}` })]),
      pnl,
      el('div', { className: 'hud-levels' }, [el('span', { className: 'text-short', textContent: `Stop ${price(p.invalidation, p)}` }),
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
