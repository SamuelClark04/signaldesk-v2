// Opportunities center chart: TradingView Lightweight Charts candlesticks.
// There is no bars endpoint yet, so the history behind the live candles is
// SYNTHETIC (a seeded random walk ending at the first real price) and the chart
// says so. Candles from page load onward are built from real PRICES_UPDATED
// ticks (1-minute buckets). One chart instance is reused across re-renders:
// its host node is handed back to the view each time, so the canvas survives.
// Exposes window.SignalDesk.liveChart. mount() returns null if the library
// failed to load (offline), and the view falls back to the static level chart.
(() => {
  const SD = window.SignalDesk;
  const { el, price } = SD.ui;

  const BAR_SEC = 60;
  const HISTORY_BARS = 80;
  const MAX_LIVE_BARS = 600;
  const UP = '#26a69a';
  const DOWN = '#ef5350';

  const live = new Map(); // symbol -> real 1m bars from ticks, oldest first
  const synth = new Map(); // symbol -> { bars, anchoredLive }
  let view = null; // { host, note, chart, series, symbol, synthRef, shownLive, levelsKey, lines, levels }

  // ---------- Real candles from ticks (called for every PRICES_UPDATED) ----------
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

  // ---------- Synthetic history (placeholder until a bars endpoint exists) ----------
  function seeded(symbol) {
    let s = [...symbol].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;
    return () => { // mulberry32
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Walks backward from the anchor so the last synthetic close meets the first real price.
  function makeHistory(symbol, market, endTime, endPrice) {
    const rand = seeded(symbol);
    const vol = market === 'crypto' ? 0.0012 : 0.0008;
    const gauss = () => (rand() + rand() + rand() - 1.5) * 1.4;
    const bars = [];
    let close = endPrice;
    for (let i = 1; i <= HISTORY_BARS; i += 1) {
      const open = close * (1 + vol * gauss());
      const wick = () => vol * Math.abs(gauss()) * 0.6;
      bars.unshift({
        time: endTime - i * BAR_SEC, open, close,
        high: Math.max(open, close) * (1 + wick()), low: Math.min(open, close) * (1 - wick()),
      });
      close = open;
    }
    return bars;
  }

  // History is regenerated once, when the first real price arrives, if it was
  // first anchored on the setup's entry price (no feed yet).
  function history(o, fallbackPrice) {
    const bars = live.get(o.asset) || [];
    const current = synth.get(o.asset);
    if (current && (current.anchoredLive || !bars.length)) return current;
    const first = bars[0];
    const anchor = first ? first.open : fallbackPrice;
    if (!(anchor > 0)) return null;
    const end = first ? first.time : Math.floor(Date.now() / 1000 / BAR_SEC) * BAR_SEC + BAR_SEC;
    const next = { bars: makeHistory(o.asset, o.market, end, anchor), anchoredLive: !!first };
    synth.set(o.asset, next);
    return next;
  }

  // ---------- Chart instance ----------
  function css(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

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
      timeScale: { borderColor: css('--border', '#1f2a3c'), timeVisible: true, secondsVisible: false, rightOffset: 4 },
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
    return { host, canvas, note, banner, chart, series, symbol: null, synthRef: null, shownLive: 0, levelsKey: '', lines: [], levels: [] };
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

  // Pushes new or changed data: full reload on symbol/history change, else
  // series.update() for the live candle(s) that moved since the last render.
  function sync(o, anchorPrice) {
    const hist = history(o, anchorPrice);
    const bars = live.get(o.asset) || [];
    const lastPrice = bars.length ? bars[bars.length - 1].close : anchorPrice;
    if (view.symbol !== o.asset || view.synthRef !== hist) {
      if (lastPrice > 0) view.series.applyOptions({ priceFormat: priceFormat(lastPrice) });
      view.series.setData([...(hist ? hist.bars : []), ...bars].map((b) => ({ ...b })));
      // Full reload: scroll to the newest bar once the host is on screen and sized.
      requestAnimationFrame(() => requestAnimationFrame(() => view.chart.timeScale().scrollToRealTime()));
      view.symbol = o.asset;
      view.synthRef = hist;
      view.shownLive = bars.length;
      return;
    }
    // A capped buffer drops old bars from the front; resume from the last one shown.
    for (let i = Math.max(0, Math.min(view.shownLive, bars.length) - 1); i < bars.length; i += 1) view.series.update({ ...bars[i] });
    view.shownLive = bars.length;
  }

  // o: pending order or Market Watch object; withLevels: draw its levels.
  function mount(o, { withLevels, banner = '' } = {}) {
    if (!window.LightweightCharts) return null;
    if (!view) view = create();
    const anchor = o.entryPrice || (o.entryZone && o.entryZone.max) || 0;
    // Price lines first: the autoscale provider reads view.levels.
    setLevels(o, withLevels);
    sync(o, anchor);

    const bars = live.get(o.asset) || [];
    const since = bars.length ? new Date(bars[0].time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
    view.note.textContent = since
      ? `Placeholder history (synthetic) · live 1m candles since ${since}`
      : view.synthRef ? 'Placeholder history (synthetic) · waiting for a live price' : 'No price yet for this symbol';
    view.banner.textContent = banner;
    view.banner.hidden = !banner;
    requestAnimationFrame(fit);
    const last = bars.length ? bars[bars.length - 1].close : 0;
    view.host.setAttribute('aria-label', `${o.asset} candlestick chart${last > 0 ? `, last ${price(last, o)}` : ''}`);
    view.host.setAttribute('role', 'img');
    return view.host;
  }

  SD.liveChart = { record, mount };
})();
