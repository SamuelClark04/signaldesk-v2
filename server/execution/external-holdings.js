// External holdings: everything the user owns that SignalDesk did not open.
//   manual   holdings at brokers SignalDesk cannot reach (Robinhood, Fidelity, a
//            cold wallet...), entered by hand: symbol, quantity (to 0.0001 share
//            or 1e-8 coin), average cost (default: the price when added), an
//            account label (default "Robinhood") and optional custom stop / T1.
//   broker   balances from the last Sync Broker (Coinbase / Alpaca) that
//            SignalDesk does not already manage (its own LIVE trades and adopted
//            positions are subtracted; only the free quantity is external).
// Both get the Portfolio Pilot's protective levels (risk/protective-levels.js:
// 8-18% structural stop, T1 2.5R sells 35%, T2 4.5R), set once and stored,
// unless the user sets a custom stop / T1. positions() returns them in the
// ledger's open-position shape (execution 'EXTERNAL') so the Pilot matrix, the
// allocator and the level alerts treat them like any holding.
// Persisted to server/data/external-holdings.json (EXTERNAL_HOLDINGS_PATH;
// gitignored with the rest of server/data), written atomically.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prices = require('../market/latest-prices');
const brokerSync = require('../connectors/broker-sync');
const { protectiveLevels, T1_SHARE } = require('../risk/protective-levels');
const { feeModel } = require('../risk/scenarios');

const STORE_PATH = process.env.EXTERNAL_HOLDINGS_PATH || path.join(__dirname, '..', 'data', 'external-holdings.json');
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 .&'_-]{0,23}$/;
const STOCK_RE = /^[A-Z][A-Z0-9.]{0,9}$/;
const CRYPTO_RE = /^[A-Z0-9]{1,10}-USD$/;
const QTY_DP = { stocks: 1e4, crypto: 1e8 };
const MAX_MANUAL = 200;

let state = { manual: [], broker: {} }; // broker: 'coinbase:BTC-USD' -> { auto, customStop, customT1, t1Done }
let ledgerRef = null; // paper-ledger (bound lazily: it requires nothing from here)
const ledger = () => { if (!ledgerRef) ledgerRef = require('./paper-ledger'); return ledgerRef; };

function load() {
  if (!fs.existsSync(STORE_PATH)) return;
  try {
    const s = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    state = { manual: Array.isArray(s.manual) ? s.manual : [], broker: s.broker && typeof s.broker === 'object' ? s.broker : {} };
    console.log(`[external] restored ${state.manual.length} manual holding(s) from ${STORE_PATH}`);
  } catch (err) {
    const aside = `${STORE_PATH}.corrupt-${Date.now()}`;
    try { fs.renameSync(STORE_PATH, aside); } catch { /* leave it */ }
    console.error(`[external] could not load ${STORE_PATH} (${err.message}); moved to ${aside}`);
  }
}
function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), ...state }, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}
load();

const bad = (msg) => { const e = new Error(msg); e.status = 400; throw e; };
const marketOf = (symbol) => (symbol.includes('-') ? 'crypto' : 'stocks');
const roundQty = (q, market) => Math.floor(q * QTY_DP[market] + 1e-9) / QTY_DP[market];
const optLevel = (v, name) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!(n > 0) || !Number.isFinite(n)) bad(`${name} must be a price above 0`);
  return n;
};

// The price to value / level a symbol at: live (stream or poll), else the last daily close.
async function priceFor(symbol) {
  const live = prices.getLatestPrice(symbol);
  if (live > 0) return live;
  const bars = await require('../strategies/pilot-ranker').dailyBars(symbol);
  return bars.length ? bars[bars.length - 1].close : null;
}

