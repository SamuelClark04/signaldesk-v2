// Entry shields (Phase 81): three checks on NEW entries only, at staging (pipeline) and again at approval (order-router,
// where a shielded setup stays pending). Never on exits: stops, targets, time exits and every close are untouched.
//   DAILY_LOSS_LIMIT_REACHED  risk/daily-loss.js tripped today (the whole book, paper + live)
//   MACRO_SHIELD_ACTIVE       services/macro-calendar.js blackout (30 min before .. 15 min after a high-impact USD
//                             release): stocks and options when settings.macroShield (default on); crypto too only with
//                             settings.macroShieldCrypto (default off)
//   SECTOR_CAP_REACHED        stocks / options: at most settings.maxTradesPerSector (default 1) trades per sector group
//                             (risk/sectors.js) open or staged in the same book (paper vs live, like portfolio-risk)
//   OPTIONS_SPREAD_TOO_WIDE   (Phase 82) an option position whose NET natural bid/ask (buy legs at ask / bid, sell legs at
//                             bid / ask, from the legs' quotes) is wider than 25% of its mid: it would lose that much
//                             getting in and out
// Manual Trade Ticket orders, Portfolio Pilot and adopted / external holdings are never blocked (the user's own call, and
// long-term allocations); open manual trades still occupy their sector.
const macro = require('../services/macro-calendar');
const dailyLoss = require('./daily-loss');
const et = require('../services/et-time');
const { sectorOf } = require('./sectors');
const { holding, sameBook, manualOrder } = require('./portfolio-risk');

const EQUITY = new Set(['stocks', 'options']);
const DEFAULT_SECTOR_MAX = 1;
const MAX_OPTION_SPREAD_PCT = 0.25;
const exempt = (o) => !o || manualOrder(o) || o.strategyId === 'portfolio-pilot' || holding(o);
const usd = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
const sectorMax = (settings = {}) => (settings.maxTradesPerSector >= 1 ? Math.floor(settings.maxTradesPerSector) : DEFAULT_SECTOR_MAX);
const macroScope = (order, settings = {}) => settings.macroShield !== false && (EQUITY.has(order.market) || (order.market === 'crypto' && settings.macroShieldCrypto === true));

function killReason() {
  const k = dailyLoss.current();
  if (!k || !k.active) return null;
  return `DAILY_LOSS_LIMIT_REACHED: today's P/L ${usd(k.trippedPnl)} hit the -$${k.limit} daily loss limit at ${et.clock(k.trippedAt)}; `
    + 'no new entries until tomorrow (open trades, stops, targets and closes keep working)';
}

function macroReason(order, settings, now) {
  if (!macroScope(order, settings)) return null;
  const b = macro.isMacroBlackoutActive(now);
  if (!b.active) return null;
  return `MACRO_SHIELD_ACTIVE: ${b.event} at ${et.clock(b.releaseTime)}: no new ${order.market} entries from 30 min before to 15 min after the release; `
    + `resumes at ${et.clock(b.resumesAt)}`;
}

function sectorReason(order, positions = [], pending = [], settings = {}) {
  if (!EQUITY.has(order.market)) return null;
  const max = sectorMax(settings);
  const sector = sectorOf(order.asset);
  const same = (x) => x && EQUITY.has(x.market) && x.id !== order.id && !holding(x) && sameBook(order, x) && sectorOf(x.asset) === sector;
  const open = positions.filter(same);
  const staged = pending.filter((o) => same(o) && !manualOrder(o));
  if (open.length + staged.length < max) return null;
  const names = [...open.map((x) => `${x.asset} open`), ...staged.map((x) => `${x.asset} staged`)].join(', ');
  return `SECTOR_CAP_REACHED: Max ${max} open trade${max === 1 ? '' : 's'} for ${sector} (${names}); a new ${sector} setup waits until one closes`;
}

// An option position's net bid / ask from its legs' quotes -> { bid, ask, mid, width, pct } | null (no quotes).
function spreadWidth(od) {
  const legs = (od && od.legs) || [];
  if (legs.length && legs.every((l) => l.bid >= 0 && l.ask > 0 && l.ask >= l.bid)) {
    let ask = 0; let bid = 0;
    for (const l of legs) { const r = l.ratio || 1; if (l.side === 'sell') { ask -= l.bid * r; bid -= l.ask * r; } else { ask += l.ask * r; bid += l.bid * r; } }
    const mid = (ask + bid) / 2;
    return mid > 0 ? { bid, ask, mid, width: ask - bid, pct: (ask - bid) / mid } : null;
  }
  if (od && od.netMid > 0 && od.combinedLegSpread >= 0) return { bid: od.netMid - od.combinedLegSpread / 2, ask: od.netMid + od.combinedLegSpread / 2, mid: od.netMid, width: od.combinedLegSpread, pct: od.combinedLegSpread / od.netMid };
  return null;
}

function optionsSpreadReason(order) {
  if (order.market !== 'options') return null;
  const w = spreadWidth(order.optionsData);
  if (!w || w.pct <= MAX_OPTION_SPREAD_PCT + 1e-9) return null;
  const c = (x) => x.toFixed(2);
  return `OPTIONS_SPREAD_TOO_WIDE: net bid ${c(w.bid)} / ask ${c(w.ask)} is ${c(w.width)} wide = ${Math.round(w.pct * 100)}% of its ${c(w.mid)} mid `
    + `(max ${Math.round(MAX_OPTION_SPREAD_PCT * 100)}%): getting in and out would cost that much`;
}

// A setup (sized or not) -> null (allowed) or the rejection reason. ctx: { positions, pending (staging), settings, now }
function check(order, { positions = [], pending = [], settings = {}, now = Date.now() } = {}) {
  if (exempt(order)) return null;
  return killReason() || macroReason(order, settings, now) || optionsSpreadReason(order) || sectorReason(order, positions, pending, settings);
}

// Once per pass (and before an approval): re-measure today's P/L (may trip the kill switch). Never throws.
function refresh(ledger, settings, now = Date.now()) {
  try { dailyLoss.refresh({ journal: ledger.getTradeJournal(), positions: ledger.getActivePositions(), settings, now }); } catch (err) { console.error(`[risk] daily loss check failed: ${err.message}`); }
  return status(settings, now);
}

// ENTRY_SHIELDS (every pass + on connect): what the banners show.
function status(settings = {}, now = Date.now()) {
  const b = macro.isMacroBlackoutActive(now);
  return {
    at: now,
    macro: { enabled: settings.macroShield !== false, crypto: settings.macroShieldCrypto === true, ...b,
      releaseClock: b.active ? et.clock(b.releaseTime) : null, resumesClock: b.active ? et.clock(b.resumesAt) : null,
      upcoming: macro.upcoming(now, 36).map((e) => ({ ...e, clock: et.clock(e.releaseTime), day: et.ymd(e.releaseTime) })) },
    kill: dailyLoss.current(),
    maxTradesPerSector: sectorMax(settings),
  };
}

module.exports = { check, refresh, status, killReason, macroReason, sectorReason, optionsSpreadReason, spreadWidth, DEFAULT_SECTOR_MAX, MAX_OPTION_SPREAD_PCT };
