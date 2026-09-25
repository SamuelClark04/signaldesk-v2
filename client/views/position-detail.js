// Setups tab, right panel for an OPEN position: shown when the charted symbol is
// held (e.g. clicked in the rail's Active Positions). Real option contracts show
// the contract, live premium (real bid, or the modelled value), the option's own
// P&L and its Greeks; positions from the old simulated options strategy say
// plainly that no real contract (so no live premium) exists; stocks/crypto show
// fill, live P/L and levels. Marks come from portfolioMetrics.mark (server
// optionMark for options), exactly as the HUD and Portfolio compute them.
// Also the chart banner text (banner()). Exposes window.SignalDesk.positionDetail.
(() => {
  const SD = window.SignalDesk;
  const { el, money, price, size, signed, pnlClass } = SD.ui;

  const kv = (k, v, cls = '') => el('div', { className: 'opp-kv' }, [
    el('span', { className: 'opp-k', textContent: k }), el('span', { className: `opp-v ${cls}`, textContent: v })]);
  const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(2)}%`;
  const ulPx = (x) => price(x, { market: 'stocks', entryPrice: x });
  const isRealOption = (p) => p.market === 'options' && p.optionsData && !!p.optionsData.contract;
  const heldFor = (state, asset) => ((state && state.positions) || []).filter((p) => p.asset === asset);
  // Phase 58B: a spread opened before the net-delta floor (migrated, entry net delta < 0.12).
  const lowDelta = (p) => { const od = p.optionsData || {}; const d = Math.abs(od.netDelta ?? (od.stats ? od.stats.netDelta : NaN)); return od.migratedFrom && Math.round(d * 100) < 12 ? d : null; }; // as displayed (2 dp)
  const venueOf = (p) => (p.adopted ? 'Adopted' : p.execution === 'LIVE' ? `Live · ${p.broker}` : 'Paper');

  function daysLeft(expiration) {
    const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) + 'T00:00:00Z');
    return Math.round((Date.parse(`${expiration}T00:00:00Z`) - today) / 864e5);
  }

  function pnlRow(label, m) {
    if (m.gross === null || m.gross === undefined) return kv(label, 'No price');
    return kv(label, `${signed(m.gross, money)}${m.pctGross === null ? '' : ` (${pct(m.pctGross)})`}${m.net === null ? '' : ` · after fees ${signed(m.net, money)}`}`, pnlClass(m.gross));
  }

  function realOptionRows(p, m) {
    const od = p.optionsData;
    const om = p.optionMark || {};
    const exp = new Date(`${od.expiration}T12:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const premium = m.optionValue === undefined ? 'No option price (no fresh quote or live underlying)'
      : m.optionBasis === 'mid' ? `${m.optionValue.toFixed(2)} mid${Number.isFinite(om.fill) ? ` (closing fills ~${om.fill.toFixed(2)})` : ''}`
        : m.optionBasis === 'bid' ? `${m.optionValue.toFixed(2)} live bid${om.ask ? ` / ${om.ask} ask` : ''}` : `${m.optionValue.toFixed(2)} modelled (no fresh quote)`;
    // Phase 58: live net Greeks / breakeven / POP (server optionMark.stats), else the entry stats.
    const stats = SD.optionStats.rows(p, om.stats || od.stats, om.underlying);
    const live = (x, entry, fmt) => (Number.isFinite(x) ? `${fmt(x)} (live)` : Number.isFinite(entry) ? `${fmt(entry)} (at entry)` : '—');
    const low = lowDelta(p);
    return [
      ...(low !== null ? [el('p', { className: 'opp-size-warn opp-low-delta', textContent: `Low net delta (${low.toFixed(2)}) — opened under pre-Phase 58 rules: it moves only `
        + `$${Math.round(low * 100)} per $1 in ${p.asset}. Close it with Manual Exit / Close Position if you want to free the slot.` })] : []),
      kv('Contract', od.structure === 'vertical' ? `${od.contract} / −${od.shortContract}` : od.contract),
      kv('Strike · expiry', `${od.structure === 'vertical' ? `${od.strike}/${od.shortStrike} ${od.type === 'put' ? 'put' : 'call'} spread` : `${od.strike} ${od.type === 'put' ? 'put' : 'call'}`} · ${exp} (${daysLeft(od.expiration)} days left)`),
      ...(od.exitRule ? [kv('Exits on its value', `stop ${od.exitRule.stopValue} · T1 ${od.exitRule.targetValue} (per share)`)] : []),
      kv('Premium now', premium),
      kv('Premium paid', `${od.debit} × ${p.positionSize} contract${p.positionSize === 1 ? '' : 's'} = ${money(od.debit * od.multiplier * p.positionSize)}`),
      pnlRow('Option P&L', m),
      kv('R multiple', Number.isFinite(m.r) ? `${m.r >= 0 ? '+' : '−'}${Math.abs(m.r).toFixed(2)}R of ${money(p.dollarRisk)} at risk` : '—'),
      ...(stats.length ? stats.map(([k, v, cls]) => kv(k, v, cls)) : [
        kv('Delta', live(om.delta, od.delta, (x) => x.toFixed(2))),
        kv('Implied volatility', live(om.iv, od.iv, (x) => `${(x * 100).toFixed(1)}%`)),
        kv('Theta', Number.isFinite(od.theta) ? `${od.theta.toFixed(3)} per day (at entry)` : '—')]),
    ];
  }

  function legacyOptionRows(p) {
    const od = p.optionsData || {};
    const legs = (od.legs || []).map((l) => `${l.side} ${l.strike}${l.type === 'put' ? 'P' : 'C'}`).join(' / ');
    return [
      kv('Structure', `${legs || '—'} · ${od.debit} debit × ${p.positionSize}`),
      el('p', { className: 'opp-size-warn', textContent: 'Simulated options position: it was opened by the old placeholder options strategy, before real chains. '
        + 'Its strikes and debit were never a listed contract (no expiry, no IV), so it has no live premium or Greeks; at exit it is booked at intrinsic value. '
        + 'Close it to retire it: new options setups use real contracts.' }),
    ];
  }

  function linearRows(p, m) {
    return [
      kv('Size', size(p)),
      kv('Fill price', price(p.fillPrice, p)),
      kv('Live price', m.price > 0 ? price(m.price, p) : 'No live price'),
      pnlRow('Unrealized P/L', m),
      kv('R multiple', Number.isFinite(m.r) ? `${m.r >= 0 ? '+' : '−'}${Math.abs(m.r).toFixed(2)}R` : '—'),
    ];
  }

  // Same rules as the trade panel's button: paper positions close at the live price
  // (server re-checks); LIVE / adopted ones are closed at the broker.
  function exitButton(p, m, ctx) {
    const atBroker = p.execution === 'LIVE' || p.execution === 'BROKER';
    const closing = !!(ctx.closing && ctx.closing.has(p.id));
    const b = el('button', { type: 'button', className: `btn hud-exit${atBroker ? '' : ' is-armed'}`,
      textContent: atBroker ? `Close at ${p.broker}` : closing ? 'Closing…' : 'Manual Exit / Close Position',
      disabled: atBroker || closing || !m.live || !ctx.online || !ctx.onClosePosition,
      title: atBroker ? 'LIVE / adopted position: close it at the broker' : !m.live ? 'No live price: cannot close at a known price' : !ctx.online ? 'Offline' : 'Close this paper position now at the live price' });
    b.onclick = () => ctx.onClosePosition(p, m);
    return b;
  }

  function positionBlock(p, livePrice, ctx) {
    const m = SD.portfolioMetrics.mark(p, livePrice);
    const opt = p.market === 'options';
    const t1 = p.targets && p.targets[0] && p.targets[0].price;
    const under = m.price > 0 ? `${ulPx(m.price)}${Number.isFinite(m.underlyingMove) ? ` (${pct(m.underlyingMove)} since ${ulPx(p.fillPrice)})` : ''}` : 'No live price';
    return el('div', { className: 'opp-kv-group' }, [
      el('h3', { className: 'opp-section', textContent: `${venueOf(p)} · ${p.direction === 'short' ? 'Short' : 'Long'} ${p.setupType || ''}` }),
      ...(isRealOption(p) ? realOptionRows(p, m) : opt ? legacyOptionRows(p) : linearRows(p, m)),
      ...(opt ? [kv(`Underlying ${p.asset}`, under)] : []),
      kv(opt ? `${p.asset} stop` : 'Stop', price(p.invalidation, p), 'text-short'),
      kv(opt ? `${p.asset} target (T1)` : 'Take profit 1 (T1)', t1 ? price(t1, p) : '—', 'text-long'),
      kv('Opened', p.openedAt ? new Date(p.openedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'),
      exitButton(p, m, ctx),
    ]);
  }

  // Right panel for the held symbol o.asset, or null when nothing is held.
  function panel(o, ctx) {
    const held = heldFor(ctx.state, o.asset);
    if (!held.length) return null;
    const opt = held.some((p) => p.market === 'options');
    return el('aside', { className: 'opp-right' }, [
      el('header', { className: 'opp-right-head' }, [
        SD.scannerDetail.badge(o.asset, true),
        el('div', { className: 'opp-title' }, [el('strong', { className: 'opp-right-symbol', textContent: SD.oppDetail.displaySymbol(o) }),
          el('span', { className: 'opp-name', textContent: `Open position${held.length > 1 ? `s (${held.length})` : ''}` })]),
        el('span', { className: 'opp-pill is-ready', textContent: 'In trade' }),
      ]),
      ...held.map((p) => positionBlock(p, ctx.livePrice, ctx)),
      el('p', { className: 'opp-muted', textContent: `${opt ? 'The chart shows the underlying stock. ' : ''}Manual exit: the button above, or the trade panel on the chart (it can be moved or minimized).` }),
    ]);
  }

  // Chart banner: options are charted by their underlying, so say where the
  // option's own P&L lives; otherwise the caller's default text.
  function banner(o, ctx, fallback) {
    const held = heldFor(ctx.state, o.asset);
    if (o.market === 'options' || held.some((p) => p.market === 'options')) {
      return `Charting ${o.asset} (the underlying). Option P&L is tracked in the trade panel.`;
    }
    return held.length ? '' : fallback;
  }

  SD.positionDetail = { lowDelta, panel, banner, isRealOption };
})();
