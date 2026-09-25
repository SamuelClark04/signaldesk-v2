// Opportunities chart panes: TradingView Lightweight Charts candlesticks + volume.
// Data (history + live 1m bars from ticks) is shared: components/chart-data.js.
// Phase 61: a pane is an INSTANCE (makeChart) with its own timeframe, follow-price
// switch, level lines and canvas, so the Dual Chart's second pane
// (components/dual-chart-container.js) streams independently of the first. The
// primary pane is the one Opportunities and the Moonshot Radar mount; its toolbar
// carries [⬍ Dual Chart]. A pane's host node is handed back on every re-render, so
// its canvas survives. mount() returns null if the library failed to load (offline),
// and the view falls back to the static level chart.
// Exposes window.SignalDesk.liveChart: the primary pane's API + create(opts) for more.
(() => {
  const SD = window.SignalDesk;
  const { el, price } = SD.ui;
  const D = SD.chartData;
  const { TIMEFRAMES, TF_SEC } = D;
  const UP = '#26a69a';
  const DOWN = '#ef5350';

  const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const localTime = (t, opts) => new Date(t * 1000).toLocaleString([], opts);
  const priceFormat = (p) => { const precision = p >= 10 ? 2 : p >= 0.1 ? 4 : 6; return { type: 'price', precision, minMove: 10 ** -precision }; };
  const volBar = (b) => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? 'rgba(38, 166, 154, 0.35)' : 'rgba(239, 83, 80, 0.35)' });
  const cyan = () => css('--accent', '#38bdf8');

  // Level lines (Phase 58C), shared switch: the charted setup's, else the overlay (an
  // open position or an after-hours options plan). Options map the UNDERLYING levels,
  // labelled with the spread's value there: ENTRY · paid, SL, T1 / T2, BE (expiry).
  let levelsOn = (() => { try { return localStorage.getItem('signaldesk.chartLevels') !== 'off'; } catch { return true; } })();
  const panes = new Set();
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
      be: plan ? x.stats && x.stats.breakeven : od && (od.breakeven || (od.stats && od.stats.breakeven)),
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
  function specsFor(o, withLevels, overlay) {
    const t = o.targets || [];
    const L = withLevels ? levelsOf(o) : levelsOf(overlay);
    return (!levelsOn || !L ? [] : L.option ? optionSpecs(L) : !withLevels ? [
      { title: 'T2', price: L.t2, color: css('--long', '#2dd4bf') }, { title: 'T1', price: L.t1, color: css('--long', '#2dd4bf') },
      { title: 'Entry', price: L.entry, color: cyan() }, { title: 'SL', price: L.stop, color: css('--short', '#fb7185') },
    ] : [
      { title: 'T2', price: t[1] && t[1].price, color: css('--long', '#2dd4bf') },
      { title: 'T1', price: t[0] && t[0].price, color: css('--long', '#2dd4bf') },
      { title: 'Entry', price: o.entryZone.max, color: cyan() },
      { title: 'Entry', price: o.entryZone.min !== o.entryZone.max ? o.entryZone.min : 0, color: cyan() },
      { title: 'Stop', price: o.invalidation, color: css('--short', '#fb7185') },
    ]).filter((s) => s.price > 0);
  }

  // One chart pane. opts: { tf, extraTools: () => [nodes] for its toolbar, label }.
  function makeChart(paneOpts = {}) {
    let tf = paneOpts.tf || '15m';
    let follow = true;
    let view = null;

    function toolbar() {
      const tfs = el('div', { className: 'lwc-tfs', role: 'group' }, TIMEFRAMES.map(([key, label]) => {
        const b = el('button', { type: 'button', className: 'lwc-tf', textContent: label, dataset: { tf: key } });
        b.onclick = () => { tf = key; D.loadHistory(view.o.asset, tf); paint(); };
        return b;
      }));
      const followBox = el('input', { type: 'checkbox', checked: follow });
      followBox.onchange = () => { follow = followBox.checked; view.chart.timeScale().applyOptions({ shiftVisibleRangeOnNewBar: follow }); if (follow) view.chart.timeScale().scrollToRealTime(); };
      const fitBtn = el('button', { type: 'button', className: 'lwc-tool', textContent: '⤢ Fit', title: 'Fit all bars and every level line (entry, stop, targets, breakeven)' });
      fitBtn.onclick = () => { view.chart.priceScale('right').applyOptions({ autoScale: true }); view.chart.timeScale().fitContent(); };
      const full = el('button', { type: 'button', className: 'lwc-tool', textContent: '⛶', title: 'Full screen' });
      full.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : view.host.requestFullscreen && view.host.requestFullscreen());
      return el('div', { className: 'lwc-bar' }, [tfs, el('label', { className: 'lwc-tool lwc-follow' }, [followBox, 'Follow price']), fitBtn, full, ...(paneOpts.extraTools ? paneOpts.extraTools() : [])]);
    }

    function create() {
      const LWC = window.LightweightCharts;
      const host = el('div', { className: 'opp-lwc-wrap' });
      const box = el('div', { className: 'opp-chart opp-lwc' });
      const canvas = el('div', { className: 'opp-lwc-canvas' });
      const note = el('div', { className: 'opp-chart-note' });
      const banner = el('div', { className: 'opp-watch-mode' });
      box.append(canvas, banner, note);
      host.append(toolbar(), box);
      const grid = 'rgba(148, 163, 184, 0.06)';
      const chart = LWC.createChart(canvas, {
        width: 0, height: 0, // sized by fit(): autoSize misses the first layout of a detached host
        layout: { background: { type: 'solid', color: css('--bg', '#0b1120') }, textColor: css('--text-muted', '#94a3b8'), fontSize: 11, attributionLogo: false },
        grid: { vertLines: { color: grid }, horzLines: { color: grid } },
        rightPriceScale: { borderColor: css('--border', '#1f2a3c'), scaleMargins: { top: 0.08, bottom: 0.22 } },
        localization: { timeFormatter: (t) => localTime(t, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }, // viewer's local time
        timeScale: {
          borderColor: css('--border', '#1f2a3c'), timeVisible: true, secondsVisible: false, rightOffset: 4, shiftVisibleRangeOnNewBar: follow,
          tickMarkFormatter: (t, type) => (type < 3 ? localTime(t, { month: 'short', day: 'numeric' }) : localTime(t, { hour: '2-digit', minute: '2-digit' })),
        },
        crosshair: { mode: LWC.CrosshairMode.Normal },
      });
      const volume = chart.addSeries(LWC.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      const series = chart.addSeries(LWC.CandlestickSeries, {
        upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false,
        autoscaleInfoProvider: (original) => { // keep every level line on screen
          const res = original();
          const lv = (view && view.levels) || [];
          if (!res || !lv.length) return res;
          const { minValue, maxValue } = res.priceRange;
          return { ...res, priceRange: { minValue: Math.min(minValue, ...lv), maxValue: Math.max(maxValue, ...lv) } };
        },
      });
      new ResizeObserver(() => fit()).observe(canvas);
      // Toolbar height (it wraps to 2+ rows when narrow): the trade HUD floats under it (Phase 61).
      const bar = host.firstChild;
      new ResizeObserver(() => { if (view && bar.offsetHeight) { view.barH = bar.offsetHeight; const w = host.closest('.opp-chart-wrap'); if (w) w.style.setProperty('--lwc-bar-h', `${view.barH}px`); } }).observe(bar);
      return { host, box, canvas, note, banner, chart, series, volume, o: null, opts: {}, shown: '', histRef: null, lastTime: 0, levelsKey: '', lines: [], levels: [] };
    }

    // Re-renders detach and re-attach the host; the first layout can happen while hidden.
    function fit() {
      if (!view) return;
      const w = view.canvas.clientWidth; const h = view.canvas.clientHeight;
      if (w > 0 && h > 0 && (w !== view.w || h !== view.h)) { view.w = w; view.h = h; view.chart.resize(w, h); }
    }

    function setLevels() {
      const specs = specsFor(view.o, view.opts.withLevels, view.opts.overlay);
      const key = JSON.stringify(specs);
      if (key === view.levelsKey) return;
      view.levelsKey = key;
      for (const line of view.lines) view.series.removePriceLine(line);
      view.lines = specs.map((s) => view.series.createPriceLine({ price: s.price, color: s.color, title: s.title, lineWidth: s.style === 0 ? 2 : 1, lineStyle: s.style ?? 2, axisLabelVisible: true }));
      view.levels = specs.map((s) => s.price);
    }

    // Full reload when the symbol, timeframe or history changes; else update the forming candle.
    function sync(symbol) {
      const h = D.historyOf(symbol, tf);
      const data = D.mergedBars(symbol, tf);
      const last = data[data.length - 1];
      const shown = `${symbol}|${tf}`;
      if (view.shown !== shown || view.histRef !== h) {
        if (last) view.series.applyOptions({ priceFormat: priceFormat(last.close) });
        view.series.setData(data);
        view.volume.setData(data.map(volBar));
        requestAnimationFrame(() => requestAnimationFrame(() => view.chart.timeScale().scrollToRealTime()));
      } else {
        for (const b of data) if (b.time >= view.lastTime) { view.series.update(b); view.volume.update(volBar(b)); }
        if (follow && last && last.time > view.lastTime) view.chart.timeScale().scrollToRealTime();
      }
      view.shown = shown;
      view.histRef = h;
      view.lastTime = last ? last.time : 0;
    }

    function noteText(o) {
      const h = D.historyOf(o.asset, tf);
      const src = o.market === 'crypto' ? 'Coinbase' : 'Alpaca IEX';
      const label = TIMEFRAMES.find(([k]) => k === tf)[1];
      const tail = D.liveBars(o.asset).length ? ' · live' : '';
      if (!h || h.status === 'loading') return h && h.bars.length ? `${label} candles · ${src} · refreshing…` : `Loading ${label} history from ${src}…`;
      if (h.status === 'error') return `History unavailable (${String(h.error).slice(0, 60)})${tail ? ' · live ticks only' : ''}`;
      return h.bars.length ? `${label} candles · ${src}${tail}` : `No recent history from ${src}${tail}`;
    }

    function paint() {
      const { o, opts } = view;
      setLevels(); // price lines first: the autoscale provider reads view.levels
      sync(o.asset);
      view.note.textContent = noteText(o);
      view.banner.textContent = opts.banner || '';
      view.banner.hidden = !opts.banner;
      view.host.querySelectorAll('.lwc-tf').forEach((b) => b.classList.toggle('is-active', b.dataset.tf === tf));
      const bars = D.liveBars(o.asset);
      const last = bars.length ? bars[bars.length - 1].close : 0;
      view.box.setAttribute('aria-label', `${o.asset} candlestick chart${last > 0 ? `, last ${price(last, o)}` : ''}`);
    }

    // o: pending order or Market Watch object; withLevels: draw its levels.
    // overlay: an open position / options plan whose levels are drawn in Market Watch.
    function mount(o, { withLevels, banner = '', overlay = null } = {}) {
      if (!window.LightweightCharts) return null;
      if (!view) { view = create(); view.box.setAttribute('role', 'img'); }
      view.o = o;
      view.opts = { withLevels, banner, overlay };
      D.loadHistory(o.asset, tf); // no-op while fresh
      paint();
      requestAnimationFrame(fit);
      return view.host;
    }

    function stats(symbol) { // high / low / first / last of what the pane shows (Price structure tab)
      const h = D.historyOf(symbol, tf);
      if (!h || !h.bars.length) return null; // live ticks alone are not a range
      const data = D.mergedBars(symbol, tf);
      return { tf: TIMEFRAMES.find(([k]) => k === tf)[1], bars: data.length, high: Math.max(...data.map((b) => b.high)), low: Math.min(...data.map((b) => b.low)),
        first: data[0], last: data[data.length - 1] };
    }

    const pane = {
      mount, stats,
      setTimeframe: (frame) => { if (TF_SEC[frame]) tf = frame; },
      timeframe: () => tf,
      barHeight: () => (view && view.barH) || null,
      showing: () => (view && view.o ? view.o.asset : null),
      loaded: (symbol, frame) => { if (view && view.o && view.o.asset === symbol && tf === frame) paint(); },
      relevel: () => { if (view && view.o) { view.levelsKey = ''; paint(); view.chart.priceScale('right').applyOptions({ autoScale: true }); } },
    };
    panes.add(pane);
    return pane;
  }

  D.onLoaded((symbol, frame) => { for (const p of panes) p.loaded(symbol, frame); });

  function setLevelsVisible(on) {
    levelsOn = !!on;
    try { localStorage.setItem('signaldesk.chartLevels', on ? 'on' : 'off'); } catch { /* this session only */ }
    for (const p of panes) p.relevel();
  }

  // The primary pane (Opportunities center, Moonshot Radar): its toolbar has [⬍ Dual Chart].
  const primary = makeChart({ extraTools: () => (SD.dualChart ? [SD.dualChart.toggleButton()] : []) });
  SD.liveChart = { record: D.record, mount: primary.mount, stats: primary.stats, setTimeframe: primary.setTimeframe, primary,
    setLevelsVisible, levelsVisible: () => levelsOn, levelsOf, create: makeChart };
})();
