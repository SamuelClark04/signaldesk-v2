// Phase 95 Tasks 5.2 + 5.3 (plan 6.3-6.5): contract selection ONLY from the selection recorded before the decision; entry at the first
// eligible observed quote after t_avail + L; exit conditions checked only at observed quotes, the fill at the NEXT eligible quote (never
// at the threshold, never between snapshots); losses beyond the stop; gaps; expiry rules; D / W session counting. $ to the cent.
// Run: node tests/ph95fills.js
const path = require('path');
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };
const F = require(path.join(__dirname, '..', 'tools', 'research', 'shadow', 'fills'));
const X = require(path.join(__dirname, '..', 'tools', 'research', 'shadow', 'exits'));
const et = require(path.join(__dirname, '..', 'server', 'services', 'et-time'));
const at = (day, h, m, s = 0) => et.toEpoch(day, h, m) + s * 1000;
const D = '2026-10-08'; // Thursday

// --- selection ---
const cands = [{ recorded_at: at(D, 10, 0), underlying: 'AMZN', bucket: 'Q', side: 'call', contract: 'AMZN261009C00225000', expiry: '2026-10-09', strike: 225, delta: 0.52, dte: 1, rule: 'delta' },
  { recorded_at: at(D, 10, 30), underlying: 'AMZN', bucket: 'Q', side: 'call', contract: 'AMZN261009C00226000', expiry: '2026-10-09', strike: 226, delta: 0.5, dte: 1, rule: 'delta' }];
let sel = F.selectContract(cands, { underlying: 'AMZN', bucket: 'Q', side: 'call', tAvail: at(D, 10, 29, 59) });
check('selection: the latest selection recorded at or before t_avail (10:00), never the 10:30 refresh', sel.contract === 'AMZN261009C00225000' && sel.selectedAt === at(D, 10, 0)
  && sel.eligibility.delta === 0.52 && sel.eligibility.dte === 1, JSON.stringify(sel));
sel = F.selectContract(cands, { underlying: 'AMZN', bucket: 'Q', side: 'call', tAvail: at(D, 9, 59) });
check('selection: none recorded before t_avail -> NO_SELECTION (no later contract substituted)', sel.reason === 'NO_SELECTION' && !sel.contract);
check('selection: another bucket / side / underlying is never used', F.selectContract(cands, { underlying: 'AMZN', bucket: 'D', side: 'call', tAvail: at(D, 11, 0) }).reason === 'NO_SELECTION'
  && F.selectContract(cands, { underlying: 'AMZN', bucket: 'Q', side: 'put', tAvail: at(D, 11, 0) }).reason === 'NO_SELECTION');
check('expiry: a D / W rule needs the expiry >= 5 sessions after its planned exit; otherwise INSUFFICIENT_EXPIRY', F.expiryOk({ expiry: '2026-10-23', plannedExitDay: '2026-10-15' }).ok === true
  && F.expiryOk({ expiry: '2026-10-21', plannedExitDay: '2026-10-15' }).reason === 'INSUFFICIENT_EXPIRY', JSON.stringify(F.expiryOk({ expiry: '2026-10-21', plannedExitDay: '2026-10-15' })));

// --- entry ---
const q = (t, bid, ask, feed = 'indicative') => ({ t_quote: t, bid, ask, feed });
const t0 = at(D, 10, 15);
const quotes = [q(t0 - 30000, 1.0, 1.1), q(t0 + 3000, 1.0, 1.1), q(t0 + 20000, 0, 1.1), q(t0 + 40000, 1.0, 2.0), q(t0 + 60000, 1.02, 1.12), q(t0 + 120000, 1.05, 1.15)];
let e = F.entryFill(quotes, { tAvail: t0, latencyMs: 5000, maxWaitMs: 120000 });
check('entry: the first ELIGIBLE quote at or after t_avail + 5 s: skips the earlier quote (t+3 s), a zero bid, a spread > 50% of mid; fills at that quote\'s ASK',
  e.status === 'FILLED' && e.quote.t_quote === t0 + 60000 && e.price === 1.12 && e.latencyMs === 60000 && e.feed === 'indicative', JSON.stringify(e));
