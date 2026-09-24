// Market-maker expected move from the at-the-money straddle.
// Rule of thumb: ~85% of the ATM straddle price approximates a one standard
// deviation move to that option's expiration.
const STRADDLE_FACTOR = 0.85;

function calculateExpectedMove(atmCallPrice, atmPutPrice) {
  const call = Number(atmCallPrice);
  const put = Number(atmPutPrice);
  if (!Number.isFinite(call) || !Number.isFinite(put) || call < 0 || put < 0) {
    throw new Error('expected-move: option prices must be non-negative numbers');
  }
  return (call + put) * STRADDLE_FACTOR;
}

module.exports = { calculateExpectedMove, STRADDLE_FACTOR };