// Validated fields of an add (full) or edit (partial) request.
function clean(input, existing = null) {
  const body = input && typeof input === 'object' ? input : bad('body must be a JSON object');
  const out = {};
  if (!existing || body.symbol !== undefined) {
    const symbol = String(body.symbol || '').trim().toUpperCase().replace('/', '-');
    if (!STOCK_RE.test(symbol) && !CRYPTO_RE.test(symbol)) bad('symbol must be a stock ticker (NVDA) or a USD crypto pair (BTC-USD)');
    out.symbol = symbol;
  }
  const market = marketOf(out.symbol || existing.symbol);
  if (!existing || body.quantity !== undefined) {
    const q = roundQty(Number(body.quantity), market);
    if (!(q > 0)) bad(`quantity must be at least ${1 / QTY_DP[market]}`);
    out.quantity = q;
  }
  if (body.avgCost !== undefined && body.avgCost !== null && body.avgCost !== '') out.avgCost = optLevel(body.avgCost, 'avgCost');
  if (!existing || body.brokerLabel !== undefined) {
    const label = String(body.brokerLabel === undefined || body.brokerLabel === '' ? 'Robinhood' : body.brokerLabel).trim();
    if (!LABEL_RE.test(label)) bad('brokerLabel: 1-24 letters, digits, spaces or . & \' _ -');
    out.brokerLabel = label;
  }
  if (body.customStop !== undefined) out.customStop = optLevel(body.customStop, 'customStop');
  if (body.customT1 !== undefined) out.customT1 = optLevel(body.customT1, 'customT1');
  const stop = out.customStop !== undefined ? out.customStop : existing && existing.customStop;
  const t1 = out.customT1 !== undefined ? out.customT1 : existing && existing.customT1;
  if (stop && t1 && !(stop < t1)) bad('custom stop must be below custom T1');
  return out;
}

async function add(payload, now = Date.now()) {
  if (state.manual.length >= MAX_MANUAL) bad(`at most ${MAX_MANUAL} manual holdings`);
  const f = clean(payload);
  const px = await priceFor(f.symbol);
  if (!f.avgCost && !(px > 0)) bad(`no price available for ${f.symbol}: enter the average cost`);
  const h = { id: `m-${crypto.randomBytes(6).toString('hex')}`, customStop: null, customT1: null, ...f, market: marketOf(f.symbol), avgCost: f.avgCost || px,
    auto: await protectiveLevels(f.symbol, px, now), t1Done: false, addedAt: now, updatedAt: now };
  state.manual.push(h);
  save();
  return { ...h };
}

async function update(id, payload, now = Date.now()) {
  const h = state.manual.find((x) => x.id === id);
  if (!h) { const e = new Error(`no manual holding ${id}`); e.status = 404; throw e; }
  const f = clean(payload, h);
  const symbolChanged = f.symbol && f.symbol !== h.symbol;
  Object.assign(h, f, { market: marketOf(f.symbol || h.symbol), updatedAt: now });
  if (symbolChanged || payload.resetLevels === true) Object.assign(h, { auto: await protectiveLevels(h.symbol, await priceFor(h.symbol), now), t1Done: false });
  save();
  return { ...h };
}

function remove(id) {
  const i = state.manual.findIndex((x) => x.id === id);
  if (i === -1) { const e = new Error(`no manual holding ${id}`); e.status = 404; throw e; }
  const [h] = state.manual.splice(i, 1);
  save();
  return h;
}

// A confirmed manual trade (Approvals "Confirm Executed"): sell (qty < 0) deducts,
// selling it all removes the holding; buy (qty > 0) adds at `price` (average cost
// re-weighted). { holding | null (removed), quantity }.
function adjust(id, qty, price, { t1Done } = {}) {
  const h = state.manual.find((x) => x.id === id);
  if (!h) throw new Error(`no manual holding ${id} (removed or edited meanwhile)`);
  const next = roundQty(h.quantity + qty, h.market);
  if (qty > 0 && price > 0) h.avgCost = (h.avgCost * h.quantity + price * qty) / (h.quantity + qty);
  if (next <= 0) { remove(id); return { holding: null, quantity: 0 }; }
  Object.assign(h, { quantity: next, updatedAt: Date.now() }, t1Done ? { t1Done: true } : {});
  save();
  return { holding: { ...h }, quantity: next };
}

// Broker-synced balances not managed by SignalDesk: [{ key, broker, asset, market, qty, avgCost, syncedAt }].
function brokerFree() {
  const snap = brokerSync.getSnapshot();
  const open = ledger().getActivePositions().filter((p) => p.execution === 'LIVE');
  const out = [];
  for (const [venue, broker] of [['coinbase', 'Coinbase'], ['alpaca', 'Alpaca']]) {
    const s = snap[venue];
    if (!s || !s.ok) continue;
    for (const p of s.positions) {
      const managed = open.filter((x) => x.broker === broker && x.asset === p.asset).reduce((sum, x) => sum + x.positionSize, 0);
      const qty = roundQty(p.positionSize - managed, p.market);
      const avg = p.fillPrice > 0 ? p.fillPrice : p.costBasis > 0 && p.positionSize > 0 ? p.costBasis / p.positionSize : null;
      if (qty > 0) out.push({ key: `${venue}:${p.asset}`, broker, asset: p.asset, market: p.market, qty, avgCost: avg, syncedAt: s.syncedAt });
    }
  }
  return out;
}

