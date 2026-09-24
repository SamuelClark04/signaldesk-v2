// Suggested stop and target for adopting an external holding, from real candle
// history at the strategy's timeframe (Coinbase candles via history-bars.js).
//   ATR(14)  = simple average of the last 14 true ranges
//   stop     = lowest low of the last 20 bars − 0.5 × ATR   (just under support)
//              clamped to 1–4 ATR below the reference price (not too tight/wide)
//   target   = reference + 2 × (reference − stop)            (a 2R extension)
// Reference = the live price (adoption measures risk from NOW), else the last
// close. Also reports the 20-bar high as the nearest resistance, for context.
// A suggestion only: the user can edit it, and adoption re-validates everything.
const { getHistory } = require('../connectors/history-bars');

const ATR_LEN = 14;
const SWING_LEN = 20;
const BUFFER_ATR = 0.5;
const MIN_STOP_ATR = 1;
const MAX_STOP_ATR = 4;
const R_MULTIPLE = 2;

// Decimals for a price of this size: 2 above $100, 4 above $1, else 6.
const decimalsFor = (p) => (p >= 100 ? 2 : p >= 1 ? 4 : 6);
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

function atr(bars) {
  const trs = [];
  for (let i = 1; i < bars.length; i += 1) {
    const { high, low } = bars[i];
    const prevClose = bars[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const last = trs.slice(-ATR_LEN);
  return last.length ? last.reduce((s, x) => s + x, 0) / last.length : null;
}

// { ok, stopLoss, takeProfit, reference, referenceSource, atr, swingLow, swingHigh, timeframe, method, bars }
// or { ok: false, error }.
async function suggestLevels({ asset, timeframe, livePrice }) {
  const history = await getHistory(asset, timeframe);
  if (!history.ok) return { ok: false, error: `no ${timeframe} history for ${asset}: ${history.error}` };
  const bars = history.bars;
  if (bars.length < SWING_LEN + 1) return { ok: false, error: `only ${bars.length} ${timeframe} bars of history; need ${SWING_LEN + 1}` };

  const reference = livePrice > 0 ? livePrice : bars[bars.length - 1].close;
  const a = atr(bars);
  if (!(a > 0)) return { ok: false, error: 'could not measure volatility (ATR is zero)' };
  const recent = bars.slice(-SWING_LEN);
  const swingLow = Math.min(...recent.map((b) => b.low));
  const swingHigh = Math.max(...recent.map((b) => b.high));

  // Distance from the reference to the stop, kept within 1–4 ATR.
  const raw = reference - (swingLow - BUFFER_ATR * a);
  const distance = Math.min(MAX_STOP_ATR * a, Math.max(MIN_STOP_ATR * a, raw));
  const clamped = distance !== raw;
  const d = decimalsFor(reference);
  const stopLoss = round(reference - distance, d);
  const takeProfit = round(reference + R_MULTIPLE * distance, d);
  if (!(stopLoss > 0)) return { ok: false, error: 'suggested stop would be at or below zero (history too volatile)' };

  return {
    ok: true,
    stopLoss,
    takeProfit,
    reference: round(reference, d),
    referenceSource: livePrice > 0 ? 'live price' : 'last close',
    atr: round(a, d),
    swingLow: round(swingLow, d),
    swingHigh: round(swingHigh, d),
    timeframe,
    bars: bars.length,
    method: `${timeframe}: stop = ${SWING_LEN}-bar low − ${BUFFER_ATR}×ATR(${ATR_LEN})${clamped ? `, clamped to ${MIN_STOP_ATR}–${MAX_STOP_ATR} ATR` : ''}; target = ${R_MULTIPLE}R`,
  };
}

module.exports = { suggestLevels, atr, ATR_LEN, SWING_LEN, R_MULTIPLE };
