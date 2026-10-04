// Strategy 7: Options QUICK FLIPS (Phase 89), intraday single calls / puts on SPY and QQQ, PAPER ONLY. Off by default
// (strategy-toggles: its replay did not pass the frozen test, docs/research/phase89-results.md); on = forward paper testing.
// PROPOSER ONLY: returns Canonical Candidates; the pipeline sizes / gates / stages them, the user approves.
//   Signals    quickflips-signals.js (S1 ORB + VWAP; S2 is off: it lost in every development variant), on the latest
//              completed 5-minute bar, from the decision minute (bar end + 60 s) for up to SIGNAL_TTL_MS (the approval window)
//   Data       today's IEX 1-minute bars (the stream); prior 30 days of IEX 5-minute bars (EMA20 + the 20-session RelVol
//              baseline, once a day). A session missing > 5% of its minutes so far (a restart: the stream has no backfill) is skipped
//   Contract   3-7 calendar DTE, the expiration closest to 5 (ties shorter), never 0-2 DTE; call = highest $1 strike <= spot,
//              put = lowest >= spot; a FRESH two-sided quote (<= QUOTE_MAX_AGE_MS), bid >= $0.50, bid / ask within 5% of mid
//   Order      debit = the natural ask; entry order times out after ENTRY_TIMEOUT_MS (canceled, never chased)
//   Exits      premium stop -30% (2 confirmations), target +45% (a resting limit at Alpaca Paper), setup failure (5m close back
//              through VWAP), 60 min max hold, 3:40 PM deadline: execution/quickflip-exits.js. Same day, always.
// The one exception to the user's "nothing closes on time" rule, for this mode only.
const alpacaStocks = require('../connectors/alpaca-stock-socket');
const options = require('../connectors/options-data');
const history = require('../backtest/history');
const et = require('../services/et-time');
const sig = require('./quickflips-signals');
const { createTally } = require('./scan-tally');
const { pace } = require('../execution/loop-pace');

const STRATEGY_ID = 'options-quickflips';
const CONFIG = {
  symbols: ['SPY', 'QQQ'], setups: ['S1'], stopPct: 0.30, targetPct: 0.45, maxHoldMin: 60, deadlineMin: 15 * 60 + 40,
  dte: { min: 3, max: 7, prefer: 5 }, minBid: 0.5, maxSpreadPct: 0.05, minSessionShare: 0.95, priorDays: 30,
  SIGNAL_TTL_MS: 3 * 60 * 1000, ENTRY_TIMEOUT_MS: 3 * 60 * 1000, QUOTE_MAX_AGE_MS: 30 * 1000, multiplier: 100,
};
const tally = createTally();
const prior = new Map(); // symbol -> { day, sessions }
const proposed = new Set(); // signal keys already proposed
let blocks = [];
const cents = (x) => Math.round(x * 100) / 100;
const lookup = (src, key) => (src instanceof Map ? src.get(key) : src && src[key]);
const settingsNow = () => { try { return require('../execution/ledger-store').getSettings(); } catch { return {}; } };

// The prior sessions' 5-minute bars (IEX, once per New York day). null: unavailable (no signal today until it loads).
async function priorFor(symbol, now) {
  const day = et.ymd(now);
  const hit = prior.get(symbol);
  if (hit && hit.day === day) return hit.sessions;
  const r = await history.load([symbol], '5m', 'stocks', CONFIG.priorDays + 5, et.dayStart(now));
  if (!r.ok || !r.series[symbol]) return null;
  const sessions = sig.priorSessions(r.series[symbol], et.parts).filter((s) => s.ymd < day);
  prior.set(symbol, { day, sessions });
  return sessions;
}

// Today's regular-session minute slots from the stream's buffer.
function todaySlots(symbol, now) {
  const day = et.ymd(now);
  const list = (lookup(alpacaStocks.getLatestBars(), symbol) || []).map((b) => {
    const ms = typeof b.time === 'number' ? b.time * (b.time < 1e12 ? 1000 : 1) : Date.parse(b.time);
    const p = et.parts(ms);
    return p.ymd === day ? { min: p.h * 60 + p.m, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume } : null;
  }).filter(Boolean);
  return sig.slots(list);
}

