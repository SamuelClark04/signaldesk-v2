// Strategy 5: Options Intelligence with the IV Crush Shield.
// PROPOSER ONLY: reads live prices and the options chain, returns Canonical
// Candidates (same schema as 1-equity-day.js). Never sizes, stages or executes.
//
// IV Crush Shield: when implied volatility is rich (IVP > 80), buying a single
// leg overpays for premium that deflates after the event, so the setup becomes a
// vertical debit spread (the short leg finances the long one). Otherwise a
// single-leg call.
//
// NOTE: the risk engine and ledger size and track the UNDERLYING (market
// 'stocks'); there is no contract/premium model yet. Entry, stop and target
// below are underlying prices.
const { getATMStraddle } = require('../connectors/options-chain');
const { calculateExpectedMove } = require('../intelligence/expected-move');

const STRATEGY_ID = 'options-system';
const IVP_SHIELD_THRESHOLD = 80;

// Placeholder triggers until a real options signal exists: go long when the
// underlying trades above a level.
const TRIGGERS = { AAPL: { above: 100 } };

const CONFIG = {
  entryBufferPct: 0.002, // entry zone: live price up to +0.2%
  stopFractionOfMove: 0.5, // invalidation at half the expected move below entry => T1 ~ 2R
  minStopPct: 0.0035, // keep clear of the risk engine's ~0.29% stock cost floor
};

const cents = (x) => Math.round(x * 100) / 100;
const lookup = (src, key) => (src instanceof Map ? src.get(key) : src && src[key]);

const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

async function buildCandidate(asset, livePrice, now) {
  const { callPrice, putPrice, ivp } = await getATMStraddle(asset);
  const expectedMove = calculateExpectedMove(callPrice, putPrice);
  if (!(expectedMove > 0)) return null;

  const shielded = ivp > IVP_SHIELD_THRESHOLD;
  const setupType = shielded ? 'Vertical Debit Spread' : 'Single Leg Call';

  const entryMax = cents(livePrice * (1 + CONFIG.entryBufferPct));
  const stopDistance = Math.max(expectedMove * CONFIG.stopFractionOfMove, entryMax * CONFIG.minStopPct);
  const invalidation = Math.floor((entryMax - stopDistance) * 100) / 100;
  if (!(invalidation > 0)) return null;

  const t1 = cents(livePrice + expectedMove);
  const date = etDate.format(now);

  return {
    // One options idea per asset per day, whichever structure the shield picked.
    id: `${STRATEGY_ID}:LONG:${asset}:${date}`,
    asset,
    market: 'stocks',
    strategyId: STRATEGY_ID,
    setupType,
    direction: 'long',
    timeframe: '1d',
    entryZone: { min: cents(livePrice), max: entryMax },
    invalidation,
    targets: [{ level: 1, price: t1, allocation: 1 }],
    catalyst: { type: 'volatility', headline: null, sentimentScore: 0 },
    thesis: `${asset} at ${cents(livePrice)} with an ATM straddle of ${cents(callPrice + putPrice)} implies a `
      + `±${cents(expectedMove)} expected move. IV percentile ${ivp} is `
      + `${shielded ? `above ${IVP_SHIELD_THRESHOLD}: IV Crush Shield on, use a vertical debit spread` : `at or below ${IVP_SHIELD_THRESHOLD}: single-leg call`}. `
      + `Target the top of the expected move (${t1}); invalid below ${invalidation}.`,
    confirmationCriteria: [
      `${asset} trading above trigger level ${TRIGGERS[asset].above}`,
      `Expected move ±${cents(expectedMove)} = (call ${callPrice} + put ${putPrice}) × 0.85`,
      `IVP ${ivp} ${shielded ? '>' : '≤'} ${IVP_SHIELD_THRESHOLD} → ${setupType}`,
      'Levels are on the underlying; the ledger simulates the underlying, not option premium',
    ],
    timestamp: new Date(now).toISOString(),
  };
}

async function generateCandidates(latestPricesMap, now = Date.now()) {
  const candidates = [];
  for (const [asset, trigger] of Object.entries(TRIGGERS)) {
    const livePrice = lookup(latestPricesMap, asset);
    if (!(livePrice > trigger.above)) continue;
    try {
      const candidate = await buildCandidate(asset, livePrice, now);
      if (candidate) candidates.push(candidate);
    } catch (err) {
      console.error(`[options-system] ${asset} failed: ${err.message}`);
    }
  }
  return candidates;
}

module.exports = { generateCandidates, STRATEGY_ID, IVP_SHIELD_THRESHOLD, TRIGGERS };
