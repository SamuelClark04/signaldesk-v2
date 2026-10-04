// Options Quick Flips entry rules (Phase 89; docs/research/phase89-protocol.md 1.5), an entry shield on NEW Quick Flip
// entries (entry-shields.js: at staging and again at approval). Exits are never gated here.
//   QUICKFLIPS_PAPER_ONLY      a Quick Flip may only trade in the PAPER book (development / validation: never real money)
//   QUICKFLIPS_WINDOW          entries only 9:50 AM - 2:33 PM ET (the setups' windows + the 3-minute approval window);
//                              none from 1:30 PM on an FOMC day
//   QUICKFLIPS_MAX_OPEN        at most MAX_OPEN Quick Flips open or staged (SPY and QQQ move together)
//   QUICKFLIPS_SYMBOL_BUSY     one open / staged Quick Flip per symbol
//   QUICKFLIPS_DAILY_ENTRIES   at most MAX_PER_SYMBOL_DAY entries per symbol per New York day
//   QUICKFLIPS_COOLDOWN        none within COOLDOWN_MS of the last Quick Flip exit on that symbol
//   QUICKFLIPS_STOPPED_TODAY   after a stop-out, no new entry in that direction on that symbol today
//   QUICKFLIPS_DAILY_STOP      no new Quick Flips after DAILY_STOP_R realized today (in R, Quick Flips only)
// Zero-trade days are normal: nothing here ever lowers a requirement to make a trade happen.
const et = require('../services/et-time');

const ID = 'options-quickflips';
const MAX_OPEN = 2;
const MAX_PER_SYMBOL_DAY = 3;
const COOLDOWN_MS = 15 * 60 * 1000;
const DAILY_STOP_R = -2;
const WINDOW = { from: 9 * 60 + 50, to: 14 * 60 + 33, fomcCutoff: 13 * 60 + 30 };
const isQf = (x) => !!x && x.strategyId === ID;
const live = (x) => x.execution === 'LIVE' || (!!x.sizingBasis && x.sizingBasis !== 'paper' && x.execution !== 'PAPER');
const fomcDays = () => { try { return require('../connectors/macro-events').FOMC; } catch { return []; } };

function reason(order, { positions = [], pending = [], journal = [], now = Date.now(), fomc = fomcDays() } = {}) {
  if (!isQf(order)) return null;
  if (live(order)) return 'QUICKFLIPS_PAPER_ONLY: Options Quick Flips trade on paper only while they are being validated; nothing was sent';
  const p = et.parts(now); const min = p.h * 60 + p.m;
  if (min < WINDOW.from || min > WINDOW.to) return 'QUICKFLIPS_WINDOW: Quick Flip entries only between 9:50 AM and 2:33 PM ET';
  if (fomc.includes(p.ymd) && min >= WINDOW.fomcCutoff) return 'QUICKFLIPS_WINDOW: FOMC day: no Quick Flip entries from 1:30 PM ET';
  const others = (x) => isQf(x) && x.id !== order.id;
  const open = [...positions.filter(others), ...pending.filter(others)];
  if (open.some((x) => x.asset === order.asset)) return `QUICKFLIPS_SYMBOL_BUSY: a ${order.asset} Quick Flip is already open or staged`;
  if (open.length >= MAX_OPEN) return `QUICKFLIPS_MAX_OPEN: ${open.length} Quick Flips open or staged (max ${MAX_OPEN})`;
  const start = et.dayStart(now);
  const today = journal.filter((t) => isQf(t) && t.closedAt >= start);
  const entries = new Set([...today, ...open].filter((x) => x.asset === order.asset && (x.openedAt || x.stagedAt || 0) >= start).map((x) => String(x.parentId || x.id)));
  if (entries.size >= MAX_PER_SYMBOL_DAY) return `QUICKFLIPS_DAILY_ENTRIES: ${entries.size} ${order.asset} Quick Flips today (max ${MAX_PER_SYMBOL_DAY})`;
  const last = today.filter((t) => t.asset === order.asset).sort((a, b) => b.closedAt - a.closedAt)[0];
  if (last && now - last.closedAt < COOLDOWN_MS) return `QUICKFLIPS_COOLDOWN: the last ${order.asset} Quick Flip closed ${Math.round((now - last.closedAt) / 60000)} min ago (wait ${COOLDOWN_MS / 60000} min)`;
  if (today.some((t) => t.asset === order.asset && t.direction === order.direction && /^STOP_LOSS/.test(String(t.exitReason || '')))) {
    return `QUICKFLIPS_STOPPED_TODAY: a ${order.direction === 'short' ? 'put' : 'call'} Quick Flip on ${order.asset} was stopped out today: no new one in that direction until tomorrow`;
  }
  const r = today.reduce((s, t) => s + (Number.isFinite(t.rMultiple) ? t.rMultiple : 0), 0);
  if (r <= DAILY_STOP_R) return `QUICKFLIPS_DAILY_STOP: Quick Flips are ${r.toFixed(2)}R today (stop at ${DAILY_STOP_R}R): no new ones until tomorrow`;
  return null;
}

module.exports = { reason, isQf, ID, MAX_OPEN, MAX_PER_SYMBOL_DAY, COOLDOWN_MS, DAILY_STOP_R, WINDOW };
