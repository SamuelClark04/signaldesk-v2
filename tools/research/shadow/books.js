// Phase 95 Task 5.4 (plan 6.4 / 6.6): the frozen exit rules (exits@1) and the research books.
// A book = one opportunity family x one exit rule x one price label (INDICATIVE_ESTIMATE / MARKET_QUOTE: never mixed). Books are
// compared side by side, never summed. Every (opportunity, book) gets a BOOK ENTRY: ENTERED or SKIPPED with exactly one reason, in this
// order: NO_SELECTION, INSUFFICIENT_EXPIRY, UNFILLED, DAILY_LOSS, DAILY_ENTRIES, CONCURRENCY, PER_SYMBOL, CAPITAL; with the book's
// state at that moment. The unconstrained outcome of a skipped opportunity is kept beside it (never replacing the book's results).
const et = require('../../../server/services/et-time');

const EXITS_VERSION = 'exits@1';
const RULES = Object.freeze([
  ...[20, 40, 60, 80].flatMap((target) => [30, 60].map((tmin) => ({ id: `Q+${target}/${tmin}m`, family: 'Q', bucket: 'Q', target, stop: -40, timeStopMin: tmin, waitMs: 120000 }))),
  { id: 'H2h', family: 'H', bucket: 'Q', holdMin: 120, stopPct: 50, waitMs: 120000 },
  ...[1, 3, 5].map((n) => ({ id: `D+${n}`, family: 'D', bucket: 'D', sessions: n, stopPct: 50, waitMs: 900000 })),
  ...[10, 20].map((n) => ({ id: `W+${n}`, family: 'W', bucket: 'W', sessions: n, stopPct: 50, waitMs: 900000 })),
]);
const LIMITS = Object.freeze({ capital: 10000, concurrencyQH: 3, concurrencyDW: 5, perSymbol: 1, entriesPerDay: 10, dailyLoss: -300, fees: 0.05 });
const DATA_SKIPS = ['NO_SELECTION', 'INSUFFICIENT_EXPIRY', 'UNFILLED'];

// The opportunity family a book filters on: the trigger id without its window for controls, the app strategy for APP.
const familyOf = (o) => (o.source === 'CONTROL' ? 'CONTROL' : o.trigger);

// outcomes: [{ opp, rule, status ENTERED-able ('FILLED') or a data skip reason, entry?, exit?, label }] for ONE book, any order.
// -> { entries: [book entry records], summary }
function runBook(outcomes, rule, limits = LIMITS) {
  const list = outcomes.slice().sort((a, b) => a.opp.tAvail - b.opp.tAvail || a.opp.symbol.localeCompare(b.opp.symbol) || a.opp.key.localeCompare(b.opp.key));
  let cash = limits.capital; let open = []; const dayPnl = new Map(); const dayEntries = new Map(); const entries = [];
  const conc = rule.family === 'Q' || rule.family === 'H' ? limits.concurrencyQH : limits.concurrencyDW;
  let equity = limits.capital; let peak = equity; let maxDd = 0;
  const release = (t) => {
    const still = [];
    for (const p of open) {
      if (p.exitAt !== null && p.exitAt <= t) {
        cash += p.debit + p.net; equity += p.net; peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity);
        dayPnl.set(p.exitDay, (dayPnl.get(p.exitDay) || 0) + p.net);
      } else still.push(p);
    }
    open = still;
  };
  for (const o of list) {
    const t = o.opp.tAvail; release(t);
    const state = { cash: Math.round(cash * 100) / 100, open: open.length, entriesToday: dayEntries.get(o.opp.day) || 0, pnlToday: Math.round((dayPnl.get(o.opp.day) || 0) * 100) / 100 };
    const skip = (reason) => entries.push({ key: o.opp.key, rule: rule.id, status: 'SKIPPED', reason, state, outcome: o });
    if (DATA_SKIPS.includes(o.status)) { skip(o.status); continue; }
    if (state.pnlToday <= limits.dailyLoss) { skip('DAILY_LOSS'); continue; }
    if (state.entriesToday >= limits.entriesPerDay) { skip('DAILY_ENTRIES'); continue; }
    if (open.length >= conc) { skip('CONCURRENCY'); continue; }
    if (open.some((p) => p.symbol === o.opp.symbol)) { skip('PER_SYMBOL'); continue; }
    const debit = o.entry.price * 100 + limits.fees;
    if (debit > cash) { skip('CAPITAL'); continue; }
    cash -= debit; dayEntries.set(o.opp.day, state.entriesToday + 1);
    const closed = o.exit.status === 'CLOSED';
    open.push({ symbol: o.opp.symbol, debit, net: closed ? o.exit.net : 0, exitAt: closed ? o.exit.exitAt : null, exitDay: closed ? et.ymd(o.exit.exitAt) : null });
    entries.push({ key: o.opp.key, rule: rule.id, status: 'ENTERED', reason: null, state, outcome: o });
  }
  release(Infinity);
  const trades = entries.filter((e) => e.status === 'ENTERED'); const closed = trades.filter((e) => e.outcome.exit.status === 'CLOSED');
  const nets = closed.map((e) => e.outcome.exit.net); const wins = nets.filter((n) => n > 0); const losses = nets.filter((n) => n <= 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const skips = {}; for (const e of entries) if (e.status === 'SKIPPED') skips[e.reason] = (skips[e.reason] || 0) + 1;
  return { entries, summary: { rule: rule.id, opportunities: list.length, entered: trades.length, closed: closed.length, open: trades.length - closed.length, wins: wins.length, losses: losses.length,
    net: Math.round(sum(nets) * 100) / 100, stressNet: Math.round(sum(closed.map((e) => e.outcome.stressNet ?? e.outcome.exit.net)) * 100) / 100,
    avg: nets.length ? Math.round((sum(nets) / nets.length) * 100) / 100 : null, pf: losses.length && sum(losses) < 0 ? Math.round((sum(wins) / -sum(losses)) * 100) / 100 : null,
    worst: nets.length ? Math.min(...nets) : null, best: nets.length ? Math.max(...nets) : null, maxDrawdown: Math.round(maxDd * 100) / 100,
    returnPct: Math.round((sum(nets) / limits.capital) * 10000) / 100, skips } };
}

module.exports = { RULES, LIMITS, EXITS_VERSION, runBook, familyOf, DATA_SKIPS };
