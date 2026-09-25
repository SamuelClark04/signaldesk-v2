// Options statistics rows (Phase 58), shared by the Setups risk panel, the
// Approvals card and the open-position panel. From optionsData.stats (at entry /
// staging) or optionMark.stats (live, server risk/spread-stats.js): net Greeks
// across both legs, IV vs 20-day HV, max value / profit, expiry breakeven, POP,
// and the underlying T1 at mid-hold.
// Exposes window.SignalDesk.optionStats.rows(o, stats, spot) -> [[label, value, cls], ...].
(() => {
  const SD = window.SignalDesk;
  const { money } = SD.ui;
  const usd = (x) => `${x >= 0 ? '+' : '−'}$${Math.abs(x).toFixed(Math.abs(x) < 10 ? 2 : 0)}`;
  const pct1 = (x) => `${(x * 100).toFixed(1)}%`;
  const shortDate = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  // o: the order / position (optionsData + targets); s: stats; spot: the underlying now (else entry).
  function rows(o, s, spot) {
    const od = o.optionsData || {};
    if (!s) return [];
    const bear = od.type === 'put';
    const out = [];
    if (Number.isFinite(s.netDelta)) {
      out.push(['Net delta', `${s.netDelta.toFixed(2)} · ${usd(Math.abs(s.deltaUsd))} per $1 ${bear ? 'drop' : 'rise'}`, Math.abs(s.netDelta) < 0.2 ? 'text-short' : '']);
    }
    if (Number.isFinite(s.thetaDay)) out.push(['Net theta', `${usd(s.thetaDay)}/day${Number.isFinite(s.vegaUsd) ? ` · vega ${usd(s.vegaUsd)} / vol pt` : ''}`, s.thetaDay < 0 ? 'text-short' : 'text-long']);
    if (s.iv) out.push(['IV vs 20d HV', s.hv ? `IV ${pct1(s.iv)} vs HV ${pct1(s.hv)} · ${s.iv <= s.hv ? 'cheap premium' : 'rich premium'}` : `IV ${pct1(s.iv)} (HV n/a)`]);
    if (s.maxValue) out.push(['Max value / profit', `${(s.maxValue / 100).toFixed(2)} width (${money(s.maxValue)}) · max profit ${usd(s.maxProfit)} (${s.maxProfitPct >= 0 ? '+' : ''}${Math.round(s.maxProfitPct * 100)}%)`, 'text-long']);
    const ref = spot > 0 ? spot : od.refSpot;
    if (s.breakeven) out.push(['Expiry breakeven', `$${s.breakeven.toFixed(2)}${ref > 0 ? ` (${s.breakeven / ref - 1 >= 0 ? '+' : ''}${((s.breakeven / ref - 1) * 100).toFixed(2)}% from spot)` : ''}`]);
    if (Number.isFinite(s.pop)) out.push(['Prob. of profit', `${Math.round(s.pop * 100)}% (at expiry, from IV)`]);
    const t1 = o.targets && o.targets[0] && o.targets[0].price;
    if (t1 && od.midHoldAt) out.push(['Underlying T1 (mid-hold)', `${o.asset} ${t1} by ~${shortDate(od.midHoldAt)} (spread worth ${od.exitRule ? od.exitRule.targetValue : '—'})`]);
    return out;
  }

  SD.optionStats = { rows };
})();
