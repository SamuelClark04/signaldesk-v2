// Portfolio Pilot, 4-action matrix for open holdings. PROPOSER ONLY: returns
// proposals; the pilot handler turns them into Approvals items / staged buys and
// nothing executes without the user's approval. Every open stock/crypto long
// (not options, not intraday trades) gets exactly one verdict, on real daily bars:
//   SELL + ROTATE  the last close AND the live price are under the 200-day SMA:
//                  sell it all, and redeploy the proceeds into the #1 ranked
//                  leader not already at the 30% cap (a paired rotation buy)
//   TRIM (1/3)     (a) weight over 30% of the account, (b) price more than 50%
//                  above the 200-day SMA, or (c) far above the 50-day SMA by
//                  percent AND ATRs (stocks 20% and 3 ATR; crypto 35% and 4 ATR)
//   ADD            a winner: price > 50-day > 200-day SMA, trend score >= 70,
//                  weight under 18%, pulled back to within 3% of its 20- or
//                  50-day SMA: buy up to the 18% weight
//   HOLD           healthy: shown with its buffer over the 200-day SMA and weight
// Weight = position value / the equity of ITS OWN BOOK (ctx.equityOf, from the
// pilot handler; Phase 54): paper positions against the paper account (bankroll
// + realized and open paper P&L), real holdings (SignalDesk's LIVE trades,
// adopted, manual Robinhood / other and broker-synced) against the REAL equity
// (their value + synced broker cash). The paper bankroll never dilutes a real
// holding's weight, so $10.70 of ETHFI in a $554 account is 1.9%, not 0.3%.
// ADD (and the rotation buys) only ever go to the Tier-1 core leaders (the
// ranker's universe: BTC ETH SOL LINK AVAX SPY QQQ NVDA AAPL MSFT META AMZN
// GOOGL AVGO TSLA AMD COST LLY); speculative altcoins are held or cut, never added to.
// A newer listing (30-219 daily sessions, Phase 55) is judged against its longest
// available average (the 50-day, else the 20-day SMA) instead of waiting for 200.
const { dailyBars, scoreAsset, CONFIG: RANK, UNIVERSE } = require('./pilot-ranker');
const CORE = new Set(UNIVERSE);

const CONFIG = {
  trimFraction: 1 / 3, maxWeight: 0.30, overSma200: 0.50, extended: { stocks: { pct: 0.2, atr: 3 }, crypto: { pct: 0.35, atr: 4 } },
  addMinScore: 70, addMaxWeight: 0.18, addNearPct: 0.03, minAdd: 25,
  skipStrategies: new Set(['equity-day', 'crypto-intraday', 'speculative-crypto']), // short-term trades have their own exits
};
const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const decimals = (x) => (x >= 100 ? 2 : x >= 1 ? 4 : Math.min(10, 3 - Math.floor(Math.log10(x))));
const round = (x) => { const f = 10 ** decimals(x); return Math.round(x * f) / f; };
const pct = (x) => `${(x * 100).toFixed(1)}%`;

