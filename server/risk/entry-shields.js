// Entry shields (Phase 81): three checks on NEW entries only, at staging (pipeline) and again at approval (order-router,
// where a shielded setup stays pending). Never on exits: stops, targets, time exits and every close are untouched.
//   DAILY_LOSS_LIMIT_REACHED  risk/daily-loss.js tripped today (the whole book, paper + live)
//   MACRO_SHIELD_ACTIVE       services/macro-calendar.js blackout (30 min before .. 15 min after a high-impact USD
//                             release): stocks and options when settings.macroShield (default on); crypto too only with
//                             settings.macroShieldCrypto (default off)
//   SECTOR_CAP_REACHED        stocks / options: at most settings.maxTradesPerSector (default 1) trades per sector group
//                             (risk/sectors.js) open or staged in the same book (paper vs live, like portfolio-risk)
// Manual Trade Ticket orders, Portfolio Pilot and adopted / external holdings are never blocked (the user's own call, and
// long-term allocations); open manual trades still occupy their sector.
const macro = require('../services/macro-calendar');
const dailyLoss = require('./daily-loss');
const et = require('../services/et-time');
const { sectorOf } = require('./sectors');
const { holding, sameBook, manualOrder } = require('./portfolio-risk');

const EQUITY = new Set(['stocks', 'options']);
const DEFAULT_SECTOR_MAX = 1;
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

// A setup (sized or not) -> null (allowed) or the rejection reason. ctx: { positions, pending (staging), settings, now }
function check(order, { positions = [], pending = [], settings = {}, now = Date.now() } = {}) {
  if (exempt(order)) return null;
  return killReason() || macroReason(order, settings, now) || sectorReason(order, positions, pending, settings);
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

module.exports = { check, refresh, status, killReason, macroReason, sectorReason, DEFAULT_SECTOR_MAX };