e = F.entryFill(quotes.slice(0, 4), { tAvail: t0, latencyMs: 5000, maxWaitMs: 120000 });
check('entry: no eligible quote within 2 min -> UNFILLED (counted, never dropped)', e.status === 'UNFILLED');
check('entry: a stale repeated quote (provider time before the order) is never eligible', F.entryFill([q(t0 - 1000, 1, 1.1), q(t0 - 1000, 1, 1.1)], { tAvail: t0, latencyMs: 5000, maxWaitMs: 120000 }).status === 'UNFILLED');

// --- Q exit: target +$40, stop -$40, time stop 30 min; fees $0.05 / side ---
const entry = { t: t0 + 60000, price: 1.12, fees: 0.05 };
// minute samples: bid path 1.30 -> 1.53 (net 1.53*100-112-0.10 = 40.90 >= 40: TRIGGER) -> next quote bid 1.49 (fill below the threshold)
const path1 = [q(entry.t + 60000, 1.3, 1.4), q(entry.t + 120000, 1.53, 1.63), q(entry.t + 180000, 1.49, 1.59), q(entry.t + 240000, 1.6, 1.7)];
let x = X.runExit(path1, entry, { family: 'Q', target: 40, stop: -40, timeStopMin: 30, latencyMs: 5000, dataThrough: entry.t + 3600000 });
check('Q target: triggered at the observed quote where net >= +$40, filled at the NEXT quote\'s bid (1.49), net = 149 - 112 - 0.10 = $36.90 (below the threshold, as observed)',
  x.status === 'CLOSED' && x.reason === 'TARGET' && x.trigger.t_quote === entry.t + 120000 && x.fill.t_quote === entry.t + 180000 && Math.abs(x.net - 36.9) < 1e-9 && x.gapMs === 60000
  && Math.abs(x.slippage - (36.9 - 40)) < 1e-9, JSON.stringify(x));
const path2 = [q(entry.t + 60000, 0.9, 1.0), q(entry.t + 120000, 0.71, 0.8), q(entry.t + 180000, 0.6, 0.7)];
x = X.runExit(path2, entry, { family: 'Q', target: 40, stop: -40, timeStopMin: 30, latencyMs: 5000, dataThrough: entry.t + 3600000 });
check('Q stop: net 71 - 112 - 0.10 = -41.10 <= -40 triggers; the fill at the next bid 0.60 = -$52.10; loss beyond the stop $12.10',
  x.reason === 'STOP' && Math.abs(x.net - -52.1) < 1e-9 && Math.abs(x.lossBeyondStop - 12.1) < 1e-9, JSON.stringify(x));
const path3 = [q(entry.t + 60000, 1.3, 1.4), q(entry.t + 120000, 1.6, 1.7)];
x = X.runExit(path3, entry, { family: 'Q', target: 40, stop: -40, timeStopMin: 30, latencyMs: 5000, dataThrough: entry.t + 3600000 });
check('Q: the trigger quote is the LAST quote (no later one in the data, data ended later) -> GAP_EXIT pending, never filled at the trigger', x.status === 'OPEN' && x.pending === 'GAP_EXIT', JSON.stringify(x));
const path4 = [q(entry.t + 60000, 1.15, 1.25), q(entry.t + 31 * 60000, 1.2, 1.3), q(entry.t + 32 * 60000, 1.18, 1.28)];
x = X.runExit(path4, entry, { family: 'Q', target: 40, stop: -40, timeStopMin: 30, latencyMs: 5000, dataThrough: entry.t + 3600000 });
check('Q time stop: the first observed quote past 30 min triggers; filled at the next quote (1.18): net $5.90', x.reason === 'TIME' && Math.abs(x.net - 5.9) < 1e-9, JSON.stringify(x));
const path5 = [q(entry.t + 60000, 1.15, 1.25), q(entry.t + 25 * 60000, 1.6, 1.7), q(entry.t + 26 * 60000, 1.62, 1.72)];
const path5b = [q(entry.t + 60000, 1.15, 1.25), q(entry.t + 25 * 60000, 0.7, 0.8), q(entry.t + 26 * 60000, 0.69, 0.79)];
const xs = X.runExit([q(entry.t + 60000, 1.15, 1.25), q(entry.t + 120000, 0.7, 1.9), q(entry.t + 180000, 0.75, 0.85)], entry, { family: 'Q', target: 40, stop: -40, timeStopMin: 30, latencyMs: 5000, dataThrough: entry.t + 3600000 });
check('Q: the stop is checked before the target on the same quote (a quote can only meet one: bid-based); stop path -> STOP', X.runExit(path5b, entry, { family: 'Q', target: 40, stop: -40, timeStopMin: 30, latencyMs: 5000, dataThrough: entry.t + 3600000 }).reason === 'STOP'
  && X.runExit(path5, entry, { family: 'Q', target: 40, stop: -40, timeStopMin: 30, latencyMs: 5000, dataThrough: entry.t + 3600000 }).reason === 'TARGET' && xs.reason === 'STOP');
