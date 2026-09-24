// Active Positions view (Portfolio tab). Renders the server's snapshot as-is.
// Exposes window.SignalDesk.portfolio.
(() => {
  const SD = window.SignalDesk;
  const { el, td, price, size, clock, dirCell, assetCell, setTable } = SD.ui;

  function render(positions) {
    const rows = [...positions].sort((a, b) => b.openedAt - a.openedAt).map((p) => {
      const t1 = (p.targets || []).find((t) => t.level === 1) || (p.targets || [])[0];
      return el('tr', {}, [
        assetCell(p, `${p.market} · opened ${clock(p.openedAt)}`),
        dirCell(p),
        td(size(p), 'num'),
        td(price(p.fillPrice, p), 'num'),
        td(price(p.invalidation, p), 'num'),
        td(t1 ? price(t1.price, p) : '—', 'num'),
      ]);
    });
    setTable('positions', rows);
  }

  SD.portfolio = { render };
})();
