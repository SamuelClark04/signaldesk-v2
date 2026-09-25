// Manual Trade Ticket (Phase 60): [+ Manual Trade] on Opportunities.
//   stock    PAPER: long / short, a dollar size (default $300), stop (1.5 x daily ATR
//            pre-filled), T1 / T2 (2R / 3R pre-filled)
//   crypto   PAPER, or LIVE @ Coinbase (only while Settings has Coinbase on LIVE; long
//            only; the entry goes out with its Coinbase take-profit / stop bracket),
//            default $20
//   options  PAPER, the 25 optionables: a spread or single from manual-options.js
//            (1-click builders or custom strikes), sized in whole contracts
// A ticket is a PROPOSER like any strategy: it becomes a canonical candidate, is sized
// by the risk engine against the venue's capital (fee-drag gate, T1 net R:R), resized
// to the user's amount (resizeOrder: never above the bankroll / live cash), staged, and
// executed through the SAME guarded approval as a strategy setup (order-guard fresh
// price + entry zone; live routing and its checks in message-handler.js). A failed
// approval leaves nothing behind (the staged order is discarded).
// Messages (createHandler, answered to the asker; changes broadcast to everyone):
//   MANUAL_TRADE_DEFAULTS { requestId, mode, asset, direction, venue }
//   MANUAL_TRADE_PREVIEW  { requestId, ticket }  -> the numbers, or the risk engine's reason
//   MANUAL_TRADE_OPEN     { requestId, ticket }  -> MANUAL_TRADE_RESULT
//   MANUAL_OPTIONS        { requestId, action: 'chain' | 'autofind' | 'custom', asset, optType, spec }
//   CLOSE_LIVE_COINBASE_POSITION { id }           -> LIVE_CLOSE_RESULT (coinbase-exit.js)
const ledger = require('./paper-ledger');
const prices = require('../market/latest-prices');
const session = require('../market/market-session');
const { STOCKS, OPTIONABLE_STOCKS } = require('../market/universe');
const { processCandidate, resizeOrder } = require('../risk/risk-engine');
const { sizingBankroll } = require('../risk/venue-capital');
const { priceScenarios } = require('../risk/scenarios');
const { minStopPct } = require('../risk/cost-authority');
const { getDailyBars } = require('../connectors/daily-bars');
const coinbaseApi = require('../connectors/coinbase-api');
const coinbaseSocket = require('../connectors/coinbase-socket');
const { atr } = require('../strategies/options-signals');
const manualOptions = require('./manual-options');
const { exitSpreadCap } = require('../strategies/5-options-system');
const coinbaseExit = require('./coinbase-exit');

const DEFAULT_AMOUNT = { stock: 300, crypto: 20 };
const STOP_ATR = 1.5;
const ZONE = 0.002; // entry zone +/- 0.2% around the live price
const FLOOR_ROOM = 1.2; // pre-filled stops sit 20% beyond the fee gate's tightest
const CRYPTO_RE = /^[A-Z0-9]{1,10}-USD$/;
const MARKET = { stock: 'stocks', crypto: 'crypto', options: 'options' };
const round = (x, px) => Number(x.toFixed(px >= 1000 ? 2 : px >= 1 ? 4 : 8).replace(/(\.\d*?[1-9])0+$/, '$1'));
const num = (x) => (x === '' || x === null || x === undefined ? NaN : Number(x));

let cashCache = { at: 0, value: null };
async function coinbaseCash() {
  if (Date.now() - cashCache.at < 30000) return cashCache.value;
  const a = await coinbaseApi.getAccount().catch(() => null);
  cashCache = { at: Date.now(), value: a && a.ok ? a.buyingPower : null };
  return cashCache.value;
}

function checkAsset(mode, asset) {
  if (mode === 'stock' && !STOCKS.includes(asset)) throw new Error(`MANUAL_ASSET: ${asset} is not one of the 41 monitored stocks`);
  if (mode === 'crypto' && !CRYPTO_RE.test(asset)) throw new Error(`MANUAL_ASSET: ${asset} is not a Coinbase USD pair`);
  if (mode === 'options' && !OPTIONABLE_STOCKS.includes(asset)) throw new Error(`MANUAL_ASSET: ${asset} is not one of the 25 optionable stocks`);
  if (!MARKET[mode]) throw new Error(`MANUAL_MODE: unknown mode "${mode}"`);
}

function livePrice(mode, asset) {
  if (mode === 'crypto') coinbaseSocket.addProducts([asset]); // a gem outside the universe starts streaming
  return prices.getLatestPrice(asset) || null;
}

