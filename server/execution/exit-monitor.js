// Part of the single ledger (paper-ledger.js owns the lists): PAPER exit checks
// on the latest prices, every pipeline pass.
//   stop first     a price that somehow satisfies both is treated as a loss
//   T1 / T2 plans  targets[0] with allocation < 1 (e.g. T1 snapped under
//                  resistance, risk/target-plan.js): T1 closes that share of the
//                  position (reducePosition, journal "TAKE_PROFIT_T1") and the
//                  runner stays open, same stop, until T2 or the stop
//   options        positions with optionsData.exitRule (System 5: single calls
//                  and vertical debit spreads) exit on the POSITION'S OWN VALUE
//                  (option-marks.js: real bids/asks of every leg, else the
//                  model): at or under exitRule.stopValue, at or over
//                  exitRule.targetValue. Older option positions use the
//                  underlying's stop / T1 like everything else.
//                  Phase 58 stop debounce: a stop needs STOP_CONFIRMATIONS (2)
//                  CONSECUTIVE evaluations (pipeline passes) with the mark (a
//                  package spread's net mid) at or under stopValue, or the
//                  underlying through its stop level, so one noisy quote tick
//                  cannot stop a trade out. The target still fires on the fill value.
// LIVE positions exit at the broker (bracket orders); the reconciler records
// those real fills, so they are skipped here. Portfolio Pilot buys since Phase 50
// carry T1 (35%) / T2 macro targets like any plan; older Pilot holdings have no
// targets and leave only at their stop or an approved Pilot SELL / TRIM.
const { saleValue } = require('./option-marks');

let L = null; // { activePositions, closePosition, reducePosition, save }
function bind(ctx) { L = ctx; }

// The next open target (T2 once T1 has filled), or null.
function nextTarget(pos) {
  const list = (pos.targets || []).filter((t) => t.price > 0);
  const open = pos.t1Filled ? list.slice(1) : list;
  if (!open.length) return null;
  const prices = open.map((t) => t.price);
  return pos.direction === 'short' ? Math.max(...prices) : Math.min(...prices);
}

// Split plan still waiting for T1: the share T1 closes, else null (close all).
function t1Share(pos) {
  const t = pos.targets || [];
  const a = t[0] && t[0].allocation;
  return !pos.t1Filled && pos.market !== 'options' && t.length > 1 && a > 0 && a < 1 ? a : null;
}

const STOP_CONFIRMATIONS = 2;
const stopHits = new Map(); // position id -> consecutive evaluations at / through the stop

function premiumExit(pos, price) {
  const rule = pos.optionsData.exitRule;
  const m = saleValue(pos, price);
  if (!m) return null;
  const mark = Number.isFinite(m.mid) ? m.mid : m.value;
  const through = pos.invalidation > 0 && (pos.direction === 'short' ? price >= pos.invalidation : price <= pos.invalidation);
  if (mark <= rule.stopValue || through) {
    const n = (stopHits.get(pos.id) || 0) + 1;
    stopHits.set(pos.id, n);
    if (n >= STOP_CONFIRMATIONS) { stopHits.delete(pos.id); return 'STOP_LOSS'; }
    return null;
  }
  stopHits.delete(pos.id);
  if (m.value >= rule.targetValue) return 'TAKE_PROFIT';
  return null;
}

// latestPricesMap: Map or object of asset -> price. Returns the journal entries closed this pass.
function monitorPositions(latestPricesMap) {
  const priceOf = (asset) => (latestPricesMap instanceof Map ? latestPricesMap.get(asset) : latestPricesMap && latestPricesMap[asset]);
  const closed = [];
  for (const pos of [...L.activePositions]) { // snapshot: closing removes from the list
    if (pos.execution === 'LIVE') continue;
    const price = priceOf(pos.asset);
    if (!(price > 0)) continue;

    if (pos.market === 'options' && pos.optionsData && pos.optionsData.exitRule) {
      const reason = premiumExit(pos, price);
      if (reason) closed.push(L.closePosition(pos.id, price, reason));
      continue;
    }
    const isLong = pos.direction !== 'short';
    const target = nextTarget(pos);
    const hitStop = isLong ? price <= pos.invalidation : price >= pos.invalidation;
    const hitTarget = target !== null && (isLong ? price >= target : price <= target);
    if (hitStop) { closed.push(L.closePosition(pos.id, price, 'STOP_LOSS')); continue; }
    if (!hitTarget) continue;
    const share = t1Share(pos);
    if (share) {
      try {
        closed.push(L.reducePosition(pos.id, share, price, 'TAKE_PROFIT_T1'));
        pos.t1Filled = true; // the runner (same object, reduced) now targets T2
        pos.t1FilledAt = Date.now();
        L.save();
        continue;
      } catch (err) {
        if (!/TRIM_TOO_SMALL/.test(err.message)) throw err; // one share / dust: take it all at T1
      }
    }
    closed.push(L.closePosition(pos.id, price, 'TAKE_PROFIT'));
  }
  return closed;
}

module.exports = { bind, monitorPositions, nextTarget };
