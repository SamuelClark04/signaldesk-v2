// Opportunities center chart: TradingView Lightweight Charts candlesticks + volume.
// History: the last 100 real bars of the chosen timeframe from /api/history
// (Alpaca IEX for stocks, Coinbase for crypto). The forming candle is updated
// from real PRICES_UPDATED ticks (kept as 1m bars, folded into the timeframe).
// One chart instance (with its toolbar) is reused across re-renders: its host
// node is handed back to the view each time, so the canvas survives.
// Exposes window.SignalDesk.liveChart. mount() returns null if the library
// failed to load (offline), and the view falls back to the static level chart.
(() => {
  const SD = window.SignalDesk;
  const { el, price } = SD.ui;

  const TIMEFRAMES = [['1m', '1m', 60], ['5m', '5m', 300], ['15m', '15m', 900], ['1h', '1h', 3600], ['4h', '4h', 14400], ['1d', '1D', 86400]];
  const TF_SEC = Object.fromEntries(TIMEFRAMES.map(([k, , s]) => [k, s]));
  const MAX_LIVE_BARS = 600;
  const REFETCH_MS = 5 * 60 * 1000; // history older than this is refetched when shown again
  const UP = '#26a69a';
  const DOWN = '#ef5350';

  const live = new Map(); // symbol -> real 1m bars from ticks, oldest first
  const history = new Map(); // `${symbol}|${tf}` -> { status, bars, error, at }
  let tf = '15m';
  let follow = true;
  let view = null; // chart instance + what it currently shows

  // ---------- Live 1m candles from ticks (called for every PRICES_UPDATED) ----------
  function record(prices) {
    const bucket = Math.floor(Date.now() / 60000) * 60;
    for (const [symbol, p] of Object.entries(prices || {})) {
      if (!(p > 0)) continue;
      const bars = live.get(symbol) || [];
      const last = bars[bars.length - 1];
      if (last && last.time === bucket) {
        last.high = Math.max(last.high, p); last.low = Math.min(last.low, p); last.close = p;
      } else if (!last || last.time < bucket) {
        bars.push({ time: bucket, open: p, high: p, low: p, close: p });
        if (bars.length > MAX_LIVE_BARS) bars.shift();
      }
      live.set(symbol, bars);
    }
  }

  // ---------- Real history ----------
  function loadHistory(symbol, frame) {
    const key = `${symbol}|${frame}`;
    const current = history.get(key);
    const maxAge = current && current.status === 'error' ? 30000 : REFETCH_MS; // retry failures sooner
    if (current && (current.status === 'loading' || Date.now() - current.at < maxAge)) return;
    history.set(key, { bars: [], ...current, status: 'loading', at: Date.now() });
    SD.api.getJson(`/api/history/${encodeURIComponent(symbol)}?tf=${frame}`)
      .then((bars) => history.set(key, { status: 'ok', bars: (Array.isArray(bars) ? bars : []).filter((b) => b && Number.isFinite(b.time) && b.close > 0), at: Date.now() }))
      .catch((err) => history.set(key, { status: 'error', bars: [], error: err.message, at: Date.now() }))
      .finally(() => { if (view && view.o && view.o.asset === symbol && tf === frame) paint(); });
  }

  // History bars plus live 1m bars folded into the timeframe grid of the last
  // history bar. Live bars inside an already completed history bar are skipped.
  function mergedBars(symbol, frame) {
    const h = history.get(`${symbol}|${frame}`);
    const byTime = new Map(((h && h.bars) || []).map((b) => [b.time, { ...b }]));
    const lastHist = h && h.bars.length ? h.bars[h.bars.length - 1].time : null;
    const sec = TF_SEC[frame];
    for (const b of live.get(symbol) || []) {
      const t = lastHist === null ? Math.floor(b.time / sec) * sec : lastHist + Math.floor((b.time - lastHist) / sec) * sec;
      if (lastHist !== null && t < lastHist) continue;
      const cur = byTime.get(t);
      byTime.set(t, cur ? { ...cur, high: Math.max(cur.high, b.high), low: Math.min(cur.low, b.low), close: b.close } : { ...b, time: t });
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  // ---------- Chart instance ----------
  function css(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }
  const localTime = (t, opts) => new Date(t * 1000).toLocaleString([], opts);

  function toolbar() {
    const tfs = el('div', { className: 'lwc-tfs', role: 'group' }, TIMEFRAMES.map(([key, label]) => {
      const b = el('button', { type: 'button', className: 'lwc-tf', textContent: label, dataset: { tf: key } });
      b.onclick = () => { tf = key; loadHistory(view.o.asset, tf); paint(); };
      return b;
    }));
    const followBox = el('input', { type: 'checkbox', checked: follow });
    followBox.onchange = () => { follow = followBox.checked; view.chart.timeScale().applyOptions({ shiftVisibleRangeOnNewBar: follow }); if (follow) view.chart.timeScale().scrollToRealTime(); };
    const fitBtn = el('button', { type: 'button', className: 'lwc-tool', textContent: '⤢ Fit', title: 'Fit all bars' });
    fitBtn.onclick = () => view.chart.timeScale().fitContent();
    const full = el('button', { type: 'button', className: 'lwc-tool', textContent: '⛶', title: 'Full screen' });
    full.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : view.host.requestFullscreen && view.host.requestFullscreen());
    return el('div', { className: 'lwc-bar' }, [tfs, el('label', { className: 'lwc-tool lwc-follow' }, [followBox, 'Follow price']), fitBtn, full]);
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
      // Real bars carry real timestamps: show them in the viewer's local time, not UTC.
      localization: { timeFormatter: (t) => localTime(t, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) },
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
      // Keep every level line on screen even when price is far from it.
      autoscaleInfoProvider: (original) => {
        const res = original();
        const lv = (view && view.levels) || [];
        if (!res || !lv.length) return res;
        const { minValue, maxValue } = res.priceRange;
        return { ...res, priceRange: { minValue: Math.min(minValue, ...lv), maxValue: Math.max(maxValue, ...lv) } };
      },
    });
    new ResizeObserver(() => fit()).observe(canvas);
    return { host, box, canvas, note, banner, chart, series, volume, o: null, opts: {}, shown: '', histRef: null, lastTime: 0, levelsKey: '', lines: [], levels: [] };
  }

  // Matches the chart to its box. Re-renders detach and re-attach the host, and
  // the first layout can happen while the tab is hidden, so this also runs after mount.
  function fit() {
    if (!view) return;
    const w = view.canvas.clientWidth; const h = view.canvas.clientHeight;
    if (w > 0 && h > 0 && (w !== view.w || h !== view.h)) { view.w = w; view.h = h; view.chart.resize(w, h); }
  }

  function priceFormat(p) {
    const precision = p >= 10 ? 2 : p >= 0.1 ? 4 : 6;
    return { type: 'price', precision, minMove: 10 ** -precision };
  }

  // Entry band edges, stop and targets as price lines on the candle series.
  function setLevels(o, withLevels) {
    const t = o.targets || [];
    const specs = !withLevels ? [] : [
      { title: 'T2', price: t[1] && t[1].price, color: css('--long', '#2dd4bf') },
      { title: 'T1', price: t[0] && t[0].price, color: css('--long', '#2dd4bf') },
      { title: 'Entry', price: o.entryZone.max, color: css('--accent', '#38bdf8') },
      { title: 'Entry', price: o.entryZone.min !== o.entryZone.max ? o.entryZone.min : 0, color: css('--accent', '#38bdf8') },
      { title: 'Stop', price: o.invalidation, color: css('--short', '#fb7185') },
    ].filter((s) => s.price > 0);
    const key = JSON.stringify(specs);
    if (key === view.levelsKey) return;
    view.levelsKey = key;
    for (const line of view.lines) view.series.removePriceLine(line);
    view.lines = specs.map((s) => view.series.createPriceLine({ price: s.price, color: s.color, title: s.title, lineWidth: 1, lineStyle: 2, axisLabelVisible: true }));
    view.levels = specs.map((s) => s.price);
  }

  const volBar = (b) => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? 'rgba(38, 166, 154, 0.35)' : 'rgba(239, 83, 80, 0.35)' });

  // Full reload when the symbol, timeframe or history changes; otherwise update()
  // only the bars at or after the last one shown (the forming candle).
  function sync(symbol) {
    const h = history.get(`${symbol}|${tf}`);
    const data = mergedBars(symbol, tf);
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
    const h = history.get(`${o.asset}|${tf}`);
    const src = o.market === 'crypto' ? 'Coinbase' : 'Alpaca IEX';
    const label = TIMEFRAMES.find(([k]) => k === tf)[1];
    const tail = (live.get(o.asset) || []).length ? ' · live' : '';
    if (!h || h.status === 'loading') return h && h.bars.length ? `${label} candles · ${src} · refreshing…` : `Loading ${label} history from ${src}…`;
    if (h.status === 'error') return `History unavailable (${String(h.error).slice(0, 60)})${tail ? ' · live ticks only' : ''}`;
    return h.bars.length ? `${label} candles · ${src}${tail}` : `No recent history from ${src}${tail}`;
  }

  function paint() {
    const { o, opts } = view;
    setLevels(o, opts.withLevels); // price lines first: the autoscale provider reads view.levels
    sync(o.asset);
    view.note.textContent = noteText(o);
    view.banner.textContent = opts.banner || '';
    view.banner.hidden = !opts.banner;
    view.host.querySelectorAll('.lwc-tf').forEach((b) => b.classList.toggle('is-active', b.dataset.tf === tf));
    const bars = live.get(o.asset) || [];
    const last = bars.length ? bars[bars.length - 1].close : 0;
    view.box.setAttribute('aria-label', `${o.asset} candlestick chart${last > 0 ? `, last ${price(last, o)}` : ''}`);
  }

  // o: pending order or Market Watch object; withLevels: draw its levels.
  function mount(o, { withLevels, banner = '' } = {}) {
    if (!window.LightweightCharts) return null;
    if (!view) { view = create(); view.box.setAttribute('role', 'img'); }
    view.o = o;
    view.opts = { withLevels, banner };
    loadHistory(o.asset, tf); // no-op while fresh
    paint();
    requestAnimationFrame(fit);
    return view.host;
  }

  // High/low/first/last of what the chart shows (for the Price structure tab).
  function stats(symbol) {
    const h = history.get(`${symbol}|${tf}`);
    if (!h || !h.bars.length) return null; // live ticks alone are not a range
    const data = mergedBars(symbol, tf);
    return { tf: TIMEFRAMES.find(([k]) => k === tf)[1], bars: data.length, high: Math.max(...data.map((b) => b.high)), low: Math.min(...data.map((b) => b.low)),
      first: data[0], last: data[data.length - 1] };
  }

  // The Moonshot Radar opens a coin on its 5m candles (the user's toolbar pick wins afterwards).
  function setTimeframe(frame) { if (TF_SEC[frame]) tf = frame; }

  SD.liveChart = { record, mount, stats, setTimeframe };
})();