// Pre-filled levels: stop 1.5 x daily ATR against the direction (never under the fee
// gate's minimum), T1 2R / T2 3R (crypto 2.5R / 3.5R: its fees need the room).
// Moonshot Radar context (Phase 60B): the ticket opened from a gem carries its radar
// score, and is sized like System 6: speculative, conviction = (score - 60) / 40 ->
// the Smart Investment Amount (10-25% of normal risk, risk-engine speculativeScale).
function moonshotOf(t) {
  if (!t || !t.moonshot || t.mode !== 'crypto') return null;
  const score = Number(t.moonshot.score);
  return { score: Number.isFinite(score) ? score : null, conviction: Number.isFinite(score) ? Math.round(Math.max(0, Math.min(1, (score - 60) / 40)) * 100) / 100 : 0 };
}

// The Smart Investment Amount for these levels: the risk engine's speculative size.
async function smartAmount(t, now) {
  try {
    const b = await toCandidate({ ...t, amount: 1 }, now, { preview: true });
    const r = processCandidate(b.candidate, b.capital.bankroll, { riskPct: b.settings.riskPct, maxCapitalPct: b.settings.maxCapitalPct, sizingBasis: b.capital.basis, cashCap: b.capital.cash });
    return r.approved ? { amount: Math.floor(r.notional * 100) / 100, scale: r.speculativeScale, risk: r.dollarRisk, basis: b.capital.basis } : { error: r.reason };
  } catch (err) {
    return { error: err.message };
  }
}

async function defaults({ mode, asset, direction = 'long', venue = 'paper', moonshot = null }, now = Date.now()) {
  checkAsset(mode, asset);
  const live = livePrice(mode, asset);
  const px = live || prices.getMarkPrice(asset);
  const bars = await getDailyBars(asset, now).catch(() => []);
  const a = bars.length > 15 ? atr(bars, 14) : null;
  const d = direction === 'short' ? -1 : 1;
  // 1.5 x ATR, but never tighter than the stop the fee gate accepts (crypto: ~4.6% taker in
  // and out), with FLOOR_ROOM to spare so a normal tick before opening does not fail the gate.
  const floor = px ? minStopPct(MARKET[mode] === 'options' ? 'stocks' : MARKET[mode], 'taker') * px * FLOOR_ROOM : 0;
  const risk = Math.max(a ? STOP_ATR * a : px * 0.03, floor);
  const settings = ledger.getSettings();
  const k1 = mode === 'crypto' ? 2.5 : 2; // crypto fees need 2.5R for T1 to net the 1.25 : 1 floor
  const out = { ok: true, mode, asset, direction, price: px || null, live: !!live, atr: a, amount: DEFAULT_AMOUNT[mode] || null, stopBasis: floor > (a ? STOP_ATR * a : 0) ? 'fee floor' : '1.5 x ATR',
    stop: px ? round(px - d * risk, px) : null, t1: px ? round(px + d * k1 * risk, px) : null, t2: px ? round(px + d * (k1 + 1) * risk, px) : null,
    liveAllowed: settings.cryptoMode === 'live', coinbaseCash: mode === 'crypto' && venue === 'live' ? await coinbaseCash() : null,
    optionsSession: session.isEquityMarketOpen(now), paperBankroll: settings.bankroll };
  const moon = moonshotOf({ mode, moonshot });
  if (moon && px) {
    const smart = await smartAmount({ mode, asset, direction, venue, stop: out.stop, t1: out.t1, t2: out.t2, moonshot }, now);
    out.moonshot = { ...moon, ...smart };
    if (smart.amount > 0) out.amount = smart.amount;
  }
  return out;
}

