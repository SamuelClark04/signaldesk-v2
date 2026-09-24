// Today tab: the command-center dashboard. Pure render from the shared client
// state (settings, broker, positions, journal, pending, watchlist, rejections, intelligence); app.js calls
// renderToday() whenever that state changes while the tab is visible.
// Every section is live data: metric banner, briefing, Ready for review (queue),
// Portfolio attention + Market context (DASHBOARD_INTELLIGENCE), Watching
// (watchlist), Why we passed (rejection tally). No sample data remains.
// Exposes window.SignalDesk.today.
(() => {
  const SD = window.SignalDesk;
  const { el, money, price, signed, pnlClass } = SD.ui;

  const sum = (xs, f) => xs.reduce((s, x) => s + (Number(f(x)) || 0), 0);
  const isToday = (ts) => Number.isFinite(ts) && new Date(ts).toDateString() === new Date().toDateString();
  const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(2)}%`;
  const go = (tab) => () => { location.hash = tab; };

  // ---------- Metrics (paper book only; live venues are shown separately) ----------
  const costOf = (p) => (p.market === 'options' && p.optionsData
    ? p.positionSize * p.optionsData.debit * p.optionsData.multiplier
    : p.positionSize * p.fillPrice);

  function paperMetrics(state) {
    const bankroll = state.settings && state.settings.bankroll;
    if (!(bankroll > 0)) return null;
    const trades = state.journal.filter((t) => t.execution !== 'LIVE');
    const open = state.positions.filter((p) => p.execution !== 'LIVE');
    const accountValue = bankroll + sum(trades, (t) => t.netPnl);
    const holdings = sum(open, costOf);
    const todayPnl = sum(trades.filter((t) => isToday(t.closedAt)), (t) => t.netPnl);
    const startOfDay = accountValue - todayPnl;
    return { accountValue, holdings, cash: accountValue - holdings, todayPnl, todayPct: startOfDay > 0 ? todayPnl / startOfDay : 0, openCount: open.length };
  }

  function metric(label, value, sub, valueClass = '') {
    return el('div', { className: 'today-metric' }, [
      el('div', { className: 'today-metric-label', textContent: label }),
      el('div', { className: `today-metric-value ${valueClass}`, textContent: value }),
      el('div', { className: 'today-metric-sub', textContent: sub }),
    ]);
  }

  function metricBanner(state) {
    const m = paperMetrics(state);
    const dash = '—';
    const items = [
      metric('Account value', m ? money(m.accountValue) : dash, 'Paper bankroll + realized P/L'),
      metric('Holdings', m ? money(m.holdings) : dash, m ? `${m.openCount} open position${m.openCount === 1 ? '' : 's'} · at cost` : 'Waiting for data'),
      metric('Spendable cash', m ? money(m.cash) : dash, 'Account value − holdings'),
      metric("Today's change", m ? signed(m.todayPnl, money) : dash, m ? `${pct(m.todayPct)} · realized today` : '', m ? pnlClass(m.todayPnl) : ''),
    ];
    const live = Object.values((state.broker && state.broker.venues) || {}).filter((v) => v.mode === 'live');
    return [
      el('div', { className: 'today-metrics' }, items),
      ...(live.length ? [el('div', { className: 'today-live' }, live.map((v) => el('span', {
        className: `today-live-item${v.ok ? '' : ' is-error'}`,
        textContent: v.ok ? `LIVE ${v.label}: buying power ${money(v.buyingPower)}` : `LIVE ${v.label}: account unavailable`,
      })))] : []),
    ];
  }

  // ---------- Briefing ----------
  function briefing(state) {
    const n = state.pending.length;
    return el('section', { className: 'today-card today-briefing' }, [
      el('div', { className: 'today-briefing-text' }, [
        el('h2', { className: 'today-briefing-title', textContent: n ? `${n} setup${n === 1 ? '' : 's'} worth reviewing` : 'No setups waiting for review' }),
        el('div', { className: 'today-pills' }, [
          el('span', { className: `today-pill${n ? ' is-hot' : ''}`, textContent: `${n} to review` }),
          el('span', { className: 'today-pill', textContent: `${(state.watchlist || []).length} watching` }),
        ]),
      ]),
      el('div', { className: 'today-actions' }, [
        Object.assign(el('button', { className: 'btn btn-primary', textContent: 'Review opportunities →', type: 'button' }), { onclick: go('opportunities') }),
        Object.assign(el('button', { className: 'btn', textContent: 'Open Portfolio Pilot', type: 'button' }), { onclick: go('portfolio') }),
      ]),
    ]);
  }

  // ---------- Ready for review ----------
  function rewardRisk(c) {
    const long = c.direction !== 'short';
    const entry = long ? c.entryMax : c.entryMin;
    const risk = long ? entry - c.invalidation : c.invalidation - entry;
    const reward = long ? c.target - entry : entry - c.target;
    return risk > 0 && reward > 0 ? `${(reward / risk).toFixed(1)} : 1` : '—';
  }

  function setupCard(c) {
    const dir = c.direction === 'short' ? 'short' : 'long';
    const fmt = (x) => price(x, c);
    const field = (k, v, cls = '') => el('div', { className: 'today-field' }, [
      el('span', { className: 'today-field-k', textContent: k }), el('span', { className: `today-field-v ${cls}`, textContent: v })]);
    const review = el('button', { className: 'btn btn-primary', textContent: 'Review setup', type: 'button' });
    review.onclick = go('opportunities');
    return el('article', { className: 'today-setup' }, [
      el('div', { className: 'today-setup-head' }, [
        el('span', { className: 'asset', textContent: c.asset }),
        el('span', { className: `badge-${dir}`, textContent: dir }),
      ]),
      el('div', { className: 'today-fields' }, [
        field('Timeframe', c.timeframe || '—'),
        field('Entry zone', `${fmt(c.entryMin)} – ${fmt(c.entryMax)}`),
        field('Reward / risk', rewardRisk(c)),
        field('Invalidation', fmt(c.invalidation), 'text-short'),
      ]),
      el('div', { className: 'today-actions' }, [review,
        el('button', { className: 'btn', textContent: 'Save', type: 'button', disabled: true, title: 'Saving setups is not built yet' })]),
    ]);
  }

  // Real: the Approvals Queue (up to 3 cards).
  function readyForReview(state) {
    const real = state.pending.slice(0, 3).map((o) => ({
      asset: o.asset, direction: o.direction, timeframe: o.timeframe, market: o.market, entryPrice: o.entryPrice,
      entryMin: o.entryZone.min, entryMax: o.entryZone.max, invalidation: o.invalidation, target: o.targets && o.targets[0] && o.targets[0].price,
    }));
    const body = real.length
      ? el('div', { className: 'today-setups' }, real.map(setupCard))
      : el('p', { className: 'today-empty', textContent: 'No setups in the Approvals Queue. New ones appear here as the risk engine approves them.' });
    return card('Ready for review', real.length ? `${state.pending.length} in the Approvals Queue` : 'Queue empty', body);
  }

  function card(title, hint, body, extraClass = '') {
    return el('section', { className: `today-card ${extraClass}` }, [
      el('header', { className: 'today-card-head' }, [
        el('h3', { className: 'today-card-title', textContent: title }),
        ...(hint ? [el('span', { className: 'today-card-hint', textContent: hint })] : []),
      ]),
      body,
    ]);
  }

  const waiting = () => el('p', { className: 'today-empty', textContent: 'Waiting for the server…' });
  const updatedAt = (intel) => (intel ? `updated ${new Date(intel.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '');

  // Real: DASHBOARD_INTELLIGENCE attention alerts (one per open position).
  function attention(state) {
    const intel = state.intelligence;
    const body = !intel ? waiting() : el('ul', { className: 'today-list' }, intel.attention.map((a) => el('li', { className: `today-alert is-${a.tone}` }, [
      el('div', {}, [el('span', { className: 'asset', textContent: a.asset }), el('span', { className: 'today-alert-action', textContent: a.action })]),
      el('div', { className: 'today-alert-detail', textContent: a.detail }),
    ])));
    return card('Portfolio attention', updatedAt(intel), body);
  }

  // Real: server watchlist (WATCHLIST_UPDATED); last price refreshed each pipeline pass.
  function watching(state) {
    const items = state.watchlist || [];
    const body = !state.watchlist
      ? waiting()
      : !items.length
        ? el('p', { className: 'today-empty', textContent: 'No tickers actively watched' })
        : el('table', { className: 'data-table today-mini' }, [
          el('thead', {}, el('tr', {}, ['Symbol', 'Trigger', 'Last'].map((h, i) => el('th', { textContent: h, className: i === 2 ? 'num' : '' })))),
          el('tbody', {}, items.map((w) => el('tr', {}, [
            el('td', { className: 'asset', textContent: w.symbol }),
            el('td', { textContent: w.triggerCondition }),
            el('td', {
              className: 'num',
              textContent: w.lastPrice > 0 ? price(w.lastPrice, { market: w.market, entryPrice: w.lastPrice }) : '—',
              title: w.lastPriceAt ? `as of ${new Date(w.lastPriceAt).toLocaleTimeString()}` : 'No price from the live streams yet',
            }),
          ]))),
        ]);
    return card('Watching', items.length ? `${items.length} symbol${items.length === 1 ? '' : 's'}` : '', body);
  }

  // Real: today's REJECTION_STATS from the server (one count per setup per reason).
  function passed(state) {
    const stats = state.rejections;
    const reasons = (stats && stats.reasons) || [];
    const body = reasons.length
      ? el('ul', { className: 'today-list' }, reasons.map((r) => el('li', { className: 'today-count' }, [
        el('span', { textContent: r.reason }), el('span', { className: 'today-count-n', textContent: String(r.count) })])))
      : stats ? el('p', { className: 'today-empty', textContent: 'Nothing passed on yet today.' }) : waiting();
    return card('Why we passed', stats && stats.total ? `${stats.total} setup${stats.total === 1 ? '' : 's'} today` : 'Today', body);
  }

  // Real: DASHBOARD_INTELLIGENCE market context (live streams only).
  const TREND = { up: ['text-long', '▲ Up'], down: ['text-short', '▼ Down'], flat: ['', '■ Flat'], unknown: ['', '— No data'] };
  function context(state) {
    const intel = state.intelligence;
    const body = !intel ? waiting() : el('ul', { className: 'today-list' }, intel.context.map((c) => {
      const [cls, label] = TREND[c.trend] || TREND.unknown;
      const move = Number.isFinite(c.changePct) ? ` ${pct(c.changePct)}` : '';
      return el('li', { className: 'today-context' }, [
        el('span', { className: 'today-context-asset', textContent: c.asset }),
        el('span', { className: `today-trend ${cls}`, textContent: `${label}${move}` }),
        el('span', { className: 'today-context-breadth', textContent: [c.basis, c.breadth].filter(Boolean).join(' · ') }),
      ]);
    }));
    return card('Market context', updatedAt(intel), body);
  }

  // ---------- Entry point ----------
  function renderToday(container, state) {
    container.replaceChildren(
      ...metricBanner(state),
      briefing(state),
      el('div', { className: 'today-split' }, [readyForReview(state), attention(state)]),
      el('div', { className: 'today-support' }, [watching(state), passed(state), context(state)]),
    );
  }

  SD.today = { renderToday };
})();