// Stored auto levels for every external holding that has none yet (async: bars).
async function refreshLevels(now = Date.now()) {
  let changed = false;
  for (const b of brokerFree()) {
    const e = state.broker[b.key] || (state.broker[b.key] = { auto: null, customStop: null, customT1: null, t1Done: false });
    if (!e.auto) { e.auto = await protectiveLevels(b.asset, await priceFor(b.asset), now); changed = changed || !!e.auto; }
  }
  for (const h of state.manual) if (!h.auto) { h.auto = await protectiveLevels(h.symbol, await priceFor(h.symbol), now); changed = changed || !!h.auto; }
  if (changed) save();
  return changed;
}

function setBrokerLevels(key, { customStop, customT1, t1Done }) {
  const e = state.broker[key] || (state.broker[key] = { auto: null, customStop: null, customT1: null, t1Done: false });
  if (customStop !== undefined) e.customStop = optLevel(customStop, 'customStop');
  if (customT1 !== undefined) e.customT1 = optLevel(customT1, 'customT1');
  if (t1Done !== undefined) e.t1Done = !!t1Done;
  save();
  return { ...e };
}

// Custom levels win; else the stored auto plan. T2 only for the auto plan.
function levelsOf(e) {
  const a = e.auto || {};
  const stop = e.customStop || a.invalidation || null;
  const t1 = e.customT1 || a.t1 || null;
  const targets = t1 ? [{ level: 1, price: t1, allocation: T1_SHARE }, ...(a.t2 && !e.customT1 ? [{ level: 2, price: a.t2, allocation: 1 - T1_SHARE }] : [])] : [];
  return { invalidation: stop, targets, custom: !!(e.customStop || e.customT1), basis: e.customStop ? 'custom stop' : a.basis || null, ref: a.ref || null };
}

function toPosition(base, e) {
  const lv = levelsOf(e);
  const qty = base.qty;
  return { id: base.id, ref: base.ref, asset: base.asset, market: base.market, direction: 'long', positionSize: qty, fillPrice: base.avgCost, entryPrice: base.avgCost,
    invalidation: lv.invalidation, targets: lv.targets, customLevels: lv.custom, levelsBasis: lv.basis, levelsRef: lv.ref, t1Done: !!e.t1Done,
    dollarRisk: lv.ref && lv.invalidation ? (lv.ref - lv.invalidation) * qty : null, execution: 'EXTERNAL', external: base.kind, broker: base.broker,
    strategyId: 'external', setupType: base.kind === 'manual' ? `Manual holding (${base.broker})` : `${base.broker} holding (bought outside SignalDesk)`,
    timeframe: '1d', openedAt: base.openedAt || null, syncedAt: base.syncedAt || null, feeModel: feeModel(base.market) };
}

// Every external holding in the ledger's position shape (ids ext:<id> / ext:<venue>:<asset>).
function positions() {
  const manual = state.manual.map((h) => toPosition({ id: `ext:${h.id}`, ref: h.id, kind: 'manual', broker: h.brokerLabel, asset: h.symbol, market: h.market,
    qty: h.quantity, avgCost: h.avgCost, openedAt: h.addedAt }, h));
  const broker = brokerFree().map((b) => toPosition({ id: `ext:${b.key}`, ref: b.key, kind: 'broker', broker: b.broker, asset: b.asset, market: b.market,
    qty: b.qty, avgCost: b.avgCost, syncedAt: b.syncedAt }, state.broker[b.key] || {}));
  return [...manual, ...broker];
}

const list = () => state.manual.map((h) => ({ ...h }));
const symbols = () => [...new Set(positions().map((p) => p.asset))];

module.exports = { add, update, remove, adjust, list, positions, symbols, refreshLevels, setBrokerLevels, brokerFree, STORE_PATH };