const late = [q(at(D, 15, 49), 1.15, 1.25), q(at(D, 15, 50, 30), 1.16, 1.26), q(at(D, 15, 51, 30), 1.17, 1.27)];
x = X.runExit(late, { ...entry, t: at(D, 15, 40) }, { family: 'Q', target: 40, stop: -40, timeStopMin: 60, latencyMs: 5000, dataThrough: at(D, 16, 0) });
check('Q flat at 15:50 ET: the first quote at or after 15:50 triggers FLAT_1550, filled at the next', x.reason === 'FLAT_1550' && x.fill.t_quote === at(D, 15, 51, 30), JSON.stringify(x));
const noQuotes = X.runExit([], entry, { family: 'Q', target: 40, stop: -40, timeStopMin: 30, latencyMs: 5000, dataThrough: entry.t + 600000 });
check('no quotes yet but the data continues later -> OPEN (completed when later data arrives)', noQuotes.status === 'OPEN');

// --- D / W: session counting, -50% stop, 2-DTE expiry exit ---
check('sessions: +1 after Thu 2026-10-08 is Fri 10-09; +5 skips the weekend (10-15); across Thanksgiving +1 after 11-25 is 11-27 (an early close)',
  X.sessionAfter('2026-10-08', 1) === '2026-10-09' && X.sessionAfter('2026-10-08', 5) === '2026-10-15' && X.sessionAfter('2026-11-25', 1) === '2026-11-27');
const dEntry = { t: at(D, 10, 20), price: 3.0, fees: 0.05, day: D, expiry: '2026-11-20' };
const dq = [q(at(D, 11, 0), 2.9, 3.1), q(at('2026-10-09', 15, 50), 3.4, 3.6), q(at('2026-10-09', 16, 0), 3.45, 3.65)];
x = X.runExit(dq, dEntry, { family: 'D', sessions: 1, stopPct: 50, latencyMs: 5000, dataThrough: at('2026-10-10', 0, 0) });
check('D +1: the session +1 close trigger is the first quote at/after 15:50 of 10-09; filled at the next: net 345 - 300 - 0.10 = $44.90', x.reason === 'SESSION_CLOSE' && Math.abs(x.net - 44.9) < 1e-9, JSON.stringify(x));
x = X.runExit([q(at(D, 11, 0), 1.4, 1.6), q(at(D, 11, 10), 1.38, 1.58)], dEntry, { family: 'D', sessions: 3, stopPct: 50, latencyMs: 5000, dataThrough: at('2026-10-20', 0, 0) });
check('D stop: a bid at or under 50% of the entry price (1.40 <= 1.50) triggers; filled at the next bid 1.38', x.reason === 'STOP' && Math.abs(x.net - (138 - 300 - 0.1)) < 1e-9);
const exp2 = { ...dEntry, expiry: '2026-10-16' };
x = X.runExit([q(at('2026-10-14', 9, 45), 3.1, 3.3), q(at('2026-10-14', 10, 0), 3.2, 3.4), q(at('2026-10-14', 10, 10), 3.25, 3.45)], exp2, { family: 'D', sessions: 5, stopPct: 50, latencyMs: 5000, dataThrough: at('2026-10-20', 0, 0) });
check('2-DTE: on the day the contract is 2 days from expiry, the first quote from 10:00 ET triggers EXPIRY_EXIT (never held into expiry)', x.reason === 'EXPIRY_EXIT' && x.trigger.t_quote === at('2026-10-14', 10, 0), JSON.stringify(x));
check('stress fills: entry 10% of the spread worse, exit 10% worse', Math.abs(X.stressNet({ entryQuote: q(0, 1.0, 1.1), exitQuote: q(0, 1.4, 1.5), fees: 0.05 }) - ((1.39 - 1.11) * 100 - 0.1)) < 1e-9);

console.log(`\nph95fills: ${fails ? `${fails} FAIL` : 'all passed'}`);
process.exitCode = fails ? 1 : 0;
