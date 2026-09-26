// Closed Trades view (Journal tab). Renders the server's snapshot as-is.
// Exposes window.SignalDesk.journal.
(() => {
  const SD = window.SignalDesk;
  const { $, el, td, price, money, signed, pnlClass, clock, dirCell, assetCell, setTable } = SD.ui;

  const EXIT_LABELS = { STOP_LOSS: 'Stop loss', TAKE_PROFIT: 'Take profit', TAKE_PROFIT_T1: 'T1 partial (runner open)', BROKER_EXIT: 'Broker exit' };
  const LEG_LABELS = { take_profit: 'Broker take profit', stop_loss: 'Broker stop loss' };

  // Execution audit (Phase 63): a live close's expected cashout (right before the sell: best
  // bid x qty less the fee; bracket exits: the stop / target level) vs the real fill.
  function audit(t) {
    const a = t.cashoutAudit;
    if (!a || !Number.isFinite(a.expected) || !Number.isFinite(a.actual)) return null;
    const why = Math.abs(a.variance) < 0.005 ? 'filled as expected' : a.favorable ? 'favorable fill' : 'unfavorable fill';
    const cause = a.basis === 'best bid' ? 'due to spread/buffer' : a.basis === 'last price' ? 'vs the last price (no fresh bid)' : `vs the ${a.basis}`;
    const n = el('span', { className: `sub jr-audit ${a.favorable ? 'pnl-pos' : 'pnl-neg'}`,
      textContent: `Expected: ${money(a.expected)} | Actual Fill: ${money(a.actual)} (${signed(a.variance, money)} ${why} ${cause})` });
    n.title = `Expected at ${a.basis}${Number.isFinite(a.expectedBid) ? ` ${a.expectedBid}` : ''}; filled ${a.filledQty} @ ${a.avgFillPrice}, Coinbase fee ${money(a.fees)}`;
    return n;
  }

  function render(trades) {
    const sorted = [...trades].sort((a, b) => b.closedAt - a.closedAt);
    setTable('journal', sorted.map((t) => el('tr', {}, [
      (() => { const c = assetCell(t, `${price(t.fillPrice, t)} → ${price(t.exitPrice, t)} · ${clock(t.closedAt)}`
        + `${t.execution === 'LIVE' ? ` · LIVE @ ${t.broker} (${t.pnlSource === 'broker-fills' ? 'broker fills' : 'P/L estimated'})` : ''}`); const a = audit(t); if (a) c.append(a); return c; })(),
      dirCell(t),
      td(LEG_LABELS[t.exitLeg] || EXIT_LABELS[t.exitReason] || t.exitReason),
      td(signed(t.netPnl, money), `num ${pnlClass(t.netPnl)}`),
      td(signed(t.rMultiple, (x) => `${x.toFixed(2)}R`), `num ${pnlClass(t.rMultiple)}`),
    ])));

    const net = trades.reduce((s, t) => s + t.netPnl, 0);
    const wins = trades.filter((t) => t.netPnl > 0).length;
    $('journal-summary').textContent = trades.length
      ? `Net ${signed(net, money)} · ${wins}W / ${trades.length - wins}L · after estimated fees`
      : 'Net of estimated fees and slippage';
  }

  SD.journal = { render };
})();
