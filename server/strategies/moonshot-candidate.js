// Moonshot setup builder (Phase 83 split from 6-speculative-crypto.js, unchanged logic): an ARMED trigger whose pullback
// arrived -> the Canonical Candidate (entry zone capped at the retest, stop / T1 / T2 from that price, the entry snapshot,
// the plain-English entry reason, thesis and confirmation criteria). k: the strategy's constants and helpers
// { CONFIG, LABEL, HOLD, TAG, STRATEGY_ID, round, pct, clamp01, describe }.
function candidate(k, symbol, w, live, entryMax, stop, now) {
  const { CONFIG, LABEL, HOLD, TAG, STRATEGY_ID, round, pct, clamp01, describe } = k;
  const { kind, s, a, buzz, news, watchRow, move, change24h } = w;
  const invalidation = stop.price;
  const risk = entryMax - invalidation;
  const [t1R, t2R] = kind === 'COIL' ? [CONFIG.coilT1R, CONFIG.coilT2R] : [CONFIG.t1R, CONFIG.t2R];
  const conviction = Math.round(clamp01((s.total - CONFIG.qualify) / (100 - CONFIG.qualify)) * 100) / 100;
  const why = [buzz.reddit.titles[0], buzz.trending ? `CoinGecko trending #${buzz.trending.rank}` : null, news.ok && news.score !== null ? `news ${news.score}/100 (${news.label})` : null].filter(Boolean);
  const found = watchRow && watchRow.reasons.length ? ` On the gem watchlist for: ${watchRow.reasons.join(', ')}.` : '';
  const retest = `Bought the pullback, not the breakout: triggered at ${round(w.triggerLive)}, bought the retest at ${entryMax} (${pct(entryMax / w.triggerLive - 1)}) ${Math.max(1, Math.round((now - w.at) / 60000))} min later`;
  // Phase 79: what the trade was entered on, kept on the record (the live radar score moves on; this does not).
  const entrySnapshot = { at: w.at, kind, score: s.total, parts: Object.fromEntries(Object.entries(s.parts).map(([k, v]) => [k, Math.round(v)])),
    relVol: Math.round((kind === 'COIL' ? a.coil.volRatio : a.ign.m.relVol) * 100) / 100, move: kind === 'COIL' ? a.coil.move : a.ign.m.surge,
    spreadPct: a.spreadPct, change24h, rsi15: w.rsi === null ? null : Math.round(w.rsi), volumeUsd: watchRow ? watchRow.volumeUsd : null, buzz: Math.round(s.parts.buzz),
    pullback: { trigger: w.triggerLive, limit: w.limit, filledAt: now } };
  const entryReason = `${LABEL[kind]}: ${move}${change24h !== null ? `; ${pct(change24h)} over 24h` : ''}. ${retest}. Conviction ${s.total}/100: ${describe(s)}. `
    + `${why.length ? `Buzz: ${why.join('; ')}.` : 'No forum or news coverage: the volume was the catalyst.'}`;
  return {
    id: `${STRATEGY_ID}:${kind === 'COIL' ? 'COIL' : 'MOON'}:${symbol}:${new Date(now).toISOString().slice(0, 16)}`,
    asset: symbol, market: 'crypto', strategyId: STRATEGY_ID, setupType: `Moonshot · ${LABEL[kind]}`, tag: TAG, speculative: true, gemTrigger: kind,
    entryLiquidity: 'maker', // a resting buy at the retest (post-only live), like the replay
    conviction, convictionScore: s.total, scoreParts: s.parts, direction: 'long', timeframe: kind === 'COIL' ? '15m' : a.ign.m.frame, tradeType: CONFIG.tradeType,
    expectedDuration: HOLD[kind], entrySnapshot, entryReason, newsSentiment: news.ok && news.score !== null ? { score: news.score, label: news.label, source: news.source } : null,
    entryZone: { min: round(live), max: entryMax },
    invalidation,
    targets: [{ level: 1, price: round(entryMax + t1R * risk), allocation: 0.5 }, { level: 2, price: round(entryMax + t2R * risk), allocation: 0.5 }],
    catalyst: { type: why.length ? 'social' : 'volume', headline: why[0] || `Volume ${(kind === 'COIL' ? a.coil.volRatio : a.ign.m.relVol).toFixed(1)}x`, sentimentScore: s.total },
    thesis: `SPECULATIVE MOONSHOT · ${LABEL[kind].toUpperCase()}. ${move} (vs BTC ${pct(w.btcVs)}).${found} ${retest}. Conviction ${s.total}/100: ${describe(s)}. `
      + `${why.length ? `Buzz: ${why.join('; ')}. ` : 'No forum or news coverage found: the volume is the catalyst. '}`
      + `Stop ${invalidation} (${((risk / entryMax) * 100).toFixed(1)}% under entry: ${stop.basis}), `
      + `T1 ${t1R}R (50%), T2 ${t2R}R. Hype moves reverse fast: sized at ${Math.round((0.1 + 0.15 * conviction) * 100)}% of normal risk.`,
    confirmationCriteria: [
      kind === 'COIL'
        ? `${a.coil.volRatio.toFixed(1)}x volume vs 6h (needs 2.8x), EMA9 > EMA21, close at ${Math.round(a.coil.closePos * 100)}% of the bar, ${pct(a.coil.move)} in 1h (needs +1.5% to +5%) above a ${pct(a.coil.baseRange)} base`
        : `${pct(a.ign.m.surge)} in ${a.ign.m.minutes} min (needs ${pct(CONFIG.surgeMin)} to ${pct(CONFIG.surgeMax)}) on ${a.ign.m.relVol.toFixed(1)}x relative volume (needs ${CONFIG.relVolMin}x)`,
      `Not chasing: ${change24h === null ? '24h change unknown' : `${pct(change24h)} over 24h`} (max +18%), 15m RSI ${w.rsi === null ? 'n/a' : w.rsi.toFixed(0)} (max 70) at the trigger`,
      `Pullback: ${round(live)} at or under the retest ${w.limit} within 1 hour of the trigger`,
      `Conviction ${s.total}/100 (needs ${CONFIG.qualify}): ${describe(s)}`,
      `Sources: ${buzz.sources}${buzz.errors.length ? ` (unavailable: ${buzz.errors.join('; ')})` : ''}`,
    ],
    timestamp: new Date(now).toISOString(),
  };
}

module.exports = { candidate };
