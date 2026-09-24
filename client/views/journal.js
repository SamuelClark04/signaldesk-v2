// Closed Trades view (Journal tab). Renders the server's snapshot as-is.
// Exposes window.SignalDesk.journal.
(() => {
  const SD = window.SignalDesk;
  const { $, el, td, price, money, signed, pnlClass, clock, dirCell, assetCell, setTable } = SD.ui;

  const EXIT_LABELS = { STOP_LOSS: 'Stop loss', TAKE_PROFIT: 'Take profit', TAKE_PROFIT_T1: 'T1 partial (runner open)', BROKER_EXIT: 'Broker exit' };
  const LEG_LABELS = { take_profit: 'Broker take profit', stop_loss: 'Broker stop loss' };

  function render(trades) {
    const sorted = [...trades].sort((a, b) => b.closedAt - a.closedAt);
    setTable('journal', sorted.map((t) => el('tr', {}, [
      assetCell(t, `${price(t.fillPrice, t)} → ${price(t.exitPrice, t)} · ${clock(t.closedAt)}`
        + `${t.execution === 'LIVE' ? ` · LIVE @ ${t.broker} (${t.pnlSource === 'broker-fills' ? 'broker fills' : 'P/L estimated'})` : ''}`),
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
