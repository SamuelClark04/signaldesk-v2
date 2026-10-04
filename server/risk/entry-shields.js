// Entry shields (Phase 81): three checks on NEW entries only, at staging (pipeline) and again at approval (order-router,
// where a shielded setup stays pending). Never on exits: stops, targets, time exits and every close are untouched.
//   DAILY_LOSS_LIMIT_REACHED  risk/daily-loss.js tripped today FOR THE SETUP'S BOOK (Phase 83: paper and live are separate)
//   MACRO_SHIELD_ACTIVE       services/macro-calendar.js blackout (30 min before .. 15 min after a high-impact USD
//                             release): stocks and options when settings.macroShield (default on); crypto too only with
//                             settings.macroShieldCrypto (default off)
//   SECTOR_CAP_REACHED        stocks / options: at most settings.maxTradesPerSector (default 1) trades per sector group
//                             (risk/sectors.js) open or staged in the same book (paper vs live, like portfolio-risk)
//   OPTIONS_SPREAD_TOO_WIDE   (Phase 82) an option position whose NET natural bid/ask (buy legs at ask / bid, sell legs at
//                             bid / ask, from the legs' quotes) is wider than 25% of its mid: it would lose that much
//                             getting in and out
//   OPTIONS_DAILY_ENTRY_CAP / OPTIONS_SAME_DIRECTION_GAP (Phase 87, risk/option-pacing.js) automated option entries: at most
//                             settings.maxOptionEntriesPerDay a New York day (default 2; 0 = off), none within 60 min of a
//                             same-direction one
//   DAILY_PROFIT_TARGET_REACHED (Phase 89, optional) the book's realized P/L today reached settings.dailyProfitTarget: no new
//                             automated entries in that book today (never forces, resizes or closes anything)
//   COMBINED_RISK_CAP / MAX_OPEN_POSITIONS (Phase 89, risk/exposure-limits.js) options + crypto open risk together, and the most
//                             automated positions open + staged per book
//   QUICKFLIPS_*              (Phase 89, risk/quickflip-rules.js) Options Quick Flips: paper only, entry window, one per symbol,
//                             2 open, 3 a symbol a day, 15-min cooldown, no same direction after a stop, -2R daily stop
// Manual Trade Ticket orders, Portfolio Pilot and adopted / external holdings are never blocked (the user's own call, and
// long-term allocations); open manual trades still occupy their sector.
const macro = require('../services/macro-calendar');
const dailyLoss = require('./daily-loss');
const et = require('../services/et-time');
const { sectorOf } = require('./sectors');
const { holding, sameBook, manualOrder } = require('./portfolio-risk');
const { spreadWidth } = require('./option-spread-width');
const { pacingReason } = require('./option-pacing');
const exposure = require('./exposure-limits');
const quickflips = require('./quickflip-rules');

const EQUITY = new Set(['stocks', 'options']);
const DEFAULT_SECTOR_MAX = 1;
const MAX_OPTION_SPREAD_PCT = 0.25;
const exempt = (o) => !o || manualOrder(o) || o.strategyId === 'portfolio-pilot' || holding(o);
const usd = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
const sectorMax = (settings = {}) => (settings.maxTradesPerSector >= 1 ? Math.floor(settings.maxTradesPerSector) : DEFAULT_SECTOR_MAX);
const macroScope = (order, settings = {}) => settings.macroShield !== false && (EQUITY.has(order.market) || (order.market === 'crypto' && settings.macroShieldCrypto === true));

// The book a setup would trade in: live when it executes / was sized for a live account (portfolio-risk's rule).
const bookOfOrder = (o) => (o.execution === 'LIVE' || (!!o.sizingBasis && o.sizingBasis !== 'paper' && o.execution !== 'PAPER') ? 'live' : 'paper');

function killReason(order = {}) {
  const all = dailyLoss.current();
  const book = bookOfOrder(order);
  const k = all && all[book];
  if (!k || !k.active) return null;
  return `DAILY_LOSS_LIMIT_REACHED: today's ${book} P/L ${usd(k.trippedPnl)} hit the -$${k.limit} ${book} daily loss limit at ${et.clock(k.trippedAt)}; `
    + `no new ${book} entries until tomorrow (open trades, stops, targets and closes keep working)`;
}

function targetReason(order = {}) {
  const all = dailyLoss.current();
  const book = bookOfOrder(order);
  const t = all && all[book] && all[book].target;
  if (!t || !t.reached) return null;
  return `DAILY_PROFIT_TARGET_REACHED: today's realized ${book} P/L ${usd(t.realizedAt)} reached the $${t.amount} daily target at ${et.clock(t.reachedAt)}; `
    + `no new automated ${book} entries until tomorrow (open trades, stops, targets and closes keep working)`;
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

function optionsSpreadReason(order) {
  if (order.market !== 'options') return null;
  const w = spreadWidth(order.optionsData);
  if (!w || w.pct <= MAX_OPTION_SPREAD_PCT + 1e-9) return null;
  const c = (x) => x.toFixed(2);
  return `OPTIONS_SPREAD_TOO_WIDE: net bid ${c(w.bid)} / ask ${c(w.ask)} is ${c(w.width)} wide = ${Math.round(w.pct * 100)}% of its ${c(w.mid)} mid `
    + `(max ${Math.round(MAX_OPTION_SPREAD_PCT * 100)}%): getting in and out would cost that much`;
}

// A setup (sized or not) -> null (allowed) or the rejection reason. ctx: { positions, pending (staging), journal, settings, now }
function check(order, { positions = [], pending = [], journal = [], settings = {}, now = Date.now() } = {}) {
  if (exempt(order)) return null;
  return killReason(order) || targetReason(order) || quickflips.reason(order, { positions, pending, journal, now }) || macroReason(order, settings, now)
    || optionsSpreadReason(order) || sectorReason(order, positions, pending, settings) || exposure.check(order, { positions, pending, settings })
    || pacingReason(order, { positions, pending, journal, settings, now });
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
    quickFlipAlerts: require('../execution/quickflip-alerts').alerts(), // Phase 89c: Quick Flips still open past their deadline
  };
}

module.exports = { check, refresh, status, killReason, targetReason, macroReason, sectorReason, optionsSpreadReason, spreadWidth, DEFAULT_SECTOR_MAX, MAX_OPTION_SPREAD_PCT };
