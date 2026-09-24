// Opportunities center chart: TradingView Lightweight Charts candlesticks.
// History: the last 100 real 1-minute bars from /api/history/:symbol (Alpaca IEX
// for stocks, Coinbase for crypto), fetched when a symbol is first shown. The
// forming candle is then updated from real PRICES_UPDATED ticks (1m buckets).
// One chart instance is reused across re-renders: its host node is handed back
// to the view each time, so the canvas survives.
// Exposes window.SignalDesk.liveChart. mount() returns null if the library
// failed to load (offline), and the view falls back to the static level chart.
(() => {
  const SD = window.SignalDesk;
  const { el, price } = SD.ui;

  const BAR_SEC = 60;
  const MAX_LIVE_BARS = 600;
  const REFETCH_MS = 5 * 60 * 1000; // history older than this is refetched when the symbol is shown again
  const UP = '#26a69a';
  const DOWN = '#ef5350';

  const live = new Map(); // symbol -> real 1m bars from ticks, oldest first
  const history = new Map(); // symbol -> { status: 'loading'|'ok'|'error', bars, byTime, error, at }
  let view = null; // chart instance + what it currently shows

  // ---------- Live candles from ticks (called for every PRICES_UPDATED) ----------
  function record(prices) {
    const bucket = Math.floor(Date.now() / 1000 / BAR_SEC) * BAR_SEC;
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
  function loadHistory(symbol) {
    const current = history.get(symbol);
    const maxAge = current && current.status === 'error' ? 30000 : REFETCH_MS; // retry failures sooner
    if (current && (current.status === 'loading' || Date.now() - current.at < maxAge)) return;
    history.set(symbol, { ...(current || { bars: [], byTime: new Map() }), status: 'loading', at: Date.now() });
    SD.api.getJson(`/api/history/${encodeURIComponent(symbol)}?tf=1m`)
      .then((bars) => {
        const clean = (Array.isArray(bars) ? bars : []).filter((b) => b && Number.isFinite(b.time) && b.close > 0);
        history.set(symbol, { status: 'ok', bars: clean, byTime: new Map(clean.map((b) => [b.time, b])), at: Date.now() });
      })
      .catch((err) => history.set(symbol, { status: 'error', bars: [], byTime: new Map(), error: err.message, at: Date.now() }))
      .finally(() => { if (view && view.o && view.o.asset === symbol) paint(); });
  }

  // A live bar merged into the history bar of the same minute (history knows the true open/high/low).
  function mergeBar(h, b) {
    const hb = h && h.byTime.get(b.time);
    return hb ? { time: b.time, open: hb.open, high: Math.max(hb.high, b.high), low: Math.min(hb.low, b.low), close: b.close } : { ...b };
  }

  function mergedBars(symbol) {
    const h = history.get(symbol);
    const byTime = new Map(((h && h.bars) || []).map((b) => [b.time, { ...b }]));
    for (const b of live.get(symbol) || []) byTime.set(b.time, mergeBar(h, b));
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  // ---------- Chart instance ----------
  function css(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }
  const localTime = (t, opts) => new Date(t * 1000).toLocaleString([], opts);

  function create() {
    const LWC = window.LightweightCharts;
    const host = el('div', { className: 'opp-chart opp-lwc' });
    const canvas = el('div', { className: 'opp-lwc-canvas' });
    const note = el('div', { className: 'opp-chart-note' });
    const banner = el('div', { className: 'opp-watch-mode' });
    host.append(canvas, banner, note);
    const grid = 'rgba(148, 163, 184, 0.06)';
    const chart = LWC.createChart(canvas, {
      width: 0, height: 0, // sized by fit(): autoSize misses the first layout of a detached host
      layout: { background: { type: 'solid', color: css('--bg', '#0b1120') }, textColor: css('--text-muted', '#94a3b8'), fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: css('--border', '#1f2a3c') },
      // Real bars carry real timestamps: show them in the viewer's local time, not UTC.
      localization: { timeFormatter: (t) => localTime(t, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) },
      timeScale: {
        borderColor: css('--border', '#1f2a3c'), timeVisible: true, secondsVisible: false, rightOffset: 4,
        tickMarkFormatter: (t, type) => (type < 3 ? localTime(t, { month: 'short', day: 'numeric' }) : localTime(t, { hour: '2-digit', minute: '2-digit' })),
      },
      crosshair: { mode: LWC.CrosshairMode.Normal },
    });
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
    return { host, canvas, note, banner, chart, series, o: null, opts: {}, symbol: null, histRef: null, shownLive: 0, lastTime: 0, levelsKey: '', lines: [], levels: [] };
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
      { title: 'SL', price: o.invalidation, color: css('--short', '#fb7185') },
    ].filter((s) => s.price > 0);
    const key = JSON.stringify(specs);
    if (key === view.levelsKey) return;
    view.levelsKey = key;
    for (const line of view.lines) view.series.removePriceLine(line);
    view.lines = specs.map((s) => view.series.createPriceLine({
      price: s.price, color: s.color, title: s.title, lineWidth: 1, lineStyle: 2, axisLabelVisible: true,
    }));
    view.levels = specs.map((s) => s.price);
  }

  // Full reload on symbol or history change, else series.update() for the live
  // candle(s) that moved since the last paint.
  function sync(symbol) {
    const h = history.get(symbol);
    const bars = live.get(symbol) || [];
    let full = view.symbol !== symbol || view.histRef !== h;
    if (!full) {
      // A capped buffer drops old bars from the front; resume from the last one shown.
      for (let i = Math.max(0, Math.min(view.shownLive, bars.length) - 1); i < bars.length; i += 1) {
        const bar = mergeBar(h, bars[i]);
        if (bar.time < view.lastTime) { full = true; break; } // update() can't go back in time
        view.series.update(bar);
        view.lastTime = bar.time;
      }
    }
    if (full) {
      const data = mergedBars(symbol);
      const last = data[data.length - 1];
      if (last) view.series.applyOptions({ priceFormat: priceFormat(last.close) });
      view.series.setData(data);
      // Scroll to the newest bar once the host is on screen and sized.
      requestAnimationFrame(() => requestAnimationFrame(() => view.chart.timeScale().scrollToRealTime()));
      view.lastTime = last ? last.time : 0;
    }
    view.symbol = symbol;
    view.histRef = h;
    view.shownLive = bars.length;
  }

  function noteText(o) {
    const h = history.get(o.asset);
    const src = o.market === 'crypto' ? 'Coinbase' : 'Alpaca IEX';
    const hasLive = (live.get(o.asset) || []).length > 0;
    const tail = hasLive ? ' · live' : '';
    if (!h || h.status === 'loading') return h && h.bars.length ? `1m candles · ${src} · refreshing…` : `Loading 1m history from ${src}…`;
    if (h.status === 'error') return `History unavailable (${String(h.error).slice(0, 60)})${hasLive ? ' · live ticks only' : ''}`;
    return h.bars.length ? `1m candles · ${src}${tail}` : `No recent history from ${src}${tail}`;
  }

  function paint() {
    const { o, opts } = view;
    setLevels(o, opts.withLevels); // price lines first: the autoscale provider reads view.levels
    sync(o.asset);
    view.note.textContent = noteText(o);
    view.banner.textContent = opts.banner || '';
    view.banner.hidden = !opts.banner;
    const bars = live.get(o.asset) || [];
    const last = bars.length ? bars[bars.length - 1].close : 0;
    view.host.setAttribute('aria-label', `${o.asset} candlestick chart${last > 0 ? `, last ${price(last, o)}` : ''}`);
  }

  // o: pending order or Market Watch object; withLevels: draw its levels.
  function mount(o, { withLevels, banner = '' } = {}) {
    if (!window.LightweightCharts) return null;
    if (!view) { view = create(); view.host.setAttribute('role', 'img'); }
    view.o = o;
    view.opts = { withLevels, banner };
    if (view.symbol !== o.asset) loadHistory(o.asset);
    paint();
    requestAnimationFrame(fit);
    return view.host;
  }

  SD.liveChart = { record, mount };
})();
