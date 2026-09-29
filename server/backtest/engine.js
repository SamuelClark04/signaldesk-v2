// Backtest engine (Phase 77): replays one rule over one symbol's historical bars, bar by bar, with the LIVE
// exit rules and the real cost model. Long setups (every replayable rule is long).
//   entry    a plan fills at bars[i].close ('close'), at its own price inside bar i ('at': e.g. the crypto
//            swing's reclaim of the mean), or at the NEXT bar's open ('nextOpen': a setup read off a completed
//            bar, approved and filled after it), or as a resting buy ('limit': the first bar within plan.validBars that trades
//            down to plan.limit, e.g. a pullback after a breakout; the fill bar is checked for the stop). A next open above plan.entryMax (PRICE_ESCAPED) or at / under
//            the stop (INVALIDATED) is skipped, like the order guard at approval.
//   gates    the risk engine's: fee drag <= the market's cap, and T1 ALONE >= minT1NetRR : 1 net after fees
//   exits    from the bar after the entry, the stop first (a bar that touches both counts as a loss), a gap
//            through the stop fills at the open; targets as resting limits (a gap over one fills at the open);
//            the stop never moves (the ratchet is a manual step) and NOTHING closes on time (the live rule):
//            a trade still open at the end of the data is reported open, marked at the last close
//   one trade per symbol at a time (the live stacking rule); costs: cost-authority legRate per leg
//   (stocks: 0.05% slippage a leg; crypto: OKX US fees + the spread buffer, the first venue of the waterfall).
const { legRate, maxFeeDrag } = require('../risk/cost-authority');
const { minT1NetRR } = require('../risk/reality-gate');
const { pace } = require('../execution/loop-pace');

const fees = (key, entry, entryLiq, legs) => legRate(key, entryLiq) * entry + legs.reduce((s, l) => s + l.share * legRate(key, l.liq) * l.price, 0);

// The risk engine's two gates on a plan with its entry. -> null or the rejection reason.
function gates(p) {
  const risk = p.entry - p.stop;
  if (!(risk > 0)) return 'STOP_NOT_BELOW_ENTRY';
  const t1 = p.targets[0].price;
  const stopCost = risk + fees(p.feeKey, p.entry, p.entryLiquidity, [{ share: 1, liq: 'taker', price: p.stop }]);
  const t1Net = (t1 - p.entry) - fees(p.feeKey, p.entry, p.entryLiquidity, [{ share: 1, liq: 'maker', price: t1 }]);
  const drag = (legRate(p.feeKey, p.entryLiquidity) + legRate(p.feeKey, 'taker')) * p.entry / risk;
  if (drag > maxFeeDrag(p.feeKey, !!p.speculative)) return 'Cost ceiling exceeded';
  if (t1Net / stopCost < minT1NetRR(p.market, !!p.speculative)) return 'T1 net reward : risk under the minimum';
  return null;
}

function open(plan, bars, i) {
  let entry; let at;
  if (plan.fill === 'nextOpen') {
    const n = bars[i + 1];
    if (!n) return null;
    if (n.open > plan.entryMax) return { skip: 'PRICE_ESCAPED' };
    if (plan.minFill && !(n.open > plan.minFill)) return { skip: 'FELL_BACK_UNDER_LEVEL' };
    entry = n.open; at = i + 1;
  } else if (plan.fill === 'limit') { // Phase 79: a resting buy at plan.limit for plan.validBars bars (a pullback entry); never filled = no trade
    const k = bars.findIndex((b, j) => j > i && j <= i + plan.validBars && b.low <= plan.limit);
    if (k < 0) return { skip: 'NO_PULLBACK_FILL' };
    entry = Math.min(bars[k].open, plan.limit); at = k;
  } else { entry = plan.fill === 'at' ? plan.price : bars[i].close; at = i; }
  const lv = plan.build(entry, at);
  if (!lv || lv.reject) return { skip: (lv && lv.reject) || 'NO_LEVELS' };
  const p = { symbol: plan.symbol, tag: plan.tag, market: plan.market, feeKey: plan.feeKey, entryLiquidity: plan.entryLiquidity || 'taker', speculative: !!plan.speculative,
    entry, stop: lv.stop, targets: lv.targets.map((t) => ({ ...t })), openedAt: bars[at].time, bar: at, legs: [], left: 1, meta: plan.meta || null };
  if (!(entry > p.stop)) return { skip: 'INVALIDATED' };
  const g = gates(p);
  return g ? { skip: g } : { pos: p, firstExitBar: plan.fill === 'nextOpen' || plan.fill === 'limit' ? at : at + 1 }; // a limit fill bar is checked for the stop too
}

