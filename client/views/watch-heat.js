// Market Watch "heating up" filter: with 83 monitored symbols, the rail lists
// only the ones worth watching now:
//   - within 1.5% of a strategy trigger (server TRIGGER_PROXIMITY, strategies' own maths)
//   - a setup in the approvals queue
//   - an open position (paper, live or adopted)
//   - the symbol currently on the chart (so it never vanishes under you)
// While searching, the whole universe is searchable instead.
// Exposes window.SignalDesk.watchHeat.
(() => {
  const SD = window.SignalDesk;

  function universe(state) {
    const u = state.universe;
    return u ? [...u.stocks, ...u.crypto] : Object.keys(state.prices || {});
  }

  // [{ symbol, reason: 'trigger'|'queue'|'position'|'selected', tag, title }], hottest first.
  function heating(state, { selected, searching, keep }) {
    const out = new Map();
    const add = (symbol, reason, tag, title) => { if (!out.has(symbol) && keep(symbol)) out.set(symbol, { symbol, reason, tag, title }); };
    for (const p of (state.proximity && state.proximity.items) || []) {
      add(p.symbol, 'trigger', `${(p.distancePct * 100).toFixed(2)}%`, `${p.label} · ${(p.distancePct * 100).toFixed(2)}% away (${p.strategyId})`);
    }
    for (const o of state.pending || []) add(o.asset, 'queue', 'Queued', `${o.setupType || 'Setup'} in the approvals queue`);
    for (const p of state.positions || []) add(p.asset, 'position', p.adopted ? 'Adopted' : 'Open', `${p.execution === 'LIVE' ? 'LIVE' : 'Paper'} position`);
    if (searching) for (const s of universe(state)) add(s, 'search', '', '');
    if (selected) add(selected, 'selected', '', 'Currently on the chart');
    return [...out.values()];
  }

  function caption(state, list) {
    const total = universe(state).length;
    const near = list.filter((x) => x.reason === 'trigger').length;
    const th = state.proximity && state.proximity.thresholdPct ? `${(state.proximity.thresholdPct * 100).toFixed(1)}%` : '1.5%';
    return `Showing ${list.length} of ${total} · ${near} within ${th} of a trigger, plus queue and positions`;
  }

  SD.watchHeat = { heating, caption, universe };
})();
