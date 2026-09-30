// An option position's NET natural bid / ask (Phase 82 / 83), shared by the entry shield (OPTIONS_SPREAD_TOO_WIDE),
// the risk engine (1R from the expected exit fill) and the limit exits (execution/spread-exit.js).
//   natural ask = what buying the package costs  = buy legs at their ask - sell legs at their bid
//   natural bid = what selling the package fetches = buy legs at their bid - sell legs at their ask
// From the legs' own quotes (optionsData.legs[].bid / ask, or `quotes` given in leg order); else the plan's
// netMid +/- half its combinedLegSpread. -> { bid, ask, mid, width, pct } | null (no quotes).
function spreadWidth(od, quotes = null) {
  const legs = (od && od.legs) || [];
  const q = (l, i) => (quotes ? quotes[i] : l);
  if (legs.length && legs.every((l, i) => q(l, i) && q(l, i).bid >= 0 && q(l, i).ask > 0 && q(l, i).ask >= q(l, i).bid)) {
    let ask = 0; let bid = 0;
    legs.forEach((l, i) => {
      const x = q(l, i); const r = l.ratio || 1;
      if (l.side === 'sell') { ask -= x.bid * r; bid -= x.ask * r; } else { ask += x.ask * r; bid += x.bid * r; }
    });
    const mid = (ask + bid) / 2;
    return mid > 0 ? { bid, ask, mid, width: ask - bid, pct: (ask - bid) / mid } : null;
  }
  if (od && od.netMid > 0 && od.combinedLegSpread >= 0) {
    return { bid: od.netMid - od.combinedLegSpread / 2, ask: od.netMid + od.combinedLegSpread / 2, mid: od.netMid, width: od.combinedLegSpread, pct: od.combinedLegSpread / od.netMid };
  }
  return null;
}

// Per-share risk to the stop at the EXPECTED EXIT FILL (Phase 83): the stop triggers on the value (mid) reaching
// exitRule.stopValue, and a sale then fetches about half the bid / ask gap less. -> debit - (stopValue - half width),
// never more than the whole debit (the most a debit spread can lose), never less than the plan's own riskPerShare.
function expectedExitRisk(od) {
  const debit = od.debit;
  const stop = od.exitRule && Number.isFinite(od.exitRule.stopValue) ? od.exitRule.stopValue : null;
  const plan = od.riskPerShare > 0 ? od.riskPerShare : debit;
  if (stop === null) return plan;
  const w = spreadWidth(od);
  const half = w ? w.width / 2 : 0;
  return Math.min(debit, Math.max(plan, debit - (stop - half)));
}

module.exports = { spreadWidth, expectedExitRisk };
