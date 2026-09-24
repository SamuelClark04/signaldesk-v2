// Portfolio Attention: one plain-language alert per open position, from live data.
// Read-only: it never touches the ledger's state or places anything.
//
// Rules, most urgent first (each position gets the first that matches):
//   no fresh price          -> exits can't be managed on paper / verify at broker
//   within 25% of the stop  -> "Near stop"
//   intraday setup overnight-> "Held past its timeframe"
//   unrealized >= +10%      -> "Review taking profits" (options: underlying 75% of
//                              the way to T1; no live option prices to mark them)
//   held > 7 days           -> "Trend check required"
//   otherwise               -> "Hold"
// No open positions -> a single "cash ready to deploy" note.
const ledger = require('../execution/paper-ledger');

const PROFIT_REVIEW_PCT = 0.10;
const NEAR_STOP_FRACTION = 0.25;
const STALE_HOLD_MS = 7 * 24 * 60 * 60 * 1000;
const INTRADAY_TIMEFRAMES = new Set(['1m', '5m', '15m']);

const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const lookup = (src, key) => (src instanceof Map ? src.get(key) : src && src[key]);
const fmtPct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

// What was paid for the position (the base for % P/L).
function costBasis(p) {
  if (p.market === 'options' && p.optionsData) return p.positionSize * p.optionsData.debit * p.optionsData.multiplier;
  return p.positionSize * p.fillPrice;
}

function alertFor(p, livePrice, now) {
  const where = p.adopted ? `adopted at ${p.broker} (alerts only)` : p.execution === 'LIVE' ? `LIVE at ${p.broker}` : 'paper';
  const base = { asset: p.asset, positionId: p.id, execution: p.execution || 'PAPER' };

  if (!(livePrice > 0)) {
    return { ...base, tone: 'warn', action: 'No live price',
      detail: p.adopted ? `Feed is quiet: SignalDesk cannot watch its levels, and no orders protect it at ${p.broker}`
        : p.execution === 'LIVE' ? 'Feed is quiet; the broker bracket still protects it, but verify at the broker'
        : 'Feed is quiet; paper stop/target checks are paused until prices return' };
  }

  const long = p.direction !== 'short';
  const t1 = p.targets && p.targets[0] && p.targets[0].price;
  // Adopted holdings have no orders at the broker: when a level is reached,
  // the ONLY exit is the user selling there, so say so first.
  if (p.adopted && (long ? livePrice <= p.invalidation : livePrice >= p.invalidation)) {
    return { ...base, tone: 'warn', action: 'Stop level hit: sell at broker', detail: `${p.asset} ${livePrice} is through your stop ${p.invalidation}; nothing sells it automatically (no orders at ${p.broker})` };
  }
  if (p.adopted && t1 > 0 && (long ? livePrice >= t1 : livePrice <= t1)) {
    return { ...base, tone: 'warn', action: 'Target reached: sell at broker', detail: `${p.asset} ${livePrice} reached your target ${t1}; nothing sells it automatically (no orders at ${p.broker})` };
  }
  const toTarget = t1 > 0 ? (livePrice - p.fillPrice) / (t1 - p.fillPrice) : 0;
  let pct;
  let status;
  if (p.market === 'options') {
    // No live option prices: the ledger's legs value is the value AT EXPIRY, which
    // right after entry says "-90%" for a healthy spread. Report the underlying's
    // progress instead of a fictional option P/L.
    pct = null;
    status = `underlying ${livePrice} (${fmtPct(livePrice / p.fillPrice - 1)} from entry) · ${Math.round(toTarget * 100)}% of the way to T1 · ${where}`;
  } else {
    const pnl = ledger.unrealizedPnl(p, livePrice);
    const cost = costBasis(p);
    pct = cost > 0 ? pnl / cost : 0;
    const r = p.dollarRisk > 0 ? pnl / p.dollarRisk : 0;
    status = `${fmtPct(pct)} (${r >= 0 ? '+' : ''}${r.toFixed(2)}R) · ${where}`;
  }

  const span = long ? p.fillPrice - p.invalidation : p.invalidation - p.fillPrice;
  const left = long ? livePrice - p.invalidation : p.invalidation - livePrice;
  if (span > 0 && left / span <= NEAR_STOP_FRACTION) {
    return { ...base, tone: 'warn', action: 'Near stop', detail: `${status}; stop at ${p.invalidation}` };
  }

  const intraday = INTRADAY_TIMEFRAMES.has(String(p.timeframe));
  if (intraday && etDate.format(p.openedAt) !== etDate.format(now)) {
    return { ...base, tone: 'warn', action: 'Held past its timeframe', detail: `${p.timeframe} setup open since ${etDate.format(p.openedAt)}; ${status}` };
  }
  // Profit review: +10% on the position, or (options) 75% of the way to T1.
  if (pct === null ? toTarget >= 0.75 : pct >= PROFIT_REVIEW_PCT) {
    return { ...base, tone: 'ok', action: 'Review taking profits', detail: status };
  }
  if (now - p.openedAt > STALE_HOLD_MS) {
    const days = Math.floor((now - p.openedAt) / 86400000);
    return { ...base, tone: 'info', action: 'Trend check required', detail: `Held ${days} days; ${status}` };
  }
  return { ...base, tone: 'ok', action: 'Hold', detail: status };
}

const SEVERITY = { warn: 0, info: 1, ok: 2 };

function generateAttentionAlerts(activePositions, latestPrices = new Map(), now = Date.now()) {
  const positions = activePositions || [];
  if (!positions.length) {
    return [{ asset: 'Portfolio', tone: 'info', action: 'No active positions', detail: 'Cash ready to deploy.' }];
  }
  return positions
    .map((p) => alertFor(p, lookup(latestPrices, p.asset), now))
    .sort((a, b) => SEVERITY[a.tone] - SEVERITY[b.tone]);
}

module.exports = { generateAttentionAlerts, PROFIT_REVIEW_PCT, NEAR_STOP_FRACTION };