// The contract for a decision, with a FRESH quote. -> { contract, quote } | { reason }
async function pickContract(symbol, dir, spot, now) {
  const type = dir === 'long' ? 'call' : 'put';
  const strike = type === 'call' ? Math.floor(spot) : Math.ceil(spot);
  const chain = await options.getChain(symbol, { type, minDte: CONFIG.dte.min, maxDte: CONFIG.dte.max, strikeMin: strike - 1, strikeMax: strike + 1, spot }, now);
  if (!chain.ok) return { reason: `OPTIONS_CHAIN_UNAVAILABLE: ${chain.error}` };
  const at = chain.contracts.filter((c) => c.type === type && Math.abs(c.strike - strike) < 1e-6 && c.dte >= CONFIG.dte.min && c.dte <= CONFIG.dte.max)
    .sort((a, b) => Math.abs(a.dte - CONFIG.dte.prefer) - Math.abs(b.dte - CONFIG.dte.prefer) || a.dte - b.dte);
  if (!at.length) return { reason: `QUICKFLIPS_NO_CONTRACT: no ${symbol} ${strike} ${type} expiring in ${CONFIG.dte.min}-${CONFIG.dte.max} days` };
  const c = at[0];
  await options.refreshQuotes([c.symbol], now, () => spot, 10 * 1000);
  const q = options.freshQuote(c.symbol, CONFIG.QUOTE_MAX_AGE_MS, now);
  if (!q) return { reason: `QUICKFLIPS_STALE_QUOTE: no ${c.symbol} quote newer than ${CONFIG.QUOTE_MAX_AGE_MS / 1000} s` };
  const mid = (q.bid + q.ask) / 2;
  if (!(q.bid >= CONFIG.minBid) || !(q.ask > q.bid)) return { reason: `QUICKFLIPS_ILLIQUID: ${c.symbol} bid ${q.bid} / ask ${q.ask}` };
  if ((q.ask - q.bid) / mid > CONFIG.maxSpreadPct) return { reason: `QUICKFLIPS_SPREAD_TOO_WIDE: ${c.symbol} ${q.bid} / ${q.ask} is ${(((q.ask - q.bid) / mid) * 100).toFixed(1)}% of mid (max ${CONFIG.maxSpreadPct * 100}%)` };
  return { contract: c, quote: q, mid };
}

function candidate(symbol, s, pick, now, feed) {
  const { contract: c, quote: q, mid } = pick;
  const type = s.dir === 'long' ? 'call' : 'put';
  const debit = cents(q.ask);
  const stopValue = cents(debit * (1 - CONFIG.stopPct));
  const targetValue = cents(debit * (1 + CONFIG.targetPct));
  const id = `${STRATEGY_ID}:${s.setup}:${type.toUpperCase()}:${symbol}:${et.ymd(now)}:${s.endMin}`;
  const label = `${symbol} ${c.expiration} ${c.strike} ${type}`;
  const zone = { min: cents(s.spot * 0.9985), max: cents(s.spot * 1.0015) };
  const move = Math.abs(s.spot - s.vwap);
  return {
    id, asset: symbol, market: 'options', strategyId: STRATEGY_ID, setupType: `Quick Flip · ${s.setup === 'S1' ? 'ORB + VWAP' : 'VWAP pullback'} ${type}`,
    direction: s.dir, timeframe: '5m', tradeType: 'Options Quick Flip', expectedDuration: `Minutes: ${CONFIG.maxHoldMin} min max, closed by 3:40 PM ET (same day)`,
    entryZone: zone, invalidation: cents(s.vwap), // the setup fails on a 5-minute close back through the session VWAP
    targets: [{ level: 1, price: cents(s.dir === 'long' ? s.spot + move : s.spot - move), allocation: 1 }],
    catalyst: { type: 'technical', headline: `${s.setup === 'S1' ? 'Opening-range breakout' : 'VWAP-trend pullback'} on the 5m close, RelVol ${s.relVol.toFixed(1)}x`, sentimentScore: 0 },
    thesis: `${symbol} ${s.dir === 'long' ? 'broke above' : 'broke below'} ${s.setup === 'S1' ? 'its 9:30-9:45 range' : 'its EMA20 in a VWAP trend'} (trigger ${cents(s.trigger)}, VWAP ${cents(s.vwap)}) `
      + `on ${s.relVol.toFixed(1)}x relative volume. Buy 1 ${label} (${c.dte} DTE) at the ask ${debit} (bid ${q.bid}, quote ${Math.round((now - q.quoteTime) / 1000)} s old, ${feed} feed). `
      + `Exits: premium ${stopValue} (-${CONFIG.stopPct * 100}%) or ${targetValue} (+${CONFIG.targetPct * 100}%), a 5-minute close back through VWAP, ${CONFIG.maxHoldMin} min, or 3:40 PM. `
      + 'PAPER ONLY. Not validated: the Phase 89 replay did not pass (forward paper test).',
    confirmationCriteria: [`5-minute close ${s.dir === 'long' ? 'above' : 'below'} the trigger ${cents(s.trigger)} and VWAP; still beyond it at the decision minute`,
      `Contract ${c.dte} DTE (3-7), fresh quote, bid/ask ${(((q.ask - q.bid) / mid) * 100).toFixed(1)}% of mid (max 5%)`, 'Same-day exit: stop / target / setup failure / 60 min / 3:40 PM'],
    timestamp: new Date(now).toISOString(),
    optionsData: {
      underlying: symbol, type, structure: 'single', fill: 'single', label, contract: c.symbol, strike: c.strike, expiration: c.expiration, dte: c.dte, feed,
      multiplier: CONFIG.multiplier, iv: c.iv, delta: q.delta ?? c.delta, bid: q.bid, ask: q.ask, debit, netMid: cents(mid), combinedLegSpread: cents(q.ask - q.bid),
      legs: [{ side: 'buy', type, strike: c.strike, ratio: 1, contract: c.symbol, bid: q.bid, ask: q.ask, iv: c.iv, delta: q.delta ?? c.delta }],
      riskPerShare: cents(debit - stopValue), exitRule: { stopValue, targetValue }, refSpot: s.spot, refAt: now, quoteTime: q.quoteTime,
      entryTimeoutMs: CONFIG.ENTRY_TIMEOUT_MS,
      quickFlip: { setup: s.setup, signalEndMin: s.endMin, trigger: cents(s.trigger), vwap: cents(s.vwap), maxHoldMin: CONFIG.maxHoldMin, deadlineMin: CONFIG.deadlineMin },
    },
  };
}

