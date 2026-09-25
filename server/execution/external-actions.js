// Portfolio Pilot actions on EXTERNAL holdings (external-holdings.js): what to
// do, and how an approval is carried out when SignalDesk did not open the trade.
//   alerts     stop hit (sell all), T2 reached (sell all), T1 reached (sell 35%,
//              once): no bracket protects these holdings, so the levels are
//              watched here, once per pipeline pass, and win over the matrix
//   decorate   the exact instruction: "Sell 1.15 shares of NVDA on Robinhood"
//   execute    MANUAL (Robinhood / other): the user trades there, then clicks
//              "Confirm Executed"; the holding is deducted (or added to) here.
//              BROKER (Coinbase / Alpaca synced): a real market order at the
//              broker, only when that venue is LIVE in Settings (Paper mode
//              never sends one); the holding updates on the next Sync Broker.
const external = require('./external-holdings');
const prices = require('../market/latest-prices');
const brokerSync = require('../connectors/broker-sync');
const coinbaseSell = require('../connectors/coinbase-sell');
const alpacaApi = require('../connectors/alpaca-api');
const { T1_SHARE } = require('../risk/protective-levels');

const MODE_KEY = { Coinbase: 'cryptoMode', Alpaca: 'stockMode' };
const unit = (p, q) => (p.market === 'stocks' ? `share${q === 1 ? '' : 's'}` : p.asset.replace('-USD', ''));
const qtyText = (p, q) => (p.market === 'stocks' ? String(Math.round(q * 1e4) / 1e4) : String(Math.round(q * 1e8) / 1e8));
const sellQty = (p, fraction) => { const f = p.market === 'stocks' ? 1e4 : 1e8; return fraction >= 1 ? p.positionSize : Math.floor(p.positionSize * fraction * f) / f; };

// Stop / T1 / T2 proposals for external holdings at the live price.
function levelAlerts(positions, priceOf, date) {
  const out = [];
  for (const p of positions) {
    const live = priceOf(p.asset);
    if (!(live > 0) || !(p.invalidation > 0)) continue;
    const t1 = p.targets[0] && p.targets[0].price;
    const t2 = p.targets[1] && p.targets[1].price;
    const base = { positionId: p.id, asset: p.asset, market: p.market, price: live, execution: 'EXTERNAL', levels: { stop: p.invalidation, t1: t1 || null, t2: t2 || null } };
    if (live <= p.invalidation) {
      out.push({ ...base, id: `pilot:STOP:${p.id}:${date}`, action: 'SELL', fraction: 1, trigger: 'STOP', reason: `Stop loss hit: ${live} <= ${p.invalidation}`,
        detail: `${p.asset} trades at ${live}, at or under its protective stop ${p.invalidation} (${p.levelsBasis || 'structural'}). Sell to cap the loss.` });
    } else if (t2 > 0 && live >= t2) {
      out.push({ ...base, id: `pilot:T2:${p.id}:${date}`, action: 'SELL', fraction: 1, trigger: 'T2', reason: `T2 reached: ${live} >= ${t2}`,
        detail: `${p.asset} reached its second target ${t2} (4.5R). Take the rest of the move.` });
    } else if (t1 > 0 && live >= t1 && !p.t1Done) {
      out.push({ ...base, id: `pilot:T1:${p.id}:${date}`, action: 'TRIM', fraction: t2 > 0 ? T1_SHARE : 1, trigger: 'T1', reason: `T1 reached: ${live} >= ${t1}`,
        detail: `${p.asset} reached its first target ${t1}. Sell ${t2 > 0 ? `${T1_SHARE * 100}%` : 'it'}; ${t2 > 0 ? `the rest runs to T2 ${t2}` : 'no T2 is set'}.` });
    }
  }
  return out;
}

// Adds what an approval card needs: kind, broker, quantity and the instruction.
function decorate(a, p) {
  const manual = p.external === 'manual';
  const q = a.action === 'ADD' ? a.quantity : sellQty(p, a.fraction);
  const verb = a.action === 'ADD' ? 'Buy' : 'Sell';
  const where = manual ? `on ${p.broker}` : `at ${p.broker} (market order, LIVE)`;
  const amount = a.action === 'ADD' ? ` (~$${a.amount.toFixed(2)})` : '';
  const what = p.market === 'stocks' ? `${qtyText(p, q)} ${unit(p, q)} of ${p.asset}` : `${qtyText(p, q)} ${unit(p, q)}`;
  const instruction = `${verb} ${what}${amount} ${where}`
    + `${a.rotation ? `, then buy ~$${a.rotation.proceeds.toFixed(2)} of ${a.rotation.asset} (its setup waits in Approvals)` : ''}`;
  return { ...a, external: p.external, broker: p.broker, manual, quantity: q, instruction, ref: p.ref };
}

// A manual ADD (the matrix's "add to a winner") becomes an Approvals card, not a
// staged setup: SignalDesk cannot buy at Robinhood.
function manualAdd(x, p, date) {
  const q = sellQty({ ...p, positionSize: x.amount / x.price }, 1);
  return decorate({ id: `pilot:ADD:${p.id}:${date}`, positionId: p.id, asset: p.asset, market: p.market, price: x.price, execution: 'EXTERNAL', action: 'ADD', fraction: 0,
    quantity: q, amount: x.amount, levels: {}, reason: `Add ~$${x.amount.toFixed(2)}: a winner pulled back`, detail: x.why }, p);
}

async function execute(a, p, settings) {
  const live = prices.getLatestPrice(p.asset);
  if (a.external === 'manual') {
    const px = live > 0 ? live : a.price;
    const q = a.action === 'ADD' ? a.quantity : Math.min(a.quantity, p.positionSize);
    const r = external.adjust(p.ref, a.action === 'ADD' ? q : -q, px, { t1Done: a.trigger === 'T1' });
    return { summary: `${a.action === 'ADD' ? 'added' : 'deducted'} ${q} ${p.asset} (${p.broker}); now ${r.quantity}`, exitPrice: px, quantity: q };
  }
  // Broker-synced: a real order, only in LIVE mode for that venue.
  if (settings[MODE_KEY[p.broker]] !== 'live') throw new Error(`BROKER_PAPER_MODE: ${p.broker} is in Paper mode in Settings, so SignalDesk sends no real order. Switch it to LIVE, or sell at ${p.broker}`);
  if (a.action === 'ADD') throw new Error('broker ADDs are staged as buy setups, not actions');
  const free = external.brokerFree().find((b) => b.key === p.ref);
  if (!free) throw new Error(`no synced ${p.asset} at ${p.broker} outside SignalDesk: press Sync Broker`);
  const q = Math.min(a.quantity, free.qty);
  const r = p.broker === 'Coinbase' ? await coinbaseSell.sellMarket(p.asset, q, a.id) : await alpacaApi.sellMarket(p.asset, q, a.id);
  if (!r.ok) throw new Error(`LIVE_ORDER_FAILED: ${r.error}`);
  console.warn(`[LIVE] ${p.broker} SELL ${q} ${p.asset} for Pilot ${a.action} ${a.id}: order ${r.brokerId}`);
  if (a.trigger === 'T1') external.setBrokerLevels(p.ref, { t1Done: true });
  setTimeout(() => brokerSync.syncPortfolio().catch(() => {}), 3000).unref(); // pick up the new balance
  return { summary: `${p.broker} order ${r.brokerId}: sell ${q} ${p.asset}`, exitPrice: live || a.price, quantity: q, brokerId: r.brokerId };
}

module.exports = { levelAlerts, decorate, manualAdd, execute };
