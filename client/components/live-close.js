// [Close at Coinbase] (Phase 60): the manual exit for a LIVE Coinbase position, on the
// Open Position panel and the chart's trade pill. The server (coinbase-exit.js) cancels
// the position's stop/target bracket at Coinbase, waits until Coinbase confirms it and
// releases the coins, market-sells the exact quantity and books the real fill as
// MANUAL_CLOSE @ Coinbase. Nothing is sold if the bracket cannot be canceled; a refused
// sell puts the bracket back. One confirmation (real money), one close in flight each.
// Exposes window.SignalDesk.liveClose: { can(p), button(p, m, ctx), received(result) }.
(() => {
  const SD = window.SignalDesk;
  const { el, money, price, signed } = SD.ui;

  const busy = new Set();
  const can = (p) => p.execution === 'LIVE' && p.broker === 'Coinbase' && p.market === 'crypto';
  const coin = (p) => p.asset.replace(/-USDC?$/, '');

  function toast(text, ok) {
    const n = el('div', { className: `lc-toast${ok ? ' is-ok' : ' is-error'}`, role: 'status', textContent: text });
    document.body.append(n);
    setTimeout(() => n.remove(), ok ? 7000 : 12000);
  }

  function request(p, m) {
    if (busy.has(p.id) || !SD.app.isOnline()) return;
    const live = m && m.price > 0 ? m.price : null;
    const q = p.exitQuote;
    const est = q && Number.isFinite(q.cashout) ? `~${money(q.cashout)} into your Coinbase cash at ${price(q.underlying, p)} (after the ${money(q.exitFee)} exit fee); net ${signed(q.net, money)} after all fees`
      : live ? `~${money(p.positionSize * live)} at ${price(live, p)} before fees (${signed((live - p.fillPrice) * p.positionSize, money)} vs entry)` : 'at the market price';
    const steps = p.adopted ? 'It has no SignalDesk stop/target at Coinbase, so this is a plain market sell.'
      : '1) cancel its stop/target bracket at Coinbase, 2) wait until Coinbase releases the coins, 3) market-sell them. If the bracket cannot be canceled nothing is sold; if the sell is refused the bracket is put back.';
    if (!window.confirm(`SELL ${p.positionSize} ${coin(p)} at Coinbase now (LIVE, real money)?\n\n${steps}\n\nProceeds ${est}.`)) return;
    busy.add(p.id);
    SD.app.send({ type: 'CLOSE_LIVE_COINBASE_POSITION', id: p.id });
    SD.app.refresh();
  }

  function received(r) {
    if (!r) return;
    busy.delete(r.id);
    const t = r.trade;
    if (!r.ok) toast(`Close at Coinbase failed for ${String(r.id || '').split(':')[2] || r.id}: ${r.error}`, false);
    else if (r.pending) toast('Sell sent to Coinbase and still working: it is booked as soon as it fills.', true);
    else if (r.alreadyClosed) toast(`Already closed at Coinbase: ${r.detail}`, true);
    else if (t) toast(`Sold ${t.positionSize} ${coin(t)} at Coinbase @ ${price(t.exitPrice, t)}: net ${signed(t.netPnl, money)} (fees ${money(t.fees)}). In the Journal as MANUAL_CLOSE @ Coinbase.`, true);
    SD.app.refresh();
  }

  // Phase 61: the button carries what the sale deposits (cashout: size x live price less
  // the exit fee, from the server's exit quote) and the round-trip net P&L.
  // Each amount is one unbreakable piece: the sign never wraps away from its figure.
  const label = (p) => {
    const q = p.exitQuote;
    if (!q || !Number.isFinite(q.cashout)) return ['Close at Coinbase'];
    const nw = (t) => el('span', { className: 'no-wrap', textContent: t });
    return ['Close at Coinbase (', nw(`${money(q.cashout)} cashout`), ' · ', nw(`${signed(q.net, money)} net`), ')'];
  };

  function button(p, m, ctx) {
    const closing = busy.has(p.id);
    const b = el('button', { type: 'button', className: 'btn hud-exit is-armed is-live-close', disabled: closing || !ctx.online,
      title: p.adopted ? 'Market-sell this holding at Coinbase (real money)' : 'Cancel its stop/target at Coinbase, then market-sell it (real money)' },
    closing ? ['Closing at Coinbase…'] : label(p));
    b.onclick = () => request(p, m);
    return b;
  }

  SD.liveClose = { can, button, received, busy: (id) => busy.has(id) };
})();
