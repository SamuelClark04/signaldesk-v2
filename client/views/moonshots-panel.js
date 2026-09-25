// Opportunities → [Moonshots] (Phase 55): the live Moonshot Radar, on Setups and
// on Scanner. Data: MOONSHOT_RADAR (server/intelligence/moonshot-radar.js, every
// pipeline pass and at startup): the top 12 coins by the 100-point Moonshot
// Conviction Score, even under 60, plus the Buzz strip (CoinGecko trending and
// Reddit forum mentions, connectors/crypto-social.js).
//   Active Moonshot Setups   staged System 6 setups (>= 60/100 AND a real surge):
//                            the full Approvals card with its Smart Investment
//                            Amount (10-25% of normal risk) and Approve button
//   Radar leaderboard        score /100, 5m-frame (15 min) and 15m-frame (30 min)
//                            moves, relative volume, social /30, vs BTC + spread
//                            /20, badge; clicking a coin charts it on 5m candles
// iPhone: the panes follow the Opportunities switcher (opportunities-mobile.js).
// Exposes window.SignalDesk.moonshots: { render(state, ctx) }.
(() => {
  const SD = window.SignalDesk;
  const { el, age, price } = SD.ui;
  const M = () => SD.oppMobile;

  const BADGE = { TRIGGERED: 'is-hot', 'HEATING UP': 'is-warm', WATCHING: 'is-cool' };
  let selected = null; // charted coin
  let framedFor = null; // the coin the chart was last switched to 5m for

  const move = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}%` : '—');
  const moveCls = (x) => (x > 0 ? 'text-long' : x < 0 ? 'text-short' : '');
  const px = (x) => price(x, { market: 'crypto', entryPrice: x });

  function select(symbol, ctx) {
    selected = symbol;
    M().setPane('chart');
    ctx.rerender();
  }

  function header(r, ctx) {
    const scan = ctx.state.scan || {};
    const run = el('button', { type: 'button', className: 'btn moon-run', disabled: scan.running || !ctx.online, textContent: scan.running ? 'Scanning…' : 'Run scan' });
    run.onclick = () => ctx.onRunScan();
    const btc = r && r.btc ? `BTC ${move(r.btc.move5)} (15 min) · ${move(r.btc.move15)} (30 min)` : '';
    return el('div', { className: 'moon-head' }, [
      el('div', {}, [el('h2', { className: 'scan-title', textContent: 'Moonshot Radar' }),
        el('p', { className: 'scan-subtitle', textContent: r && r.at
          ? `Top ${r.rows.length} of ${r.ranked} coins by the live 100-point Moonshot Conviction Score · updated ${age(r.at)} ago${btc ? ` · ${btc}` : ''}`
          : 'Waiting for the first scan pass (it runs a few seconds after the server starts).' })]),
      el('div', { className: 'moon-legend' }, [...Object.entries(BADGE).map(([b, cls]) => el('span', { className: `moon-badge ${cls}`, textContent: b })),
        el('span', { className: 'slog-muted', textContent: '≥ 60 · 40–59 · < 40' }), run]),
    ]);
  }

  function activeSetups(state, ctx) {
    const list = (state.pending || []).filter((o) => o.speculative).sort((a, b) => b.stagedAt - a.stagedAt);
    const cardCtx = { ...ctx, onReview: (id) => { const o = list.find((x) => x.id === id); if (o) select(o.asset, ctx); } };
    return el('section', { className: 'moon-card moon-setups' }, [
      el('div', { className: 'moon-card-head' }, [el('h3', { className: 'opp-section', textContent: 'Active Moonshot setups (≥ 60/100)' }),
        el('span', { className: 'count', textContent: String(list.length) })]),
      ...(list.length ? list.map((o) => SD.oppApprovals.setupCard(o, cardCtx)) : [el('p', { className: 'opp-muted', textContent: 'None right now. A coin becomes a setup when it scores 60+ AND surges +2.5% to +12% '
        + 'on 2.2x+ volume at a fresh 30-minute high; the risk engine then sizes it at 10-25% of normal risk (the Smart Investment Amount).' })]),
    ]);
  }

  // iPhone queue pane: the setups live in Order & Risk; say how many and jump there.
  function setupsBanner(state, ctx) {
    const n = (state.pending || []).filter((o) => o.speculative).length;
    if (!n) return null;
    const b = el('button', { type: 'button', className: 'btn btn-solid moon-banner', textContent: `${n} active Moonshot setup${n === 1 ? '' : 's'} → Order & Risk` });
    b.onclick = () => { M().setPane('order'); ctx.rerender(); };
    return b;
  }

  function buzzStrip(r, ctx) {
    const z = r && r.buzz;
    if (!z) return el('section', { className: 'moon-card moon-buzz' }, el('p', { className: 'opp-muted', textContent: 'Forum and trending data arrive with the first scan pass.' }));
    const chip = (text, symbol, cls = '') => {
      const c = el(symbol ? 'button' : 'span', { className: `moon-chip ${cls}`, textContent: text, ...(symbol ? { type: 'button', title: `Chart ${symbol}` } : {}) });
      if (symbol) c.onclick = () => select(symbol, ctx);
      return c;
    };
    return el('section', { className: 'moon-card moon-buzz' }, [
      el('div', { className: 'moon-buzz-row' }, [el('span', { className: 'moon-buzz-label', textContent: 'CoinGecko trending' }),
        ...(z.trending.length ? z.trending.map((c) => chip(`#${c.rank} ${c.symbol}`, c.monitored ? `${c.symbol}-USD` : null, c.monitored ? 'is-monitored' : ''))
          : [el('span', { className: 'slog-muted', textContent: 'No trending list yet' })])]),
      el('div', { className: 'moon-buzz-row' }, [el('span', { className: 'moon-buzz-label', textContent: `Reddit forums (${z.feeds} feeds · ${z.posts} posts)` }),
        ...(z.reddit.length ? z.reddit.map((m) => chip(`${m.symbol.replace('-USD', '')} ${m.mentions}${m.recent ? ` · ${m.recent} new` : ''}`, m.symbol, m.recent ? 'is-monitored' : ''))
          : [el('span', { className: 'slog-muted', textContent: 'No monitored coin mentioned in the cached posts' })])]),
      ...(z.errors.length ? [el('p', { className: 'slog-muted', textContent: `Unavailable: ${z.errors.join('; ')} (last good data kept)` })] : []),
    ]);
  }

  function board(r, ctx) {
    const rows = (r && r.rows) || [];
    const setupFor = new Set((ctx.state.pending || []).filter((o) => o.speculative).map((o) => o.asset));
    const body = rows.map((x, i) => {
      const tr = el('tr', { className: `row moon-row${x.symbol === selected ? ' is-selected' : ''}`, title: x.why }, [
        el('td', {}, el('div', { className: 'scan-asset' }, [SD.scannerDetail.badge(x.symbol), el('div', {}, [
          el('strong', { textContent: `${i + 1}. ${x.symbol.replace('-', '/')}` }), el('span', { textContent: `${x.name} · ${px(x.price)}` })])])),
        el('td', { className: 'num' }, [el('strong', { className: 'moon-score', textContent: `${x.score}` }), el('span', { className: 'slog-muted', textContent: '/100' }),
          el('span', { className: 'moon-bar' }, el('span', { style: `width:${Math.max(2, Math.min(100, x.score))}%` }))]),
        el('td', { className: 'num', title: '5m frame: last 15 minutes · 15m frame: last 30 minutes' }, [el('span', { className: `moon-move ${moveCls(x.move5)}`, textContent: `${move(x.move5)} 5m` }),
          el('span', { className: `moon-move ${moveCls(x.move15)}`, textContent: `${move(x.move15)} 15m` })]),
        el('td', { className: 'num', textContent: Number.isFinite(x.relVol) ? `${x.relVol.toFixed(1)}x` : '—' }),
        el('td', { className: 'num', textContent: `${x.social}/30`, title: `Reddit ${x.buzzDetail.reddit} · trending ${x.buzzDetail.trending} · news ${x.buzzDetail.news}${x.buzzDetail.volumeCatalyst ? ' · volume-catalyst credit' : ''}` }),
        el('td', { className: 'num', textContent: `${x.strength}/20`, title: `vs BTC ${move(x.vsBtc)} (${x.parts.rs}/12) · spread ${x.spreadPct === null ? 'n/a' : `${x.spreadPct}%`} (${x.parts.spread}/8)` }),
        el('td', {}, el('span', { className: `moon-badge ${BADGE[x.badge] || ''}`, textContent: setupFor.has(x.symbol) ? `${x.badge} · SETUP` : x.badge })),
      ]);
      tr.onclick = () => select(x.symbol, ctx);
      return tr;
    });
    return el('section', { className: 'moon-card moon-board' }, [
      el('div', { className: 'moon-card-head' }, [el('h3', { className: 'opp-section', textContent: 'Live Moonshot Radar leaderboard' }),
        el('span', { className: 'slog-muted', textContent: 'Tap a coin for its live 5m / 15m chart' })]),
      el('div', { className: 'table-wrap' }, el('table', { className: 'data-table moon-table' }, [
        el('thead', {}, el('tr', {}, ['Coin', 'Score', '5m / 15m move', 'Rel vol', 'Social /30', 'vs BTC /20', 'Badge']
          .map((h, i) => el('th', { textContent: h, className: i >= 1 && i <= 5 ? 'num' : '' })))),
        el('tbody', {}, body.length ? body : [el('tr', {}, el('td', { colSpan: 7, className: 'pf-empty', textContent: 'No radar data yet.' }))]),
      ])),
      ...(r && r.missing && r.missing.length ? [el('p', { className: 'slog-muted', textContent: `Not enough 5-minute history this pass: ${r.missing.join(', ')} (retried next pass)` })] : []),
    ]);
  }

  function chartPane(r, ctx) {
    const row = ((r && r.rows) || []).find((x) => x.symbol === selected);
    const order = (ctx.state.pending || []).find((o) => o.speculative && o.asset === selected);
    if (selected !== framedFor) { SD.liveChart.setTimeframe && SD.liveChart.setTimeframe('5m'); framedFor = selected; }
    const target = order || { isWatch: true, asset: selected, market: 'crypto', setupType: 'Moonshot radar', timeframe: '5m' };
    const chart = selected ? SD.liveChart.mount(target, { withLevels: !!order, banner: order ? '' : 'Radar view · no setup: nothing to approve' }) : null;
    const part = (label, v, max) => el('div', { className: 'moon-part' }, [el('span', { textContent: label }), el('strong', { textContent: `${v}/${max}` })]);
    return el('section', { className: 'moon-card moon-chart' }, [
      el('div', { className: 'moon-card-head' }, [el('h3', { className: 'opp-section', textContent: selected ? `${selected.replace('-', '/')} · live chart` : 'Chart' }),
        ...(row ? [el('span', { className: `moon-badge ${BADGE[row.badge] || ''}`, textContent: `${row.score}/100 ${row.badge}` })] : [])]),
      ...(row ? [el('div', { className: 'moon-parts' }, [part('Velocity', row.parts.velocity, 25), part('Rel volume', row.parts.volume, 25),
        part('Social / trending', row.parts.buzz, 30), part('vs BTC', row.parts.rs, 12), part('Spread', row.parts.spread, 8)])] : []),
      chart || el('p', { className: 'opp-muted', textContent: selected ? 'Chart library unavailable (offline): scores above are live.' : 'Pick a coin in the leaderboard.' }),
      ...(row && row.buzzDetail.title ? [el('p', { className: 'slog-muted', textContent: row.buzzDetail.title })] : []),
    ]);
  }

  // ctx: { state, online, inFlight, onApprove, onDismiss, onReview, onRunScan, rerender }
  function render(state, ctx) {
    const r = state.moonshotRadar;
    const rows = (r && r.rows) || [];
    if (!selected || !(rows.some((x) => x.symbol === selected) || (state.pending || []).some((o) => o.speculative && o.asset === selected))) {
      if (!selected && rows.length) selected = rows[0].symbol;
    }
    const mobile = M().isMobile();
    const grid = el('div', { className: 'moon m-panes', dataset: { pane: M().pane() } }, [
      M().tag(header(r, ctx), 'queue'),
      ...(mobile ? [M().tag(setupsBanner(state, ctx), 'queue')] : []),
      M().tag(activeSetups(state, ctx), mobile ? 'order' : 'queue'),
      M().tag(buzzStrip(r, ctx), 'queue'),
      M().tag(board(r, ctx), 'queue'),
      M().tag(chartPane(r, ctx), 'chart'),
    ].filter(Boolean));
    return M().wrap(grid, { rerender: ctx.rerender, bar: null });
  }

  SD.moonshots = { render };
})();