// positions: open positions; priceOf(asset) -> live price; ctx: { equity, ranking }.
// -> { actions: [SELL/TRIM proposals for the Approvals queue], adds: [{ asset, amount, why, positionId }],
//      rotations: [{ actionId, from, proceeds, to, why }], matrix: [{ asset, action, ... }] }
async function review(positions, priceOf, ctx, now = Date.now()) {
  const date = etDate.format(now);
  const out = { actions: [], adds: [], rotations: [], matrix: [] };
  const leaders = (ctx.ranking || []).filter((r) => r.qualified && !r.extended && r.live);
  for (const p of positions) {
    if (p.market === 'options' || p.direction === 'short' || CONFIG.skipStrategies.has(p.strategyId)) continue;
    const live = priceOf(p.asset);
    const tag = { execution: p.execution || 'PAPER', external: p.external || null, broker: p.broker || null };
    if (!(live > 0)) { out.matrix.push({ positionId: p.id, asset: p.asset, ...tag, action: 'WAIT', reason: 'No live price' }); continue; }
    const bars = await dailyBars(p.asset, now);
    const s = scoreAsset(p.asset, bars, live, ctx.ranking);
    if (!s) { out.matrix.push({ positionId: p.id, asset: p.asset, ...tag, action: 'WAIT', reason: `Only ${bars.length} daily sessions (needs ${RANK.minSessions})` }); continue; }
    const { ind } = s;
    const avg = `${ind.basis}-day SMA${ind.basis < RANK.sma200 ? ` (${ind.sessions} sessions listed: longest average available)` : ''}`;
    const value = p.positionSize * live;
    const equity = ctx.equityOf ? ctx.equityOf(p) : ctx.equity;
    const weight = equity > 0 ? value / equity : null;
    const base = { positionId: p.id, asset: p.asset, market: p.market, price: live, execution: p.execution || 'PAPER', adopted: !!p.adopted,
      levels: { sma200: round(ind.s200), sma50: round(ind.s50), sma20: round(ind.s20), atr: round(ind.atr) } };
    const row = { positionId: p.id, asset: p.asset, weight, equity, buffer200: ind.buffer200, basis: ind.basis, score: s.score, value, execution: p.execution || 'PAPER',
      external: p.external || null, broker: p.broker || null, adopted: !!p.adopted, core: CORE.has(p.asset) };
    const ext = CONFIG.extended[p.market] || CONFIG.extended.stocks;

    if (ind.lastClose < ind.s200 && live < ind.s200) {
      const id = `pilot:SELL:${p.id}:${date}`;
      const to = leaders.find((r) => r.asset !== p.asset);
      const rotation = to ? { asset: to.asset, score: to.score, proceeds: Math.floor(value * 100) / 100 } : null;
      out.actions.push({ ...base, id, action: 'SELL', fraction: 1, rotation, reason: `Below the ${ind.basis}-day average: sell${rotation ? ` and rotate into ${to.asset}` : ' (no leader to rotate into: cash)'}`,
        detail: `${p.asset} closed at ${round(ind.lastClose)} and trades at ${round(live)}, under its ${avg} ${round(ind.s200)}. The long-term trend has broken.`
          + `${rotation ? ` Proceeds (~$${rotation.proceeds.toFixed(2)}) go to ${to.asset}, the #1 ranked leader (score ${to.score}); that buy waits in Approvals as its own setup.` : ''}` });
      if (rotation) out.rotations.push({ actionId: id, from: p.asset, positionId: p.id, proceeds: rotation.proceeds, to: to.asset, price: to.price,
        why: `Rotation: ${p.asset} fell under its ${ind.basis}-day SMA; its ~$${rotation.proceeds.toFixed(2)} is redeployed into the #1 ranked leader ${to.asset} (${to.reason}).` });
      out.matrix.push({ ...row, action: 'SELL + ROTATE', reason: `Under the ${avg} ${round(ind.s200)}${rotation ? `; rotate into ${to.asset}` : ''}` });
      continue;
    }
    const trims = [
      weight !== null && weight > CONFIG.maxWeight ? `${pct(weight)} of the account (over ${CONFIG.maxWeight * 100}%)` : null,
      ind.buffer200 > CONFIG.overSma200 ? `${pct(ind.buffer200)} above the ${ind.basis}-day SMA (over ${CONFIG.overSma200 * 100}%)` : null,
      live >= ind.s50 * (1 + ext.pct) && live - ind.s50 >= ext.atr * ind.atr ? `${pct(ind.ext50)} and ${((live - ind.s50) / ind.atr).toFixed(1)} ATR above the 50-day SMA` : null,
    ].filter(Boolean);
    if (trims.length) {
      out.actions.push({ ...base, id: `pilot:TRIM:${p.id}:${date}`, action: 'TRIM', fraction: CONFIG.trimFraction, reason: `Trim a third: ${trims[0]}`,
        detail: `${p.asset} at ${round(live)}: ${trims.join('; ')}. Selling a third locks in part of the move; the rest keeps its stop and targets.` });
      out.matrix.push({ ...row, action: 'TRIM', reason: trims.join('; ') });
      continue;
    }
    const near = [ind.s20, ind.s50].some((m) => live >= m * 0.99 && live <= m * (1 + CONFIG.addNearPct));
    const amount = weight !== null ? Math.floor((CONFIG.addMaxWeight - weight) * equity * 100) / 100 : 0;
    if (CORE.has(p.asset) && ind.basis === RANK.sma200 && live > ind.s50 && ind.s50 > ind.s200 && s.score >= CONFIG.addMinScore && weight !== null && weight < CONFIG.addMaxWeight && near && amount >= CONFIG.minAdd) {
      const why = `ADD: ${p.asset} is a winner (price > 50d > 200d SMA, trend score ${s.score}) pulled back near its 20/50-day SMA, at ${pct(weight)} of the account; this adds up to ${CONFIG.addMaxWeight * 100}%.`;
      out.adds.push({ asset: p.asset, positionId: p.id, amount, price: live, why });
      out.matrix.push({ ...row, action: 'ADD', reason: `Score ${s.score}, near the ${live <= ind.s20 * (1 + CONFIG.addNearPct) ? '20' : '50'}-day SMA; add ~$${amount.toFixed(2)}` });
      continue;
    }
    out.matrix.push({ ...row, action: 'HOLD', reason: `${pct(ind.buffer200)} above the ${avg} ${round(ind.s200)}${weight !== null ? `, ${pct(weight)} of the account` : ''}; trend score ${s.score}`
      + `${CORE.has(p.asset) ? '' : ' (speculative: held or cut, never added to)'}` });
  }
  return out;
}

module.exports = { review, CONFIG };
