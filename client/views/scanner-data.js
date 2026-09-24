// Scanner data: rows, funnel counts and gate checks, derived only from real
// server state (no sample data). Pure functions; the views render them.
//   universe = watchlist + streamed symbols + last closes + staged setups
//   Live     = fresh stream price (≤5 min; its real time comes from SCAN_STATUS)
//   Ready    = staged setups; Failed = today's latest rejection for the symbol
// Exposes window.SignalDesk.scannerData.
(() => {
  const SD = window.SignalDesk;

  const NAMES = {
    SPY: 'SPDR S&P 500 ETF', QQQ: 'Invesco QQQ Trust', AAPL: 'Apple', NVDA: 'NVIDIA', MSFT: 'Microsoft',
    META: 'Meta Platforms', AMZN: 'Amazon', GOOGL: 'Alphabet', TSLA: 'Tesla', AMD: 'Advanced Micro Devices',
    'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ethereum', 'SOL-USD': 'Solana', 'AVAX-USD': 'Avalanche',
    'LINK-USD': 'Chainlink', 'DOGE-USD': 'Dogecoin', 'XRP-USD': 'XRP',
  };
  // Badge colors only (initials, no logos).
  const COLORS = { 'BTC-USD': '#f7931a', 'ETH-USD': '#627eea', 'SOL-USD': '#8b5cf6', 'AVAX-USD': '#e84142', 'LINK-USD': '#2a5ada',
    'DOGE-USD': '#c2a633', 'XRP-USD': '#64748b', NVDA: '#76b900', AMD: '#d9363e', TSLA: '#cc0000', AAPL: '#94a3b8', META: '#0668e1',
    MSFT: '#00a4ef', AMZN: '#ff9900', GOOGL: '#4285f4', SPY: '#475569', QQQ: '#475569' };

  const STATES = {
    ready: { label: 'Ready', rank: 0 },
    failed: { label: 'Rejected', rank: 1 },
    dismissed: { label: 'Dismissed', rank: 2 },
    watching: { label: 'Watching', rank: 3 },
    waiting: { label: 'Waiting for data', rank: 4 },
  };
  // Rejection label (REJECTION_STATS bucket) -> state label shown in the table.
  const FAIL_LABELS = [[/^Fee drag/, 'Cost filter failed'], [/^Expired/, 'Expired'], [/^Price escaped/, 'Price escaped'],
    [/^Price through stop/, 'Invalidated'], [/^Bankroll too small|^Position too small/, 'Size filter failed']];

  const marketOf = (s) => (s.includes('-') ? 'crypto' : 'stocks');
  const display = (asset, market) => (market === 'crypto' ? asset.replace('-', '/') : asset);
  const nameOf = (asset) => NAMES[asset] || asset;
  const colorOf = (asset) => COLORS[asset] || '#38bdf8';
  const initials = (asset) => asset.replace(/-USD$/, '').slice(0, asset.includes('-') ? 1 : 2);

  function universe(state) {
    return [...new Set([...(state.watchlist || []).map((w) => w.symbol), ...Object.keys(state.prices || {}),
      ...Object.keys(state.refPrices || {}), ...(state.pending || []).map((o) => o.asset)])].sort();
  }

  const isLive = (state, asset) => !!(state.prices && state.prices[asset] > 0);

  // { ms, text, title, live } for the price behind a row.
  function dataAge(state, asset) {
    const t = state.scan && state.scan.priceTimes && state.scan.priceTimes[asset];
    if (isLive(state, asset)) {
      const ms = t ? Math.max(0, Date.now() - t) : null;
      return { ms: ms === null ? 0 : ms, text: ms === null ? '< 5m ago' : `${SD.ui.age(t)} ago`, title: 'Live stream price', live: true };
    }
    const ref = state.refPrices && state.refPrices[asset];
    if (ref && ref.price > 0) return { ms: Date.now() - ref.time, text: `${SD.ui.age(ref.time)} ago`, title: `Last close ${new Date(ref.time).toLocaleString()}; no live price`, live: false };
    return { ms: Infinity, text: '—', title: 'No price from any source yet', live: false };
  }

  function netRR(o) {
    const s = o.scenarios || {};
    return s.t1 && s.stop && s.stop.net < 0 ? s.t1.net / -s.stop.net : null;
  }

  function buildRows(state) {
    const rows = [];
    const covered = new Set(); // `${market}|${asset}` already shown by a setup or rejection
    for (const o of state.pending || []) {
      covered.add(`${o.market}|${o.asset}`);
      rows.push({ key: o.id, asset: o.asset, market: o.market, setup: o.setupType || 'Setup', side: o.direction, timeframe: o.timeframe,
        state: 'ready', label: 'Ready', sub: 'Passed the risk engine', rr: netRR(o), data: dataAge(state, o.asset), action: 'review', order: o });
    }
    for (const r of (state.rejections && state.rejections.latest) || []) {
      const key = `${r.market}|${r.asset}`;
      if (covered.has(key)) continue;
      covered.add(key);
      const dismissed = r.reason === 'Rejected by you';
      const hit = FAIL_LABELS.find(([re]) => re.test(r.reason));
      rows.push({ key: `rej:${key}`, asset: r.asset, market: r.market || marketOf(r.asset), setup: r.setupType || '—', side: r.direction,
        timeframe: r.timeframe, state: dismissed ? 'dismissed' : 'failed', label: dismissed ? 'Dismissed' : hit ? hit[1] : 'Rejected',
        sub: dismissed ? 'You dismissed it today' : r.reason, rr: null, data: dataAge(state, r.asset), action: 'reason', rejection: r });
    }
    for (const asset of universe(state)) {
      const market = marketOf(asset);
      if (covered.has(`${market}|${asset}`)) continue;
      const live = isLive(state, asset);
      const ref = state.refPrices && state.refPrices[asset];
      rows.push({ key: `sym:${asset}`, asset, market, setup: live ? 'No setup yet' : '—', side: null, timeframe: null,
        state: live ? 'watching' : 'waiting', label: live ? 'Watching' : 'Waiting for data',
        sub: live ? 'Live · no setup proposed' : ref ? 'Market closed · last close' : 'No price yet', rr: null, data: dataAge(state, asset), action: 'watch' });
    }
    return rows.map((r) => ({ ...r, name: nameOf(r.asset), display: display(r.asset, r.market) }));
  }

  const SORTS = {
    quality: (a, b) => STATES[a.state].rank - STATES[b.state].rank || (b.rr ?? -1) - (a.rr ?? -1) || a.asset.localeCompare(b.asset),
    asset: (a, b) => a.display.localeCompare(b.display),
    rr: (a, b) => (b.rr ?? -1) - (a.rr ?? -1) || SORTS.quality(a, b),
    age: (a, b) => a.data.ms - b.data.ms || SORTS.quality(a, b),
  };

  // f: { matchesAsset(market), direction, timeframes:Set, setup, minRR, sort }. A
  // filter on a setup attribute hides rows that have no setup to compare.
  function filterRows(rows, f) {
    return rows.filter((r) => f.matchesAsset(r.market)
      && (f.direction === 'both' || r.side === f.direction)
      && (!f.timeframes.size || f.timeframes.has(r.timeframe))
      && (f.setup === 'all' || r.setup === f.setup)
      && (!(f.minRR > 0) || (r.rr !== null && r.rr >= f.minRR)))
      .sort(SORTS[f.sort] || SORTS.quality);
  }

  function funnel(state, symbols) {
    const live = symbols.filter((s) => isLive(state, s));
    const priced = symbols.filter((s) => isLive(state, s) || (state.refPrices && state.refPrices[s]));
    const proposed = new Set([...(state.pending || []).map((o) => o.asset), ...((state.rejections && state.rejections.latest) || []).map((r) => r.asset)]);
    return [
      { n: symbols.length, label: 'in universe', hint: 'Symbols the desk streams or watches' },
      { n: priced.length, label: 'priced', hint: 'Live price or last close available' },
      { n: live.length, label: 'live', hint: 'Fresh stream price: analyzed by the strategies every scan' },
      { n: proposed.size, label: 'proposed today', hint: 'A strategy proposed a setup today (staged or rejected)' },
      { n: (state.pending || []).length, label: 'ready', hint: 'Passed the risk engine; waiting in the approvals queue', last: true },
    ];
  }

  // Gate checklist for the detail panel: only checks SignalDesk really runs.
  // Each: { name, sub, value, status: 'pass'|'fail'|'wait'|'info' }.
  function gates(row, state) {
    const out = [];
    const px = state.prices && state.prices[row.asset];
    out.push({ name: 'Data freshness', sub: row.data.live ? 'Live stream price' : 'No live price', value: row.data.text, status: row.data.live ? 'pass' : 'wait' });
    const o = row.order;
    if (o) {
      const fmt = (x) => SD.ui.price(x, o);
      const long = o.direction !== 'short';
      // Same rule as the order guard: a long only escapes above the zone's max (a short below its min).
      const escaped = px > 0 && (long ? px > o.entryZone.max : px < o.entryZone.min);
      const inZone = px >= o.entryZone.min && px <= o.entryZone.max;
      out.push({ name: 'Entry zone', sub: `${fmt(o.entryZone.min)} – ${fmt(o.entryZone.max)}`, value: !(px > 0) ? 'No price' : escaped ? 'Escaped' : inZone ? 'In zone' : 'Better than zone',
        status: !(px > 0) ? 'wait' : escaped ? 'fail' : 'pass' });
      const safe = px > 0 && (long ? px > o.invalidation : px < o.invalidation);
      out.push({ name: 'Invalidation', sub: long ? 'Price above stop' : 'Price below stop', value: fmt(o.invalidation), status: !(px > 0) ? 'wait' : safe ? 'pass' : 'fail' });
      out.push({ name: 'Costs', sub: 'Fee drag within 0.35R', value: Number.isFinite(o.feeDrag) ? `${o.feeDrag.toFixed(2)}R` : '—', status: o.feeDrag <= 0.35 ? 'pass' : 'fail' });
      const bankroll = state.settings && state.settings.bankroll;
      out.push({ name: 'Risk budget', sub: `Sized to ${o.riskPct > 0 ? `${(o.riskPct * 100).toFixed(1)}%` : 'the risk profile'} of the paper bankroll`, value: bankroll > 0 ? `${((o.dollarRisk / bankroll) * 100).toFixed(2)}%` : SD.ui.money(o.dollarRisk), status: 'pass' });
      const created = Date.parse(o.timestamp) || o.stagedAt; // the guard measures from the setup's creation
      const left = created ? created + 30 * 60000 - Date.now() : null;
      out.push({ name: 'Approval window', sub: 'Order guard expires setups after 30 min', value: left === null ? '—' : left > 0 ? `${Math.ceil(left / 60000)}m left` : 'Expired', status: left === null || left > 0 ? 'pass' : 'fail' });
      if (row.rr !== null) out.push({ name: 'Net reward / risk (T1)', sub: 'After estimated fees', value: `${row.rr.toFixed(2)} : 1`, status: 'info' });
    } else if (row.rejection) {
      out.push({ name: row.label, sub: row.rejection.detail || row.rejection.reason, value: new Date(row.rejection.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), status: row.state === 'dismissed' ? 'info' : 'fail' });
    } else {
      out.push({ name: 'Strategy trigger', sub: 'No strategy has proposed a setup', value: 'None yet', status: 'wait' });
    }
    return out;
  }

  SD.scannerData = { buildRows, filterRows, funnel, gates, universe, isLive, marketOf, nameOf, colorOf, initials, STATES };
})();