// One bar of exits for an open position (mutates it). true when it is flat.
function step(p, b) {
  if (b.low <= p.stop) {
    p.legs.push({ share: p.left, price: b.open <= p.stop ? b.open : p.stop, liq: 'taker', why: 'STOP_LOSS', time: b.time });
    p.left = 0;
    return true;
  }
  for (const t of p.targets) {
    if (t.hit || !(b.high >= t.price)) continue;
    t.hit = true;
    const share = Math.min(p.left, t.allocation);
    p.legs.push({ share, price: Math.max(t.price, b.open), liq: 'maker', why: `T${t.level}`, time: b.time });
    p.left -= share;
  }
  if (p.targets.every((t) => t.hit)) p.left = 0;
  return p.left <= 1e-9;
}

function result(p, lastBar) {
  const open = p.left > 1e-9;
  const legs = open ? [...p.legs, { share: p.left, price: lastBar.close, liq: 'taker', why: 'OPEN (marked at the last close)', time: lastBar.time }] : p.legs;
  const risk = p.entry - p.stop;
  const gross = legs.reduce((s, l) => s + l.share * (l.price - p.entry), 0);
  const netR = (gross - fees(p.feeKey, p.entry, p.entryLiquidity, legs)) / risk;
  return { symbol: p.symbol, tag: p.tag, entry: p.entry, stop: p.stop, t1: p.targets[0].price, openedAt: p.openedAt, closedAt: open ? null : legs[legs.length - 1].time,
    exit: legs.map((l) => l.why).join(' + '), netR, open, ...(p.meta ? { meta: p.meta } : {}) }; // meta: the rule's own notes (research)
}

// rule.signal(bars, i, ctx) -> plan | null. from: the first bar index a NEW trade may open (warm-up before it).
async function replay(symbol, bars, rule, ctx, from) {
  const trades = [];
  const skipped = {};
  let pos = null;
  let exitFrom = 0;
  for (let i = Math.max(from, 1); i < bars.length; i += 1) {
    if (i % 64 === 0) await pace(); // Phase 72: never a long synchronous block (the VM serves live ticks meanwhile)
    if (pos) {
      if (i >= exitFrom && (!rule.tradable || rule.tradable(i, ctx)) && step(pos, bars[i])) { trades.push(result(pos, bars[i])); pos = null; } // rule.tradable: e.g. regular session only
      continue;
    }
    const plan = rule.signal(bars, i, ctx);
    if (!plan) continue;
    const o = open({ ...plan, symbol, market: rule.market }, bars, i);
    if (!o) continue;
    if (o.skip) { skipped[o.skip] = (skipped[o.skip] || 0) + 1; continue; }
    pos = o.pos;
    exitFrom = o.firstExitBar; // the next bar ('close' / 'at'), or the entry bar itself after its open ('nextOpen')
  }
  if (pos) trades.push(result(pos, bars[bars.length - 1]));
  return { trades, skipped };
}

// Win rate, total / average R, profit factor, max drawdown (R, on closed trades in exit order).
function summarize(trades) {
  const closed = trades.filter((t) => !t.open).sort((a, b) => a.closedAt - b.closedAt);
  const wins = closed.filter((t) => t.netR > 0);
  const gw = wins.reduce((s, t) => s + t.netR, 0);
  const gl = -closed.filter((t) => t.netR <= 0).reduce((s, t) => s + t.netR, 0);
  let eq = 0; let peak = 0; let dd = 0;
  for (const t of closed) { eq += t.netR; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { trades: closed.length, open: trades.length - closed.length, wins: wins.length, winRate: closed.length ? wins.length / closed.length : null, totalR: eq,
    avgR: closed.length ? eq / closed.length : null, profitFactor: gl > 0 ? gw / gl : (gw > 0 ? null : 0), maxDrawdownR: dd,
    openR: trades.filter((t) => t.open).reduce((s, t) => s + t.netR, 0) };
}

module.exports = { replay, summarize, gates, step, open };
