// AI Trade Analyst facts (Phase 84): what the model is told, built on the SERVER from the ledger and live marks (never
// trusted from the browser), compact (< ~3 KB) and free of secrets / account ids.
//   PRE_TRADE  a staged setup (pending order): asset, class, strategy, trigger, entry / stop / T1 / T2, size and risk vs
//              the budget, cost quality (crypto bid / ask spread + fee drag; options net bid / ask of the package), the
//              thesis, scheduled events inside the hold, news sentiment + recent headlines, the US equity / crypto tape
//   IN_TRADE   an open position: + opened at / hold time, live price vs fill and stop, unrealized gross / net / fees,
//              the R-multiple now, options DTE / spread value now vs stop / target values, a held late-day exit, the
//              Moonshot entry score vs the radar now
const ledger = () => require('../execution/paper-ledger');
const LABELS = () => require('../strategies/strategy-toggles').LABELS;
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);
const pctOf = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : null);
const trim = (s, n) => (s ? String(s).replace(/\s+/g, ' ').slice(0, n) : null);
const DAY = 864e5;

function strategyName(o) {
  const id = String(o.strategyId || '');
  return LABELS()[id] || (id.startsWith('manual') || String(o.id).startsWith('manual:') ? 'Manual trade' : id === 'portfolio-pilot' ? 'Portfolio Pilot' : id || 'unknown');
}

function optionFacts(o, now) {
  const od = o.optionsData;
  if (o.market !== 'options' || !od) return null;
  const w = require('../risk/option-spread-width').spreadWidth(od);
  const exp = od.expiration ? Date.parse(`${od.expiration}T20:00:00Z`) : null;
  return { label: od.label || null, structure: od.structure || null, type: od.type || null, expiration: od.expiration || null, dte: exp ? Math.max(0, Math.round((exp - now) / DAY)) : null,
    legs: (od.legs || []).map((l) => `${l.side} ${l.ratio || 1}x ${l.type || od.type || ''} ${l.strike ?? ''}`.trim()), width: od.width ?? null, debitPaid: r2(od.debit),
    netBidAsk: w ? { bid: r2(w.bid), ask: r2(w.ask), mid: r2(w.mid), widthPctOfMid: pctOf(w.pct) } : null, stopValue: r2(od.exitRule && od.exitRule.stopValue),
    targetValue: r2(od.exitRule && od.exitRule.targetValue), iv: r4(od.iv), netGreeks: od.stats && od.stats.greeks ? od.stats.greeks : null };
}

function cryptoCost(o) {
  if (o.market !== 'crypto') return null;
  const q = require('../risk/break-even').liveQuote(o.brokerProduct || o.asset, Date.now());
  return { venue: o.routeVenue || o.venue || o.broker || null, bid: q ? q.bid : null, ask: q ? q.ask : null, spreadPct: q && q.ask > q.bid && q.bid > 0 ? pctOf((q.ask - q.bid) / ((q.ask + q.bid) / 2)) : null };
}

function market() {
  try {
    const ctx = require('../intelligence/dashboard-intel').buildIntelligence().context;
    const list = Array.isArray(ctx) ? ctx : Object.values(ctx || {});
    return list.filter((x) => x && x.asset).map((x) => ({ asset: x.asset, trend: x.trend, change: pctOf(x.changePct), basis: x.basis, breadth: x.breadth || null }));
  } catch { return []; }
}

// Recent headlines for the symbol (cached reads only: an analysis never waits on a slow news source).
async function headlines(symbol, since = 0) {
  try {
    const n = await Promise.race([require('../data/news-feed').newsFor(symbol, true), new Promise((r) => { setTimeout(() => r({ items: [] }), 3000).unref(); })]);
    return (n.items || []).filter((x) => x.title && (!x.at || x.at >= since)).slice(0, 5)
      .map((x) => ({ title: trim(x.title, 180), outlet: x.outlet || x.source || null, hoursAgo: x.at ? Math.round((Date.now() - x.at) / 36e5) : null }));
  } catch { return []; }
}

