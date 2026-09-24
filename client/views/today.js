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

  // ---------- Metrics (for the active venue: state.activeVenue) ----------
  // Positions, marks and totals come from the same code as the Portfolio tab
  // (portfolio-table.metrics), so the two pages always agree, including the
  // rule that SignalDesk's live Coinbase trades are never counted twice.
  // Which closed trades count as "today" for each venue.
  const TRADE_VENUE = {
    paper: (t) => t.execution !== 'LIVE',
    crypto: (t) => t.execution === 'LIVE' && t.broker === 'Coinbase',
    combined: () => true,
  };

  function venueMetrics(state) {
    const venue = SD.venue.current(state);
    const bankroll = state.settings && state.settings.bankroll;
    if (venue !== 'crypto' && !(bankroll > 0)) return null; // settings not loaded yet
    const data = SD.portfolioTable.metrics(state, venue);
    const t = data.totals;
    if (venue === 'crypto' && !t.synced) return { venue, unsynced: true, count: data.rows.length };
    // Open risk: dollar risk to the stop. Synced broker holdings have no SignalDesk
    // stop; only the SignalDesk trades inside them (p.tracked) carry a known risk.
    const risks = data.rows.map((r) => (r.p.execution === 'BROKER' ? sum(r.p.tracked || [], (x) => x.dollarRisk) : r.p.dollarRisk));
    const unstopped = data.rows.filter((r) => r.p.execution === 'BROKER' && !(r.p.tracked || []).length).length;
    const todayPnl = sum(state.journal.filter((x) => TRADE_VENUE[venue](x) && isToday(x.closedAt)), (x) => x.netPnl);
    const startOfDay = t.accountValue - todayPnl;
    return { venue, t, count: data.rows.length, risk: sum(risks, (x) => x), unstopped, todayPnl, todayPct: startOfDay > 0 ? todayPnl / startOfDay : 0 };
  }

  function metric(label, value, sub, valueClass = '') {
    return el('div', { className: 'today-metric' }, [
      el('div', { className: 'today-metric-label', textContent: label }),
      el('div', { className: `today-metric-value ${valueClass}`, textContent: value }),
      el('div', { className: 'today-metric-sub', textContent: sub }),
    ]);
  }

  function metricBanner(state) {
    const m = venueMetrics(state);
    const dash = '—';
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    let items;
    if (!m) {
      items = ['Account value', 'Capital deployed', 'Open risk', 'Unrealized P/L', "Today's change"].map((l) => metric(l, dash, 'Waiting for data'));
    } else if (m.unsynced) {
      items = [metric('Account value', dash, 'Coinbase not synced: press Sync Broker'),
        metric('Capital deployed', dash, `${plural(m.count, 'LIVE trade')} SignalDesk opened (no account totals until synced)`),
        ...['Open risk', 'Unrealized P/L', "Today's change"].map((l) => metric(l, dash, 'Needs a Coinbase sync'))];
    } else {
      const { t } = m;
      const usd = (x) => `${x < 0 ? '−' : ''}${money(Math.abs(x))}`;
      const cashSource = !t.usePaper ? 'live Coinbase USD + USDC' : t.useCb ? `paper ${usd(t.paperCash)} + Coinbase ${usd(t.cbCash)}` : 'paper cash';
      items = [
        // Total = Managed (SignalDesk positions) + External (broker coins it doesn't manage) + Cash.
        metric('Account value', usd(t.accountValue), `Total = ${usd(t.managedValue)} managed + ${usd(t.externalValue)} external + ${usd(t.cash)} cash (${cashSource})`),
        metric('Capital deployed', usd(t.holdingsValue), `${plural(m.count, 'position')} · ${t.deployedPct === null ? '—' : `${(t.deployedPct * 100).toFixed(0)}%`} of the account · ${usd(t.cash)} in cash`),
        metric('Open risk', money(m.risk), `${t.currentBankroll > 0 ? `${((m.risk / t.currentBankroll) * 100).toFixed(2)}% of ${t.bankrollLabel} · ` : ''}to the stops${m.unstopped ? ` · ${plural(m.unstopped, 'broker holding')} without a stop` : ''}`),
        metric('Unrealized P/L', signed(t.unrealized, money), t.unrealizedPct === null ? 'No marked positions' : `${pct(t.unrealizedPct)} of cost · before est. exit fees`, pnlClass(t.unrealized)),
        metric("Today's change", signed(m.todayPnl, money), `${pct(m.todayPct)} · realized today (SignalDesk trades)`, pnlClass(m.todayPnl)),
      ];
    }
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
    review.onclick = () => { SD.opportunities.select(c.id); location.hash = 'opportunities'; };
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
      id: o.id, asset: o.asset, direction: o.direction, timeframe: o.timeframe, market: o.market, entryPrice: o.entryPrice,
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

  // Real: DASHBOARD_INTELLIGENCE attention alerts (one per open ledger position),
  // limited to the active venue. Synced broker holdings have no SignalDesk rules.
  const ALERT_VENUE = {
    paper: (p) => p.execution !== 'LIVE',
    crypto: (p) => p.execution === 'LIVE' && p.broker === 'Coinbase',
    combined: () => true,
  };
  function attention(state) {
    const intel = state.intelligence;
    const venue = SD.venue.current(state);
    const byId = new Map((state.positions || []).map((p) => [p.id, p]));
    const alerts = !intel ? [] : intel.attention.filter((a) => (a.positionId ? byId.has(a.positionId) && ALERT_VENUE[venue](byId.get(a.positionId)) : venue !== 'crypto'));
    const empty = venue === 'crypto' ? 'No SignalDesk trades open on Coinbase. Synced holdings are not watched by SignalDesk rules.' : 'No alerts for this venue.';
    const body = !intel ? waiting() : !alerts.length ? el('p', { className: 'today-empty', textContent: empty }) : el('ul', { className: 'today-list' }, alerts.map((a) => el('li', { className: `today-alert is-${a.tone}` }, [
      el('div', {}, [el('span', { className: 'asset', textContent: `${a.asset}${a.execution === 'LIVE' ? ' · LIVE' : ''}` }), el('span', { className: 'today-alert-action', textContent: a.action })]),
      el('div', { className: 'today-alert-detail', textContent: a.detail }),
    ])));
    return card('Portfolio attention', updatedAt(intel), body);
  }

  // Real: server watchlist (WATCHLIST_UPDATED). Each symbol's trigger is LIVE: the
  // nearest real level to its price (20-day high, 20-day SMA, VWAP, 1h mean,
  // strategy triggers), recomputed every pipeline pass (watch-triggers.js).
  function triggerCell(w) {
    const t = w.trigger;
    if (!t) return el('td', { className: 'today-muted', textContent: w.lastPrice > 0 ? 'Computing from live bars…' : 'Waiting for a price' });
    const cell = el('td', {}, [el('span', { textContent: t.label }),
      ...(w.triggerCondition ? [el('span', { className: 'today-note', textContent: ` · ${w.triggerCondition}` })] : [])]);
    cell.title = `${t.source} · level ${t.level} vs ${t.live ? 'live' : 'last'} price ${t.price} · computed ${new Date(t.at).toLocaleTimeString()}`;
    return cell;
  }

  function watching(state) {
    const items = state.watchlist || [];
    const body = !state.watchlist
      ? waiting()
      : !items.length
        ? el('p', { className: 'today-empty', textContent: 'No tickers actively watched' })
        : el('table', { className: 'data-table today-mini' }, [
          el('thead', {}, el('tr', {}, ['Symbol', 'Live trigger', 'Distance', 'Last'].map((h, i) => el('th', { textContent: h, className: i >= 2 ? 'num' : '' })))),
          el('tbody', {}, items.map((w) => el('tr', {}, [
            el('td', { className: 'asset', textContent: w.symbol }),
            triggerCell(w),
            el('td', { className: `num ${w.trigger ? (Math.abs(w.trigger.distancePct) <= 0.015 ? 'text-long' : '') : ''}`, textContent: w.trigger ? pct(w.trigger.distancePct) : '—',
              title: w.trigger ? `${w.trigger.distancePct >= 0 ? 'above' : 'below'} the current price` : '' }),
            el('td', {
              className: 'num',
              textContent: w.lastPrice > 0 ? price(w.lastPrice, { market: w.market, entryPrice: w.lastPrice }) : '—',
              title: w.lastPriceAt ? `as of ${new Date(w.lastPriceAt)[new Date(w.lastPriceAt).toDateString() === new Date().toDateString() ? 'toLocaleTimeString' : 'toLocaleString']()}` : 'No price from the live streams yet',
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
    const venue = SD.venue.current(state);
    container.replaceChildren(
      el('div', { className: 'today-venue-bar' }, [
        el('div', {}, [el('span', { className: 'today-venue-label', textContent: 'Showing' }), el('strong', { textContent: SD.venue.LABEL[venue] })]),
        SD.venue.controls(state),
      ]),
      ...metricBanner(state),
      briefing(state),
      el('div', { className: 'today-split' }, [readyForReview(state), attention(state)]),
      el('div', { className: 'today-support' }, [watching(state), passed(state), context(state)]),
    );
  }

  SD.today = { renderToday };
})();
