// Options entry pacing (Phase 87), an entry shield (entry-shields.js) on AUTOMATED option setups, per book (paper / live):
//   OPTIONS_DAILY_ENTRY_CAP   at most settings.maxOptionEntriesPerDay (default 2; 0 = pacing off) automated option entries a New York
//                             day: positions opened today (open or already closed) + setups staged today and still waiting
//   OPTIONS_SAME_DIRECTION_GAP  none within SAME_DIR_GAP_MS (60 min) of another automated option entry in the same direction
// Why (the Phase 87 replay of the options signals, 2 years x 25 symbols): the signals fire in clusters on the same market move
// (Oct 1: six bearish spreads in 2 h 15 min, three in one minute); pacing cut the worst day from -22.8R to -11.9R and the max
// drawdown from 780R to 147R. It adds no edge: a cap on how much one move can cost.
const et = require('../services/et-time');
const { holding, sameBook, manualOrder } = require('./portfolio-risk');

const DEFAULT_PER_DAY = 2;
const SAME_DIR_GAP_MS = 60 * 60 * 1000;
const perDay = (settings = {}) => (Number.isFinite(settings.maxOptionEntriesPerDay) && settings.maxOptionEntriesPerDay >= 0 ? Math.floor(settings.maxOptionEntriesPerDay) : DEFAULT_PER_DAY);
const baseId = (x) => x.parentId || String(x.id).replace(/:trim:\d+$/, '');
const auto = (x) => x && x.market === 'options' && !manualOrder(x) && !holding(x) && x.strategyId !== 'portfolio-pilot';

// Automated option entries of the order's book: [{ id, at (entry time), direction }] (one per trade).
function entries(order, { positions = [], pending = [], journal = [] }) {
  const seen = new Map();
  const add = (x, at) => { if (!auto(x) || !sameBook(order, x) || !(at > 0)) return; const id = baseId(x); if (id !== order.id && !seen.has(id)) seen.set(id, { id, at, direction: x.direction }); };
  for (const p of positions) add(p, p.openedAt);
  for (const t of journal) add(t, t.openedAt);
  for (const o of pending) add(o, o.stagedAt || Date.parse(o.timestamp));
  return [...seen.values()];
}

// -> null (allowed) or the reason. ctx: { positions, pending, journal, settings, now }
function pacingReason(order, ctx = {}) {
  const max = perDay(ctx.settings);
  if (!auto(order) || max === 0) return null; // 0 = pacing off (both rules)
  const now = ctx.now || Date.now();
  const list = entries(order, ctx);
  const today = et.ymd(now);
  const todays = list.filter((x) => et.ymd(x.at) === today);
  if (todays.length >= max) {
    return `OPTIONS_DAILY_ENTRY_CAP: ${todays.length} automated option entr${todays.length === 1 ? 'y' : 'ies'} today already (max ${max} a day): `
      + 'option signals fire in clusters on one market move; the next ones wait for tomorrow';
  }
  const near = list.filter((x) => x.direction === order.direction && now - x.at >= 0 && now - x.at < SAME_DIR_GAP_MS).sort((a, b) => b.at - a.at)[0];
  if (near) {
    return `OPTIONS_SAME_DIRECTION_GAP: a ${order.direction === 'short' ? 'bearish' : 'bullish'} option entry ${Math.max(1, Math.round((now - near.at) / 60000))} min ago (${near.id}); `
      + `no second one in the same direction within ${SAME_DIR_GAP_MS / 60000} min (it would ride the same move)`;
  }
  return null;
}

module.exports = { pacingReason, entries, perDay, DEFAULT_PER_DAY, SAME_DIR_GAP_MS };