// Ticket -> { candidate, capital, amount } (not sized yet). preview: a closed market
// prices on the last close (labelled); opening always needs a fresh live price.
async function toCandidate(t, now, { preview = false } = {}) {
  const mode = String(t.mode);
  const asset = String(t.asset || '').toUpperCase();
  checkAsset(mode, asset);
  const market = MARKET[mode];
  const venue = mode === 'crypto' && t.venue === 'live' ? 'live' : 'paper';
  const settings = ledger.getSettings();
  if (venue === 'live' && settings.cryptoMode !== 'live') throw new Error('LIVE_DISABLED: Settings has Coinbase on PAPER; switch it to LIVE there first');
  const live = livePrice(mode, asset);
  const px = live || (preview ? prices.getMarkPrice(asset) : null);
  if (!(px > 0)) throw new Error(`NO_LIVE_PRICE: no fresh ${asset} price right now`);
  const capital = await sizingBankroll(market, venue === 'paper' ? { ...settings, cryptoMode: 'paper', stockMode: 'paper' } : settings);
  if (!capital.ok) throw new Error(capital.reason);
  if (mode === 'options') {
    const priced = await manualOptions.price(asset, t.spec || {}, px, now);
    const c = manualOptions.candidate(asset, px, priced, now);
    const contracts = Math.max(1, Math.floor(num(t.contracts) || 1));
    return { candidate: c, capital, settings, amount: contracts * c.optionsData.debit * c.optionsData.multiplier, px, venue, priced, live: !!live };
  }
  const direction = t.direction === 'short' ? 'short' : 'long';
  if (venue === 'live' && direction === 'short') throw new Error('LIVE_SHORT: a Coinbase spot account cannot open a short');
  const d = direction === 'short' ? -1 : 1;
  const stop = num(t.stop);
  const t1 = num(t.t1);
  const t2 = num(t.t2);
  if (!(stop > 0) || d * (px - stop) <= 0) throw new Error(`MANUAL_LEVELS: the stop must be ${d > 0 ? 'below' : 'above'} the live price ${px}`);
  if (!(t1 > 0) || d * (t1 - px) <= 0) throw new Error(`MANUAL_LEVELS: T1 must be ${d > 0 ? 'above' : 'below'} the live price ${px}`);
  const hasT2 = t2 > 0 && d * (t2 - t1) > 0 && venue !== 'live'; // a live Coinbase bracket exits 100% at T1
  const amount = num(t.amount);
  if (!(amount > 0)) throw new Error('AMOUNT_INVALID: enter a dollar amount');
  const kind = mode === 'stock' ? 'STOCK' : venue === 'live' ? 'CRYPTO-LIVE' : 'CRYPTO';
  const moon = moonshotOf(t);
  const candidate = {
    id: `manual:${kind}:${asset}:${now}`, asset, market, strategyId: 'manual', setupType: moon ? `Manual · Moonshot ${direction}` : `Manual ${direction}`, direction, timeframe: 'manual',
    ...(moon ? { speculative: true, tag: 'Speculative Moonshot', conviction: moon.conviction, convictionScore: moon.score } : {}),
    tradeType: 'Manual', expectedDuration: 'Your call (exits at the stop or targets)', manual: true, forcePaper: venue === 'paper', entryLiquidity: 'taker',
    entryZone: { min: round(px * (1 - ZONE), px), max: round(px * (1 + ZONE), px) }, invalidation: stop,
    targets: [{ level: 1, price: t1, allocation: hasT2 ? 0.5 : 1 }, ...(hasT2 ? [{ level: 2, price: t2, allocation: 0.5 }] : [])],
    catalyst: { type: 'manual', headline: 'Manual trade ticket', sentimentScore: 0 },
    thesis: `Manual ${direction} ${asset} from the trade ticket (${venue === 'live' ? 'LIVE @ Coinbase' : 'paper'}): entry near ${px}, stop ${stop}, T1 ${t1}${hasT2 ? `, T2 ${t2}` : ''}.`,
    confirmationCriteria: [`Manual ${direction} at ${px}`], timestamp: new Date(now).toISOString(),
  };
  return { candidate, capital, settings, amount, px, venue, live: !!live };
}

// Size it: the risk engine's checks, then the user's amount.
function size({ candidate, capital, settings, amount, venue }) {
  const r = processCandidate(candidate, capital.bankroll, { riskPct: settings.riskPct, maxCapitalPct: settings.maxCapitalPct, sizingBasis: capital.basis, cashCap: capital.cash });
  if (!r.approved && r.reason === 'Cost ceiling exceeded' && candidate.market !== 'options') {
    const e = candidate.entryZone.max;
    const pct = minStopPct(candidate.market, candidate.entryLiquidity);
    const at = candidate.direction === 'short' ? e * (1 + pct) : e * (1 - pct);
    return { ok: false, error: `COST_CEILING: fees are ${r.feeDrag.toFixed(2)}R of this stop's risk (max 0.35R). Widen the stop to ${(pct * 100).toFixed(1)}% or more (${candidate.direction === 'short' ? 'at/above' : 'at/below'} ${round(at, e)}).` };
  }
  if (!r.approved) return { ok: false, error: r.reason };
  const z = resizeOrder(r, amount, { confirmed: true, fractional: venue === 'paper' && candidate.market === 'stocks' });
  if (!z.approved) return { ok: false, error: z.reason };
  return { ok: true, order: r, sized: z };
}

