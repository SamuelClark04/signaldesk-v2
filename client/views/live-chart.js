// Opportunities chart panes: TradingView Lightweight Charts candlesticks + volume.
// Data (history + live 1m bars from ticks) is shared: components/chart-data.js.
// Phase 61: a pane is an INSTANCE (makeChart) with its own timeframe, follow-price
// switch, level lines and canvas, so the Dual Chart's second pane
// (components/dual-chart-container.js) streams independently of the first. The
// primary pane is the one Opportunities and the Moonshot Radar mount; its toolbar
// carries [⬍ Dual Chart]. A pane's host node is handed back on every re-render, so
// its canvas survives. mount() returns null if the library failed to load (offline),
// and the view falls back to the static level chart.
// Phase 70C: the price scale fits the CANDLES (components/chart-levels.js: level lines far from the
// price get rail badges instead of flattening the candles); [⤢ Fit] snaps back to that view at the
// default bar width, [⇕ Levels] fits every level line.
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
  // Phase 68: the scale keeps >= 4 significant digits for sub-cent coins (SD.ui.decimalsFor), and
  // minMove matches it so the axis ticks never collapse onto one rounded value.
  const priceFormat = (p) => { const precision = SD.ui.decimalsFor(p); return { type: 'price', precision, minMove: Number((10 ** -precision).toFixed(precision)) }; };
  const volBar = (b) => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? 'rgba(38, 166, 154, 0.35)' : 'rgba(239, 83, 80, 0.35)' });

  // Level lines (Phase 58C), shared switch: the charted setup's, else the overlay (an open position
  // or an after-hours options plan): components/chart-levels.js. Each pane has its own switch
  // (Phase 64: Chart 2's [Lines] never touches Chart 1), remembered per device.
  const readLevels = (key) => { try { return localStorage.getItem(key) !== 'off'; } catch { return true; } };
  const panes = new Set();
  const LV = SD.chartLevels;
  const BAR_SPACING = 8; // px per candle at the default zoom ([⤢ Fit] returns here)

  // One chart pane. opts: { tf, extraTools: () => [nodes] for its toolbar, levelsKey: its [Lines] storage key }.
  function makeChart(paneOpts = {}) {
    const levelsKey = paneOpts.levelsKey || 'signaldesk.chartLevels';
    let levelsOn = readLevels(levelsKey);
    let tf = paneOpts.tf || '15m';
    let follow = true;
    let view = null;
    let scaleMode = 'candles'; // 'candles' (default) | 'levels' (every level line on screen)

    function toolbar() {
      const tfs = el('div', { className: 'lwc-tfs', role: 'group' }, TIMEFRAMES.map(([key, label]) => {
        const b = el('button', { type: 'button', className: 'lwc-tf', textContent: label, dataset: { tf: key } });
        b.onclick = () => { tf = key; D.loadHistory(view.o.asset, tf); paint(); };
        return b;
      }));
      const followBox = el('input', { type: 'checkbox', checked: follow });
      followBox.onchange = () => { follow = followBox.checked; view.chart.timeScale().applyOptions({ shiftVisibleRangeOnNewBar: follow }); if (follow) view.chart.timeScale().scrollToRealTime(); };
      const fitBtn = el('button', { type: 'button', className: 'lwc-tool', textContent: '⤢ Fit', title: 'Fit the candles (default zoom, latest bars); far level lines show as badges on the edges' });
      fitBtn.onclick = () => fitCandles();
      const lvBtn = el('button', { type: 'button', className: 'lwc-tool lwc-levels', textContent: '⇕ Levels', title: 'Fit every level line (entry, stop, targets, breakeven) on the price scale' });
      lvBtn.onclick = () => setScale(scaleMode === 'levels' ? 'candles' : 'levels');
      const full = el('button', { type: 'button', className: 'lwc-tool', textContent: '⛶', title: 'Full screen' });
      full.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : view.host.requestFullscreen && view.host.requestFullscreen());
      return el('div', { className: 'lwc-bar' }, [tfs, el('label', { className: 'lwc-tool lwc-follow' }, [followBox, 'Follow price']), fitBtn, lvBtn, full, ...(paneOpts.extraTools ? paneOpts.extraTools() : [])]);
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
          borderColor: css('--border', '#1f2a3c'), timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: BAR_SPACING, shiftVisibleRangeOnNewBar: follow,
          tickMarkFormatter: (t, type) => (type < 3 ? localTime(t, { month: 'short', day: 'numeric' }) : localTime(t, { hour: '2-digit', minute: '2-digit' })),
        },
        crosshair: { mode: LWC.CrosshairMode.Normal },
      });
      const volume = chart.addSeries(LWC.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      const series = chart.addSeries(LWC.CandlestickSeries, {
        upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false,
        autoscaleInfoProvider: (original) => LV.range(original(), (view && view.levels) || [], scaleMode), // candles first (70C)
      });
      chart.timeScale().subscribeVisibleLogicalRangeChange(() => rails());
      new ResizeObserver(() => fit()).observe(canvas);
      // Toolbar height (it wraps to 2+ rows when narrow): the trade HUD floats under it (Phase 61).
      const bar = host.firstChild;
      new ResizeObserver(() => { if (view && bar.offsetHeight) { view.barH = bar.offsetHeight; const w = host.closest('.opp-chart-wrap'); if (w) w.style.setProperty('--lwc-bar-h', `${view.barH}px`); } }).observe(bar);
      return { host, box, canvas, note, banner, chart, series, volume, o: null, opts: {}, shown: '', histRef: null, lastTime: 0, levelsKey: '', lines: [], levels: [], specs: [] };
    }

    // [⤢ Fit]: the candle view (default bar width, latest bars, scale on the candles).
    function fitCandles() {
      scaleMode = 'candles';
      view.chart.priceScale('right').applyOptions({ autoScale: true });
      view.chart.timeScale().applyOptions({ barSpacing: BAR_SPACING });
      view.chart.timeScale().scrollToRealTime();
      markMode();
    }
    function setScale(mode) {
      scaleMode = mode;
      view.chart.priceScale('right').applyOptions({ autoScale: true });
      markMode();
    }
    function markMode() {
      const b = view.host.querySelector('.lwc-levels');
      if (b) b.classList.toggle('is-active', scaleMode === 'levels');
      rails();
    }
    // Off-scale level badges, once per frame (after the chart has laid the new scale out).
    let railsQueued = false;
    function rails() {
      if (railsQueued || !view) return;
      railsQueued = true;
      requestAnimationFrame(() => requestAnimationFrame(() => { railsQueued = false; if (view && view.o) LV.badges(view, () => setScale('levels')); }));
    }

    // Re-renders detach and re-attach the host; the first layout can happen while hidden.
    function fit() {
      if (!view) return;
      const w = view.canvas.clientWidth; const h = view.canvas.clientHeight;
      if (w > 0 && h > 0 && (w !== view.w || h !== view.h)) { view.w = w; view.h = h; view.chart.resize(w, h); }
    }

    function setLevels() {
      const specs = LV.specsFor(view.o, view.opts.withLevels, view.opts.overlay, levelsOn);
      const key = JSON.stringify(specs);
      if (key === view.levelsKey) return;
      view.levelsKey = key;
      for (const line of view.lines) view.series.removePriceLine(line);
      view.lines = specs.map((s) => view.series.createPriceLine({ price: s.price, color: s.color, title: s.title, lineWidth: s.style === 0 ? 2 : 1, lineStyle: s.style ?? 2, axisLabelVisible: true }));
      view.levels = specs.map((s) => s.price);
      view.specs = specs;
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
      view.lastClose = last ? last.close : 0;
      rails();
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
      announce(); // Phase 68: the server streams this symbol's ticks every second
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
      ticked: (symbols) => { if (view && view.o && symbols.includes(view.o.asset)) sync(view.o.asset); }, // Phase 68: 1 s ticks (candles only)
      relevel: () => { if (view && view.o) { view.levelsKey = ''; paint(); view.chart.priceScale('right').applyOptions({ autoScale: true }); } },
      levelsVisible: () => levelsOn,
      setLevelsVisible: (on) => {
        levelsOn = !!on;
        try { localStorage.setItem(levelsKey, on ? 'on' : 'off'); } catch { /* this session only */ }
        pane.relevel();
      },
    };
    panes.add(pane);
    return pane;
  }

  D.onLoaded((symbol, frame) => { for (const p of panes) p.loaded(symbol, frame); });

  // Phase 68: WATCH_SYMBOLS = every pane's symbol, sent when it changes (force: after a reconnect);
  // TICKS { prices } (every second) extend the forming candles of the panes showing them.
  let announced = '';
  function announce(force = false) {
    const symbols = [...new Set([...panes].map((p) => p.showing()).filter(Boolean))].sort();
    const key = symbols.join(',');
    if ((force || key !== announced) && SD.app && SD.app.isOnline()) { announced = key; SD.app.send({ type: 'WATCH_SYMBOLS', symbols }); }
  }
  function tick(prices) {
    const symbols = Object.keys(prices || {});
    if (!symbols.length) return;
    D.record(prices);
    for (const p of panes) p.ticked(symbols);
  }

  // The primary pane (Opportunities center, Moonshot Radar): its toolbar has [⬍ Dual Chart].
  const primary = makeChart({ extraTools: () => (SD.dualChart ? [SD.dualChart.toggleButton()] : []) });
  SD.liveChart = { record: D.record, mount: primary.mount, stats: primary.stats, setTimeframe: primary.setTimeframe, primary,
    setLevelsVisible: primary.setLevelsVisible, levelsVisible: primary.levelsVisible, levelsOf: LV.levelsOf, create: makeChart, announce, tick };
})();
