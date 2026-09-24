// Strategy 5: Options Intelligence with the IV Crush Shield.
// PROPOSER ONLY: reads live prices and the options chain, returns Canonical
// Candidates (same schema as 1-equity-day.js). Never sizes, stages or executes.
//
// IV Crush Shield: when implied volatility is rich (IVP > 80), buying a single
// leg overpays for premium that deflates after the event, so the setup becomes a
// vertical debit spread (the short leg finances the long one). Otherwise a
// single-leg call.
//
// market 'options': the risk engine sizes in contracts from optionsData.debit
// (max loss = debit × multiplier), and the ledger values the position from its
// legs. Entry zone, invalidation and targets are UNDERLYING price levels: they
// drive the approval guard and the exit monitor.
// Until the real chain is wired, debit and strikes are simulated (see CONFIG).
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
  minStopPct: 0.0035, // minimum underlying distance to the invalidation level
  spreadDebitFraction: 0.6, // SIMULATED: vertical debit ≈ 60% of the ATM call
  strikeIncrement: 1, // SIMULATED: strikes on $1 increments
  multiplier: 100, // shares per standard equity option contract
};

const toStrike = (x) => Math.round(x / CONFIG.strikeIncrement) * CONFIG.strikeIncrement;

// Long ATM call; the spread sells a call at the top of the expected move (T1),
// which caps the payoff exactly where the trade takes profit anyway.
function buildOptionsData(shielded, livePrice, t1, callPrice) {
  const longStrike = toStrike(livePrice);
  const legs = [{ side: 'buy', type: 'call', strike: longStrike, ratio: 1 }];
  if (!shielded) return { debit: callPrice, multiplier: CONFIG.multiplier, legs };

  const shortStrike = Math.max(toStrike(t1), longStrike + CONFIG.strikeIncrement);
  legs.push({ side: 'sell', type: 'call', strike: shortStrike, ratio: 1 });
  return { debit: cents(callPrice * CONFIG.spreadDebitFraction), multiplier: CONFIG.multiplier, legs };
}

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
  const optionsData = buildOptionsData(shielded, livePrice, t1, callPrice);
  const strikes = optionsData.legs.map((l) => `${l.side} ${l.strike}C`).join(' / ');

  return {
    // One options idea per asset per day, whichever structure the shield picked.
    id: `${STRATEGY_ID}:LONG:${asset}:${date}`,
    asset,
    market: 'options',
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
      `${strikes} for ${optionsData.debit} debit (max loss $${cents(optionsData.debit * optionsData.multiplier)} per contract)`,
      'Stop and target are underlying levels; strikes and debit are simulated until the live chain is wired',
    ],
    timestamp: new Date(now).toISOString(),
    optionsData,
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