async function preview(t, now = Date.now()) {
  const b = await toCandidate(t, now, { preview: true });
  const opt = b.priced ? manualOptions.summarize(b.candidate.asset, b.priced.plan, b.px, exitSpreadCap(b.settings), now) : null;
  const s = size(b);
  const basis = b.live ? 'live' : 'last close (market closed: opening needs a live price)';
  if (!s.ok) return { ok: false, error: s.error, price: b.px, priceBasis: basis, options: opt };
  const z = s.sized;
  const sc = priceScenarios(z);
  const loss = sc.stop ? -sc.stop.net : z.dollarRisk;
  return { ok: true, price: b.px, priceBasis: basis, live: b.live, venue: b.venue, qty: z.positionSize, notional: z.notional, dollarRisk: z.dollarRisk, fees: z.estimatedFees, stopNet: sc.stop ? sc.stop.net : null,
    t1Net: sc.t1 ? sc.t1.net : null, t2Net: sc.t2 ? sc.t2.net : null, planNet: sc.plan ? sc.plan.net : null, rr: sc.t1 && loss > 0 ? sc.t1.net / loss : null,
    aboveEngineMax: z.positionSize > s.order.positionSize, engineMax: s.order.notional, cash: b.capital.cash ?? null, bankroll: b.capital.bankroll, options: opt };
}

// Open: stage the sized order, then the guarded approval (paper, or LIVE @ Coinbase).
async function open(t, approve, now = Date.now()) {
  if (t.mode === 'options' && !session.isEquityMarketOpen(now)) throw new Error('MARKET_CLOSED: options open on live quotes in the US session only');
  if (t.venue === 'live' && t.confirmLive !== true) throw new Error('LIVE_UNCONFIRMED: a live Coinbase order needs its confirmation');
  const b = await toCandidate(t, now);
  const s = size(b);
  if (!s.ok) throw new Error(s.error);
  ledger.stageOrder(s.order);
  try {
    const pos = await approve(s.order.id, { amount: b.amount, confirmed: true });
    console.log(`[manual] OPENED ${pos.id}: ${pos.positionSize} ${pos.asset} (${pos.execution}${pos.brokerId ? ` ${pos.brokerId}` : ''})`);
    return pos;
  } catch (err) {
    if (ledger.getPendingOrders().some((o) => o.id === s.order.id)) ledger.discardOrder(s.order.id);
    throw err;
  }
}

function createHandler({ send, broadcast, approve, publish }) {
  const reply = (ws, type, requestId, fn) => Promise.resolve().then(fn)
    .then((r) => send(ws, type, { requestId, ok: true, ...r }))
    .catch((err) => { console.warn(`[manual] ${type} failed: ${err.message}`); send(ws, type, { requestId, ok: false, error: err.message }); });
  const changed = (journal) => {
    broadcast('QUEUE_UPDATED', ledger.getPendingOrders());
    broadcast('POSITIONS_UPDATED', ledger.getActivePositions());
    if (journal) broadcast('JOURNAL_UPDATED', ledger.getTradeJournal());
    publish();
  };
  return function handle(ws, msg) {
    const { type, requestId } = msg;
    if (type === 'MANUAL_TRADE_DEFAULTS') return reply(ws, type, requestId, () => defaults(msg)), true;
    if (type === 'MANUAL_TRADE_PREVIEW') return reply(ws, type, requestId, () => preview(msg.ticket || {})), true;
    if (type === 'MANUAL_TRADE_OPEN') return reply(ws, 'MANUAL_TRADE_RESULT', requestId, async () => { const position = await open(msg.ticket || {}, approve); changed(false); return { position }; }), true;
    if (type === 'MANUAL_OPTIONS') {
      return reply(ws, type, requestId, async () => {
        const asset = String(msg.asset || '').toUpperCase();
        const px = prices.getLatestPrice(asset) || prices.getMarkPrice(asset);
        if (!(px > 0)) throw new Error(`NO_PRICE: no ${asset} price`);
        const settings = ledger.getSettings();
        if (msg.action === 'chain') return { action: 'chain', ...(await manualOptions.chain(asset, px)) };
        if (msg.action === 'custom') return { action: 'custom', plan: manualOptions.summarize(asset, (await manualOptions.price(asset, msg.spec || {}, px)).plan, px, exitSpreadCap(settings), Date.now()) };
        return { action: 'autofind', ...(await manualOptions.autoFind(asset, msg.optType === 'put' ? 'put' : 'call', px, { bankroll: settings.bankroll, settings, afterHours: !session.isEquityMarketOpen() })) };
      }), true;
    }
    if (type === 'CLOSE_LIVE_COINBASE_POSITION') {
      const id = String(msg.id || '');
      return reply(ws, 'LIVE_CLOSE_RESULT', requestId, async () => {
        const r = await coinbaseExit.closeLive(ledger, id);
        changed(true);
        return { id, pending: !!r.pending, alreadyClosed: !!r.alreadyClosed, detail: r.detail || null, trade: r.trade || null };
      }).then(() => undefined), true;
    }
    return false;
  };
}

module.exports = { createHandler, defaults, preview, open, toCandidate, DEFAULT_AMOUNT };
