// Strategy Scorecard math (Phase 77): closed trades grouped by strategy. Pure; loads in the browser
// (window.SignalDesk.scorecard) and in Node (require) so the tests check the exact code the Journal runs.
//   one TRADE = one position: a T1 partial / Pilot trim ("<id>:trim:<ms>", parentId) and its runner count once,
//   their net P/L summed and their R = summed net / summed dollar risk (the position's original 1R)
//   win rate  trades netting > $0 · average R · profit factor = gross wins / gross losses (net of fees;
//   null = no losing trade yet) · net P/L
//   Phase 87: WHO CLOSED IT. exitBy = 'manual' (MANUAL_CLOSE: you), 'external' (closed in the venue's app) or 'system' (stop, target,
//   time exit, broker exit): the last part of the trade decides. build().exits: one row each, so the strategy's own exits and your
//   discretionary closes are judged separately (the paper options "92% win rate" was 43 manual closes; its own stops lost).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SignalDesk = root.SignalDesk || {}; root.SignalDesk.scorecard = api; }
}(typeof window !== 'undefined' ? window : this, () => {
  const LABELS = [
    ['speculative-crypto', 'Moonshots'], ['equity-swing', 'Equity Swing'], ['equity-day', 'Equity Day (ORB)'], ['options-system', 'Options Spreads'],
    ['portfolio-pilot', 'Portfolio Pilot'], ['crypto-swing', 'Crypto Swing'], ['crypto-intraday', 'Crypto Intraday'], ['options-quickflips', 'Options Quick Flips'], ['manual', 'Manual trades'],
  ];
  const NAME = Object.fromEntries(LABELS);
  const ORDER = LABELS.map(([id]) => id);
  const nameOf = (id) => NAME[id] || (String(id || '').startsWith('manual') ? NAME.manual : id || 'Other');
  const keyOf = (t) => (NAME[t.strategyId] ? t.strategyId : String(t.strategyId || '').startsWith('manual') || String(t.id).startsWith('manual:') ? 'manual' : t.strategyId || 'other');
  const baseId = (t) => t.parentId || String(t.id).replace(/:trim:\d+$/, '');
  const EXIT_LABELS = { system: 'Closed by the system (stop / target / time / broker)', manual: 'Closed by you (manual close)', external: 'Closed outside SignalDesk' };
  const exitByOf = (reason) => (/^MANUAL_CLOSE/.test(String(reason || '')) ? 'manual' : /^CLOSED_EXTERNALLY/.test(String(reason || '')) ? 'external' : 'system');

  // Journal records -> trades: [{ id, strategy, execution, net, risk, r, closedAt }].
  function trades(journal) {
    const byId = new Map();
    for (const t of journal || []) {
      if (!Number.isFinite(t.netPnl)) continue;
      const id = baseId(t);
      const x = byId.get(id) || { id, strategy: keyOf(t), execution: t.execution === 'LIVE' ? 'LIVE' : 'PAPER', net: 0, risk: 0, parts: 0, closedAt: 0, exitBy: 'system' };
      x.net += t.netPnl;
      x.risk += t.dollarRisk > 0 ? t.dollarRisk : 0;
      x.parts += 1;
      if ((Number(t.closedAt) || 0) >= x.closedAt) x.exitBy = exitByOf(t.exitReason);
      x.closedAt = Math.max(x.closedAt, Number(t.closedAt) || 0);
      byId.set(id, x);
    }
    return [...byId.values()].map((x) => ({ ...x, r: x.risk > 0 ? x.net / x.risk : null }));
  }

  // One scorecard row per strategy (known ones first, in ORDER). filter: 'all' | 'LIVE' | 'PAPER'.
  function build(journal, filter = 'all') {
    const list = trades(journal).filter((t) => filter === 'all' || t.execution === filter);
    const groups = new Map();
    for (const t of list) { if (!groups.has(t.strategy)) groups.set(t.strategy, []); groups.get(t.strategy).push(t); }
    const row = (id, ts, label = null) => {
      const wins = ts.filter((t) => t.net > 0);
      const gw = wins.reduce((s, t) => s + t.net, 0);
      const gl = -ts.filter((t) => t.net < 0).reduce((s, t) => s + t.net, 0);
      const rs = ts.filter((t) => t.r !== null);
      return { strategy: id, label: label || nameOf(id), trades: ts.length, wins: wins.length, winRate: ts.length ? wins.length / ts.length : null,
        avgR: rs.length ? rs.reduce((s, t) => s + t.r, 0) / rs.length : null, profitFactor: gl > 0 ? gw / gl : null, grossWin: gw, grossLoss: gl,
        net: ts.reduce((s, t) => s + t.net, 0), live: ts.filter((t) => t.execution === 'LIVE').length };
    };
    const rows = [...groups.entries()].map(([id, ts]) => row(id, ts))
      .sort((a, b) => ((ORDER.indexOf(a.strategy) + 1) || 99) - ((ORDER.indexOf(b.strategy) + 1) || 99));
    const exits = ['system', 'manual', 'external'].map((k) => row(`exit:${k}`, list.filter((t) => t.exitBy === k), EXIT_LABELS[k])).filter((r) => r.trades > 0);
    return { rows, total: row('all', list), exits, filter };
  }

  return { build, trades, nameOf, exitByOf, LABELS, EXIT_LABELS };
}));
