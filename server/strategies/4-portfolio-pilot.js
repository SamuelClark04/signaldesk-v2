// Strategy 4: Portfolio Pilot, "What to Buy" allocator.
// PROPOSER ONLY: pure math over positions and prices. Never stages or executes.
// Buy-only rebalancing: new money goes to underweight assets; nothing is sold.
const TARGET_MODEL = Object.freeze({
  'BTC-USD': 0.40,
  'ETH-USD': 0.30,
  SPY: 0.30,
});

const cents = (x) => Math.floor(x * 100) / 100; // round down: never recommend more than the deposit

function priceLookup(latestPricesMap) {
  return (asset) => (latestPricesMap instanceof Map
    ? latestPricesMap.get(asset)
    : latestPricesMap && latestPricesMap[asset]);
}

// Current market value per asset. Longs only: the pilot builds long-term holdings,
// so short day-trades are left out rather than netted against them. A position
// with no fresh price is valued at its fill price and reported in notes.
function valueHoldings(activePositions, priceOf) {
  const values = new Map();
  const notes = [];
  for (const p of activePositions) {
    if (p.direction === 'short') {
      notes.push(`${p.asset} short position excluded from portfolio value`);
      continue;
    }
    let price = priceOf(p.asset);
    if (!(price > 0)) {
      price = p.fillPrice;
      notes.push(`${p.asset} has no fresh price; valued at its fill price ${p.fillPrice}`);
    }
    values.set(p.asset, (values.get(p.asset) || 0) + p.positionSize * price);
  }
  return { values, notes };
}

function calculateAllocation(depositAmount, activePositions, latestPricesMap, model = TARGET_MODEL) {
  const deposit = Number(depositAmount);
  if (!Number.isFinite(deposit) || deposit <= 0) throw new Error('Deposit amount must be a positive number');

  const priceOf = priceLookup(latestPricesMap);
  const { values, notes } = valueHoldings(activePositions || [], priceOf);
  const portfolioValue = [...values.values()].reduce((s, v) => s + v, 0);
  const newTotal = portfolioValue + deposit;

  const rows = Object.entries(model).map(([asset, targetWeight]) => {
    const currentValue = values.get(asset) || 0;
    const targetValue = newTotal * targetWeight;
    return {
      asset,
      currentValue,
      currentWeight: portfolioValue > 0 ? currentValue / portfolioValue : 0,
      targetWeight,
      targetValue,
      shortfall: Math.max(0, targetValue - currentValue),
    };
  });

  // With no selling, shortfalls can add up to more than the deposit (whenever
  // something is overweight). Scale them down so the buys spend exactly the deposit.
  const totalShortfall = rows.reduce((s, r) => s + r.shortfall, 0);
  const scale = totalShortfall > deposit ? deposit / totalShortfall : 1;
  if (scale < 1) {
    notes.push('Holdings above target or outside the model take up part of the total; buys scaled to fit the deposit (no selling)');
  }

  const recommendations = rows.map(({ shortfall, ...r }) => {
    const recommendedBuyAmount = cents(shortfall * scale);
    const price = priceOf(r.asset);
    return {
      ...r,
      recommendedBuyAmount,
      price: price > 0 ? price : null,
      estimatedUnits: price > 0 ? recommendedBuyAmount / price : null,
    };
  });

  const allocated = recommendations.reduce((s, r) => s + r.recommendedBuyAmount, 0);
  const unpriced = recommendations.filter((r) => r.price === null && r.recommendedBuyAmount > 0).map((r) => r.asset);
  if (unpriced.length) notes.push(`No fresh price for ${unpriced.join(', ')}; units not estimated`);
  const nonModel = [...values.keys()].filter((a) => !(a in model));
  if (nonModel.length) notes.push(`Counted in portfolio value but not in the model: ${nonModel.join(', ')}`);

  return {
    deposit,
    portfolioValue,
    newTotal,
    unallocated: Math.max(0, Math.round((deposit - allocated) * 100) / 100),
    recommendations,
    notes,
  };
}

module.exports = { calculateAllocation, TARGET_MODEL };