async function evaluate(symbol, now, fomc) {
  const today = todaySlots(symbol, now);
  const p = et.parts(now); const elapsed = Math.min(390, p.h * 60 + p.m - sig.OPEN_MIN);
  if (elapsed <= 0) return tally.skip(symbol, 'Before the open');
  const have = today.slice(0, elapsed).filter(Boolean).length;
  if (have < CONFIG.minSessionShare * elapsed) return tally.skip(symbol, `Session bars incomplete (${have}/${elapsed} minutes: after a restart the stream has no backfill)`);
  const past = await priorFor(symbol, now);
  if (!past || past.length < sig.CONFIG.relVolSessions) return tally.skip(symbol, 'Prior 20 sessions of 5-minute bars unavailable');
  const s = sig.build(past, today);
  const list = sig.detect(s, today, { fomc }).filter((x) => CONFIG.setups.includes(x.setup));
  const nowMin = p.h * 60 + p.m;
  const fresh = list.filter((x) => nowMin >= x.endMin + 1 && (now - et.toEpoch(et.ymd(now), Math.floor((x.endMin + 1) / 60), (x.endMin + 1) % 60)) <= CONFIG.SIGNAL_TTL_MS);
  const live = fresh.find((x) => !x.skip);
  if (!live) return tally.skip(symbol, fresh[0] ? fresh[0].skip : 'No Quick Flip setup on the latest 5-minute bar');
  const key = `${symbol}|${et.ymd(now)}|${live.endMin}|${live.dir}`;
  if (proposed.has(key)) return tally.skip(symbol, 'Already proposed');
  const pick = await pickContract(symbol, live.dir, live.spot, now);
  if (pick.reason) {
    blocks.push({ id: `${STRATEGY_ID}:${symbol}:${live.endMin}`, reason: pick.reason, candidate: { asset: symbol, market: 'options', strategyId: STRATEGY_ID, setupType: 'Quick Flip', direction: live.dir, timeframe: '5m' } });
    return tally.skip(symbol, `Rejected: ${pick.reason.split(':')[0].replace(/_/g, ' ').toLowerCase()}`);
  }
  proposed.add(key);
  return candidate(symbol, live, pick, now, options.feed());
}

// Only while the options book is on paper and the US session is open (the pipeline runs this every pass).
async function generateCandidates(now = Date.now(), settings = settingsNow()) {
  blocks = [];
  tally.start();
  const out = [];
  if (settings.stockMode === 'live') { for (const s of CONFIG.symbols) tally.skip(s, 'Paper only: the stock / options mode is LIVE'); return out; }
  if (!require('../market/market-session').isEquityMarketOpen(now)) { for (const s of CONFIG.symbols) tally.skip(s, 'US market closed'); return out; }
  const fomc = require('../connectors/macro-events').FOMC.includes(et.ymd(now));
  for (const symbol of CONFIG.symbols) {
    await pace();
    tally.checked();
    try { const c = await evaluate(symbol, now, fomc); if (c) { out.push(c); tally.setup(); } } catch (err) { console.error(`[quickflips] ${symbol} failed: ${err.message}`); }
  }
  return out;
}

function takeBlocks() { const b = blocks; blocks = []; return b; }
function reset() { prior.clear(); proposed.clear(); blocks = []; }

module.exports = { generateCandidates, takeBlocks, takeScan: tally.take, reset, pickContract, candidate, evaluate, STRATEGY_ID, CONFIG };
