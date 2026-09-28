// Chart level lines + price-scale fit for the live chart panes (views/live-chart.js).
//   levelsOf / specsFor   the setup's / position's / options plan's level lines (Phase 58C):
//                         ENTRY, SL, T1 / T2, BE (options: spread values on the underlying)
//   range                 the price scale's range (Phase 70C). Default 'candles': the visible
//                         candles' high / low, widened only by the levels that still leave the
//                         candles >= MIN_CANDLE_SHARE of the height (entry / BE near the price
//                         show; a stop or target far away never flattens the candles).
//                         'levels': every level line on screen ([⇕ Levels] / a rail badge).
//   badges                levels outside the visible scale: "▲ T1 3,650.00 +35.7%" on the top
//                         rail, "▼ SL 2,306.00 −14.3%" on the bottom one (click: fit all levels).
// Exposes window.SignalDesk.chartLevels.
(() => {
  const SD = window.SignalDesk;
  const { el, price } = SD.ui;
  const MIN_CANDLE_SHARE = 0.65;
  const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const cyan = () => css('--accent', '#38bdf8');

  // { entry, entryMin, stop, t1, t2, be, debit, stopValue, t1Value, t2Value, option } from an order / plan / position.
  function levelsOf(x) {
    if (!x) return null;
    const od = x.optionsData || null;
    const rule = od && od.exitRule;
    const t = x.targets || [];
    const plan = x.t1Value !== undefined; // an after-hours plan (after-hours-plans.js)
    return {
      option: !!od || plan, entry: plan ? x.refSpot : x.fillPrice || (x.entryZone && x.entryZone.max), entryMin: x.entryZone && x.entryZone.min !== x.entryZone.max ? x.entryZone.min : 0,
      stop: x.invalidation, t1: plan ? x.t1 : t[0] && t[0].price, t2: plan ? x.t2 : t[1] && t[1].price,
      // BE: options at expiry; a stock / crypto position the price where closing now nets $0 (Phase 63), a staged order its fee hurdle.
      be: plan ? x.stats && x.stats.breakeven : od ? od.breakeven || (od.stats && od.stats.breakeven) : (x.exitQuote && x.exitQuote.breakEven) || (x.hurdle && x.hurdle.breakEven),
      debit: plan ? x.debit : od && od.debit, stopValue: plan ? x.stopValue : rule && rule.stopValue, t1Value: plan ? x.t1Value : rule && rule.targetValue, t2Value: plan ? x.t2Value : rule && rule.t2Value,
    };
  }
  const optionSpecs = (L) => [
    { title: `T2 · spread ${L.t2Value || '—'}`, price: L.t2, color: '#14b8a6', style: 2 },
    { title: `T1 · spread ${L.t1Value}`, price: L.t1, color: css('--long', '#2dd4bf'), style: 0 },
    { title: `BE (expiry)`, price: L.be, color: css('--warn', '#fbbf24'), style: 1 },
    { title: `ENTRY · paid ${L.debit}`, price: L.entry, color: cyan(), style: 2 },
    { title: `SL · spread ${L.stopValue}`, price: L.stop, color: css('--short', '#fb7185'), style: 0 },
  ];
  function specsFor(o, withLevels, overlay, levelsOn) {
    const t = o.targets || [];
    const L = withLevels ? levelsOf(o) : levelsOf(overlay);
    return (!levelsOn || !L ? [] : L.option ? optionSpecs(L) : !withLevels ? [
      { title: 'T2', price: L.t2, color: css('--long', '#2dd4bf') }, { title: 'T1', price: L.t1, color: css('--long', '#2dd4bf') },
      { title: 'BE', price: L.be, color: css('--warn', '#fbbf24') }, // dashed: breakeven after both fees (+ the bid gap)
      { title: 'Entry', price: L.entry, color: cyan() }, { title: 'SL', price: L.stop, color: css('--short', '#fb7185') },
    ] : [
      { title: 'T2', price: t[1] && t[1].price, color: css('--long', '#2dd4bf') },
      { title: 'T1', price: t[0] && t[0].price, color: css('--long', '#2dd4bf') },
      { title: 'BE', price: o.hurdle && o.hurdle.breakEven, color: css('--warn', '#fbbf24') },
      { title: 'Entry', price: o.entryZone.max, color: cyan() },
      { title: 'Entry', price: o.entryZone.min !== o.entryZone.max ? o.entryZone.min : 0, color: cyan() },
      { title: 'Stop', price: o.invalidation, color: css('--short', '#fb7185') },
    ]).filter((s) => s.price > 0);
  }

  // The price scale's range: the candles' own (`res`, the series' autoscale), widened by levels
  // nearest-first while the candles keep >= MIN_CANDLE_SHARE of it ('candles'), or by all ('levels').
  function range(res, levels, mode) {
    if (!res || !res.priceRange || !levels.length) return res;
    const { minValue: lo, maxValue: hi } = res.priceRange;
    if (mode === 'levels') return { ...res, priceRange: { minValue: Math.min(lo, ...levels), maxValue: Math.max(hi, ...levels) } };
    const cap = Math.max(hi - lo, Math.abs(hi) * 1e-4) / MIN_CANDLE_SHARE;
    const dist = (x) => (x < lo ? lo - x : x > hi ? x - hi : 0);
    let a = lo;
    let b = hi;
    for (const x of [...levels].sort((p, q) => dist(p) - dist(q))) {
      if (Math.max(b, x) - Math.min(a, x) <= cap) { a = Math.min(a, x); b = Math.max(b, x); }
    }
    return { ...res, priceRange: { minValue: a, maxValue: b } };
  }

  // Rail badges for the level lines off the visible scale. view: { box, chart, series, specs, o }.
  function badges(view, onFitAll) {
    let rail = view.rail;
    if (!rail) { rail = { top: el('div', { className: 'lwc-rail is-top' }), bottom: el('div', { className: 'lwc-rail is-bottom' }) }; view.box.append(rail.top, rail.bottom); view.rail = rail; }
    const h = view.chart.paneSize ? view.chart.paneSize().height : view.canvas.clientHeight - 26;
    const last = view.lastClose || 0;
    const up = [];
    const down = [];
    for (const s of view.specs || []) {
      const y = view.series.priceToCoordinate(s.price);
      if (y === null || !(h > 0)) continue;
      if (y < 2) up.push(s); else if (y > h - 2) down.push(s);
    }
    const chip = (s, dir) => {
      const pct = last > 0 ? ` ${s.price >= last ? '+' : '−'}${Math.abs((s.price / last - 1) * 100).toFixed(1)}%` : '';
      const b = el('button', { type: 'button', className: 'lwc-badge', textContent: `${dir} ${s.title.split(' · ')[0]} ${price(s.price, view.o)}${pct}`, title: 'Off the chart: click to fit every level line' });
      b.style.borderColor = s.color; b.style.color = s.color;
      b.onclick = onFitAll;
      return b;
    };
    rail.top.replaceChildren(...up.sort((p, q) => q.price - p.price).map((s) => chip(s, '▲')));
    rail.bottom.replaceChildren(...down.sort((p, q) => q.price - p.price).map((s) => chip(s, '▼')));
  }

  SD.chartLevels = { levelsOf, specsFor, range, badges, MIN_CANDLE_SHARE };
})();
