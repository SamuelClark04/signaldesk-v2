// Candle data shared by every chart pane (Phase 61: the primary chart and the Dual
// Chart's second pane read the same caches, so both stream from one tick feed).
//   live     real 1m bars built from PRICES_UPDATED ticks (record)
//   history  the last 100 real bars per symbol + timeframe from /api/history
//            (Alpaca IEX for stocks, Coinbase for crypto), refetched after REFETCH_MS
// mergedBars folds the live 1m bars into the timeframe grid of the last history bar.
// onLoaded(fn): called with (symbol, frame) whenever a history request settles.
// Exposes window.SignalDesk.chartData.
(() => {
  const SD = window.SignalDesk;

  const TIMEFRAMES = [['1m', '1m', 60], ['5m', '5m', 300], ['15m', '15m', 900], ['1h', '1h', 3600], ['4h', '4h', 14400], ['1d', '1D', 86400]];
  const TF_SEC = Object.fromEntries(TIMEFRAMES.map(([k, , s]) => [k, s]));
  const MAX_LIVE_BARS = 600;
  const REFETCH_MS = 5 * 60 * 1000;

  const live = new Map(); // symbol -> real 1m bars from ticks, oldest first
  const history = new Map(); // `${symbol}|${tf}` -> { status, bars, error, at }
  const listeners = new Set();

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

  function loadHistory(symbol, frame) {
    const key = `${symbol}|${frame}`;
    const current = history.get(key);
    const maxAge = current && current.status === 'error' ? 30000 : REFETCH_MS; // retry failures sooner
    if (current && (current.status === 'loading' || Date.now() - current.at < maxAge)) return;
    history.set(key, { bars: [], ...current, status: 'loading', at: Date.now() });
    SD.api.getJson(`/api/history/${encodeURIComponent(symbol)}?tf=${frame}`)
      .then((bars) => history.set(key, { status: 'ok', bars: (Array.isArray(bars) ? bars : []).filter((b) => b && Number.isFinite(b.time) && b.close > 0), at: Date.now() }))
      .catch((err) => history.set(key, { status: 'error', bars: [], error: err.message, at: Date.now() }))
      .finally(() => { for (const fn of listeners) fn(symbol, frame); });
  }

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

  SD.chartData = {
    TIMEFRAMES, TF_SEC, record, loadHistory, mergedBars,
    historyOf: (symbol, frame) => history.get(`${symbol}|${frame}`),
    liveBars: (symbol) => live.get(symbol) || [],
    onLoaded: (fn) => listeners.add(fn),
  };
})();
