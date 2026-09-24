// Live triggers for the Today "Watching" list: for every watched symbol, the
// NEAREST real trigger level to its current price, computed from live bars on
// every pipeline pass (no stored or hand-typed prices). Candidates:
//   20-day high breakout    daily bars: the highest high of the last 20 sessions
//   20-day SMA pullback     price above a rising SMA20 (SMA20 > SMA50): a dip to it
//   20-day SMA reclaim      price below the SMA20: a close back above it
//   session VWAP reclaim    stocks, today's 1-minute stream: price below VWAP
//   1h flush reclaim        crypto, 1-hour candles: price below the 20-bar 1h
//                           mean (after a flush of FLUSH_PCT+ under it)
//   strategy triggers       the strategies' own proximity() levels: ORB high
//                           (equity-day), 4h mean reclaim (crypto-swing), squeeze
//                           breakout (options-system)
// Output per symbol: { level, label, distancePct (level vs price, signed), source, price, at }.
// Read-only: daily bars are cached for hours (daily-bars.js), 1h candles here
// for HOUR_TTL_MS, so a 60 s pass never turns into a poll loop.
const { getDailyBars } = require('../connectors/daily-bars');
const { getHistory } = require('../connectors/history-bars');
const equityDay = require('../strategies/1-equity-day');
const cryptoSwing = require('../strategies/2-crypto-swing');
const optionsSystem = require('../strategies/5-options-system');

const HOUR_TTL_MS = 15 * 60 * 1000;
const FLUSH_PCT = 0.02;
const hourly = new Map(); // symbol -> { at, bars }

const decimals = (x) => (x >= 100 ? 2 : x >= 1 ? 4 : Math.min(10, 3 - Math.floor(Math.log10(x))));
const round = (x) => { const f = 10 ** decimals(x); return Math.round(x * f) / f; };
const sma = (bars, n) => bars.slice(-n).reduce((s, b) => s + b.close, 0) / n;
const lookup = (src, key) => (src instanceof Map ? src.get(key) : src && src[key]);
const etParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const et = (iso) => { const p = Object.fromEntries(etParts.formatToParts(new Date(iso)).map((x) => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) }; };

function dailyLevels(bars, price) {
  if (bars.length < 20) return [];
  const out = [];
  const high20 = Math.max(...bars.slice(-20).map((b) => b.high));
  const s20 = sma(bars, 20);
  const s50 = bars.length >= 50 ? sma(bars, 50) : null;
  if (price < high20) out.push({ level: high20, label: `Breakout above the 20-day high ${round(high20)}`, source: '20-day high' });
  if (price > s20 && (s50 === null || s20 > s50)) out.push({ level: s20, label: `Pullback to the 20-day SMA ${round(s20)}`, source: '20-day SMA' });
  if (price < s20) out.push({ level: s20, label: `Reclaim of the 20-day SMA ${round(s20)}`, source: '20-day SMA' });
  return out;
}

// Session VWAP from today's regular-session 1-minute bars (each carries its own vwap).
function sessionVwap(rawBars) {
  const bars = (rawBars || []).filter((b) => b && b.time && b.volume > 0).map((b) => ({ ...b, ...et(b.time) }));
  if (!bars.length) return null;
  const day = bars[bars.length - 1].date;
  const today = bars.filter((b) => b.date === day && b.minute >= 570 && b.minute < 960);
  const vol = today.reduce((s, b) => s + b.volume, 0);
  return vol > 0 ? today.reduce((s, b) => s + (b.vwap || b.close) * b.volume, 0) / vol : null;
}

async function hourlyBars(symbol, now) {
  const hit = hourly.get(symbol);
  if (hit && now - hit.at < HOUR_TTL_MS) return hit.bars;
  const r = await getHistory(symbol, '1h');
  const bars = r.ok ? r.bars.filter((b) => (b.time + 3600) * 1000 <= now) : (hit ? hit.bars : []);
  hourly.set(symbol, { at: now, bars });
  return bars;
}

function flushLevel(bars, price) {
  if (bars.length < 21) return null;
  const mean = sma(bars, 20);
  const low = Math.min(...bars.slice(-6).map((b) => b.low));
  if (!(price < mean)) return null;
  const flushed = low <= mean * (1 - FLUSH_PCT);
  return { level: mean, label: `Reclaim of the 1h 20-bar mean ${round(mean)}${flushed ? ` after a ${(((mean - low) / mean) * 100).toFixed(1)}% flush` : ''}`, source: '1h mean' };
}

// items: watchlist items ({ symbol, market, lastPrice }); latestPrices: fresh prices;
// stockBars: today's 1m bars per stock. -> { SYMBOL: trigger }.
async function computeTriggers(items, latestPrices, stockBars, now = Date.now()) {
  const strategy = [...equityDay.proximity(stockBars), ...cryptoSwing.proximity(latestPrices), ...optionsSystem.proximity(latestPrices)];
  const out = {};
  for (const item of items) {
    const { symbol } = item;
    const live = lookup(latestPrices, symbol);
    const price = live > 0 ? live : item.lastPrice;
    if (!(price > 0)) continue;
    try {
      const cands = [...dailyLevels(await getDailyBars(symbol, now), price)];
      if (item.market === 'crypto') { const f = flushLevel(await hourlyBars(symbol, now), price); if (f) cands.push(f); }
      else { const v = sessionVwap(lookup(stockBars, symbol)); if (v && price < v) cands.push({ level: v, label: `Reclaim of session VWAP ${round(v)}`, source: 'VWAP' }); }
      for (const p of strategy.filter((x) => x.symbol === symbol)) cands.push({ level: p.trigger, label: p.label, source: p.strategyId });
      const valid = cands.filter((c) => c.level > 0);
      if (!valid.length) continue;
      const best = valid.reduce((a, b) => (Math.abs(b.level - price) < Math.abs(a.level - price) ? b : a));
      out[symbol] = { ...best, level: round(best.level), distancePct: (best.level - price) / price, price, live: live > 0, at: now };
    } catch (err) {
      console.warn(`[watch-triggers] ${symbol}: ${err.message}`);
    }
  }
  return out;
}

module.exports = { computeTriggers, dailyLevels, sessionVwap, flushLevel };
