// Paper options spread ENTRY pricing at Alpaca Paper (Phase 74). Alpaca's paper engine fills an order only
// when it is MARKETABLE against the NBBO (a debit spread: its net limit >= the NATURAL price = the bought
// legs' asks - the sold legs' bids). The plan's debit is the net mid + 15% of the bid/ask gap, so an order
// limited there sat "Working · Not filled" until the market came to it: often all day.
//   limitFor(od)   fresh leg quotes -> the natural price, capped at maxDebit(od): the limit to send
//   maxDebit(od)   the most the PLAN may pay and still pass SignalDesk's rules: T1 (exitRule.targetValue)
//                  nets MIN_T1_NET_RR after fees against the stop (exitRule.stopValue), <= 53% of the
//                  width, and at most RISK_TOLERANCE more risk per contract than the plan was sized for
//   work(...)      a working entry: re-priced to the current natural (same cap) every REPRICE_MS;
//                  not filled GIVE_UP_MS after it was placed -> canceled and voided (never waits all day); a Quick Flip
//                  (Phase 89, optionsData.entryTimeoutMs) gives up after its own timeout and is never re-priced
const options = require('../connectors/options-data');
const { OPTIONS_ROUND_TRIP_PER_CONTRACT } = require('../risk/cost-authority');
const { MIN_T1_NET_RR } = require('../risk/reality-gate');

const REPRICE_MS = 3 * 60 * 1000;
const GIVE_UP_MS = 15 * 60 * 1000;
const RISK_TOLERANCE = 0.2;
const MAX_WIDTH_SHARE = 0.53; // options-spread-builder debitShare[1]
const MULT = 100;
const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;
const round2 = (x) => Math.round(x * 100) / 100;
const legsOf = (od) => require('../connectors/alpaca-options').legsOf(od);

function maxDebit(od) {
  const plan = od.plannedDebit || od.debit;
  const rule = od.exitRule || {};
  const f = (OPTIONS_ROUND_TRIP_PER_CONTRACT * (legsOf(od).length || 1)) / MULT; // per share, like the builder
  const caps = [];
  const S = Number(rule.stopValue);
  const T = Number(rule.targetValue);
  if (T > 0 && S >= 0) caps.push((T - f + MIN_T1_NET_RR * (S - f)) / (1 + MIN_T1_NET_RR)); // (T - d - f) / (d - S + f) >= MIN
  if (od.width > 0) caps.push(MAX_WIDTH_SHARE * od.width);
  if (S >= 0 && plan > S) caps.push(S + (plan - S) * (1 + RISK_TOLERANCE));
  return caps.length ? Math.max(plan, floor2(Math.min(...caps))) : plan; // never below the plan (it passed at its own debit)
}

// The natural net price from fresh quotes (null: a leg has no fresh quote).
async function natural(od, now = Date.now()) {
  const legs = legsOf(od);
  await options.refreshQuotes(legs.map((l) => l.contract), now);
  let sum = 0;
  for (const l of legs) {
    const q = options.freshQuote(l.contract, 3 * 60 * 1000, now);
    if (!q || !(q.ask > 0)) return null;
    sum += (l.side === 'sell' ? -q.bid : q.ask) * (l.ratio || 1);
  }
  return sum > 0 ? round2(sum) : null;
}

// { limit, natural, cap, basis }
async function limitFor(od, now = Date.now()) {
  const cap = maxDebit(od);
  const nat = await natural(od, now).catch(() => null);
  if (!(nat > 0)) return { limit: round2(od.plannedDebit || od.debit), natural: null, cap, basis: 'plan (no fresh quote)' };
  return nat <= cap ? { limit: nat, natural: nat, cap, basis: 'natural (fills at once)' } : { limit: cap, natural: nat, cap, basis: `capped: natural ${nat} is over the plan's max ${cap}` };
}

// A working (unfilled) Alpaca Paper spread entry, once per reconcile pass. api: alpaca-api.paper; place(limit, n): a new order.
// -> null (nothing to do) | { action, detail, patch?, void? }
async function work(pos, status, { api, place, now = Date.now() }) {
  const w = pos.entryWork || { placedAt: now, repricedAt: 0, reprices: 0, limit: pos.limitPrice || pos.optionsData.debit }; // orders placed before Phase 74: re-priced at once
  const giveUp = pos.optionsData.entryTimeoutMs > 0 ? pos.optionsData.entryTimeoutMs : GIVE_UP_MS; // Phase 89: a Quick Flip waits 3 min, never re-priced
  if (now - w.placedAt >= giveUp) {
    const c = await api.cancelOrder(pos.brokerId);
    const s = c.ok ? await api.getOrderStatus(pos.brokerId) : null;
    if (s && s.ok && s.filledQty > 0) return { action: 'waiting', detail: 'filled while canceling: synced next pass' };
    if (!(s && s.ok && s.terminal)) return { action: 'waiting', detail: `unfilled for ${Math.round((now - w.placedAt) / 60000)} min; cancel not confirmed yet` };
    return { action: 'voided', void: 'ENTRY_UNFILLED', detail: `not filled in ${giveUp / 60000} min at up to ${w.limit} (natural ${w.natural ?? '?'}, plan max ${w.cap ?? '?'}): canceled at Alpaca Paper` };
  }
  if (pos.optionsData.entryTimeoutMs > 0) return null; // Quick Flips: no re-pricing (the entry is taken at the ask or not at all)
  if (now - (w.repricedAt || w.placedAt) < REPRICE_MS && pos.entryWork) return null;
  const px = await limitFor(pos.optionsData, now);
  if (!(px.limit > w.limit + 0.005)) return { action: 'unchanged', patch: { entryWork: { ...w, repricedAt: now, natural: px.natural, cap: px.cap } } };
  const c = await api.cancelOrder(pos.brokerId);
  const s = c.ok ? await api.getOrderStatus(pos.brokerId) : null;
  if (s && s.ok && s.filledQty > 0) return { action: 'waiting', detail: 'filled while re-pricing: synced next pass' };
  if (!(s && s.ok && s.terminal)) return { action: 'waiting', detail: `re-price: the old order ${pos.brokerId} is not confirmed canceled yet` };
  const r = await place(px.limit, w.reprices + 1);
  if (!r.ok) return { action: 'voided', void: 'ENTRY_REPRICE_FAILED', detail: `re-priced order refused: ${r.error}` };
  return { action: 'repriced', detail: `re-priced ${w.limit} -> ${px.limit} (${px.basis})`,
    patch: { brokerId: r.brokerId, limitPrice: px.limit, entryWork: { ...w, limit: px.limit, natural: px.natural, cap: px.cap, repricedAt: now, reprices: w.reprices + 1 } } };
}

module.exports = { maxDebit, natural, limitFor, work, REPRICE_MS, GIVE_UP_MS, RISK_TOLERANCE };
