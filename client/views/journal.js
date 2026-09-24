// Closed Trades view (Journal tab). Renders the server's snapshot as-is.
// Exposes window.SignalDesk.journal.
(() => {
  const SD = window.SignalDesk;
  const { $, el, td, price, money, signed, pnlClass, clock, dirCell, assetCell, setTable } = SD.ui;

  const EXIT_LABELS = { STOP_LOSS: 'Stop loss', TAKE_PROFIT: 'Take profit (T1)' };

  function render(trades) {
    const sorted = [...trades].sort((a, b) => b.closedAt - a.closedAt);
    setTable('journal', sorted.map((t) => el('tr', {}, [
      assetCell(t, `${price(t.fillPrice, t)} → ${price(t.exitPrice, t)} · ${clock(t.closedAt)}`),
      dirCell(t),
      td(EXIT_LABELS[t.exitReason] || t.exitReason),
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