function common(o) {
  const t = o.targets || [];
  return { asset: o.asset, assetClass: o.market, account: o.execution === 'LIVE' || (o.sizingBasis && o.sizingBasis !== 'paper') ? 'LIVE (real money)' : 'PAPER (simulated)',
    strategy: strategyName(o), setup: trim(o.setupType, 80), direction: o.direction, timeframe: o.timeframe || null, expectedHold: trim(o.expectedDuration, 120),
    stop: o.invalidation ?? null, target1: t[0] ? t[0].price : null, target2: t[1] ? t[1].price : null, size: o.positionSize, notional: r2(o.notional),
    risk: { dollarRisk: r2(o.dollarRisk), pctOfBankroll: o.sizingBankroll > 0 ? pctOf(o.dollarRisk / o.sizingBankroll) : null, budgetPct: pctOf(o.riskPct),
      t1NetRewardToRisk: r2(o.t1NetRR), feeDragR: r2(o.feeDrag), estimatedFees: r2(o.estimatedFees) },
    thesis: trim(o.entryReason || o.thesis, 700), confirmation: (o.confirmationCriteria || []).slice(0, 4).map((c) => trim(c, 200)),
    catalyst: o.catalyst ? trim(o.catalyst.headline, 160) : null, scheduledEventsInHold: (o.catalysts || []).slice(0, 4).map((c) => `${c.type} ${c.date}${c.time ? ` ${c.time}` : ''}: ${trim(c.title, 100)}`),
    newsSentiment: o.newsSentiment ? `${o.newsSentiment.score}/100 ${o.newsSentiment.label}` : null };
}

// -> { ok, facts } | { ok: false, error }
async function preTrade(id, now = Date.now()) {
  const o = ledger().getPendingOrders().find((x) => x.id === id);
  if (!o) return { ok: false, error: 'That setup is no longer waiting in Approvals (approved, dismissed or expired).' };
  const facts = { mode: 'PRE_TRADE', ...common(o), entry: { zoneLow: o.entryZone && o.entryZone.min, zoneHigh: o.entryZone && o.entryZone.max, sizedAt: o.entryPrice },
    options: optionFacts(o, now), cryptoCosts: cryptoCost(o), approvalExpiresInMin: o.expiresAt ? Math.max(0, Math.round((o.expiresAt - now) / 60000)) : null,
    headlines: await headlines(o.asset, now - 2 * DAY), market: market() };
  return { ok: true, facts };
}

async function inTrade(id, now = Date.now()) {
  const p = ledger().getActivePositions().find((x) => x.id === id);
  if (!p) return { ok: false, error: 'That position is no longer open.' };
  const prices = require('../market/latest-prices');
  const px = prices.getLatestPrice(p.asset) || prices.getMarkPrice(p.asset) || null;
  const q = p.exitQuote || (px ? require('../execution/exit-quote').quote(p, px, 'stop', now) : null);
  const net = q && Number.isFinite(q.net) ? q.net : null;
  const stopDist = px && p.invalidation ? (p.direction === 'short' ? p.invalidation - px : px - p.invalidation) : null;
  const perUnitR = p.dollarRisk > 0 && p.positionSize > 0 && p.market !== 'options' ? p.dollarRisk / p.positionSize : null;
  const om = p.optionMark || null;
  const radar = p.strategyId === 'speculative-crypto' ? require('../intelligence/moonshot-radar').rowOf(p.asset) : null;
  const facts = { mode: 'IN_TRADE', ...common(p), openedAt: p.openedAt ? new Date(p.openedAt).toISOString() : null, holdHours: p.openedAt ? r2((now - p.openedAt) / 36e5) : null,
    fillPrice: p.fillPrice, currentPrice: px, initialStop: p.initialStop ?? null, stopNow: p.invalidation, t1AlreadyTaken: !!p.t1Filled,
    distanceToStop: stopDist !== null ? { price: r4(stopDist), pctOfPrice: px ? pctOf(stopDist / px) : null, inR: perUnitR ? r2(stopDist / perUnitR) : null } : null,
    unrealized: q ? { gross: r2(q.gross), fees: r2(q.fees), net: r2(net) } : null, rMultipleNow: net !== null && p.dollarRisk > 0 ? r2(net / p.dollarRisk) : null,
    options: optionFacts(p, now), optionValueNow: om ? { value: r2(om.value), mid: r2(om.mid), basis: om.basis } : null,
    heldLateDayExit: p.deferredExit ? `${p.deferredExit.reason} hit after the 3:45 PM cutoff; executes 9:35 AM ET` : null,
    moonshotScore: p.entrySnapshot || radar ? { atEntry: p.entrySnapshot ? p.entrySnapshot.score : p.convictionScore ?? null, now: radar ? radar.score : null } : null,
    headlinesSinceEntry: await headlines(p.asset, p.openedAt || now - DAY), market: market() };
  return { ok: true, facts };
}

const build = (mode, id, now) => (mode === 'PRE_TRADE' ? preTrade(id, now) : inTrade(id, now));

module.exports = { build, preTrade, inTrade, common, optionFacts, strategyName };
