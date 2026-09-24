// Setups tab: center (analysis) and right (risk & execution) panels for one
// pending order. Pure builders; opportunities.js owns selection and actions.
// Scenario figures come from the server (order.scenarios, same maths as the
// ledger), so what's shown here is exactly what would be booked.
// Exposes window.SignalDesk.oppDetail.
(() => {
  const SD = window.SignalDesk;
  const { el, money, price, size, signed, pnlClass } = SD.ui;

  const VENUE = { stocks: ['stockMode', 'Alpaca'], options: ['stockMode', 'Alpaca'], crypto: ['cryptoMode', 'Coinbase'] };
  const displaySymbol = (o) => (o.market === 'crypto' ? o.asset.replace('-', '/') : o.asset);
  const px = (x, o) => price(x, o);
  const kv = (k, v, cls = '') => el('div', { className: 'opp-kv' }, [
    el('span', { className: 'opp-k', textContent: k }), el('span', { className: `opp-v ${cls}`, textContent: v })]);

  // ---------- Center: analysis ----------
  // Fallback chart (library not loaded): every level drawn as a line at its relative height.
  function levelChart(o, livePrice) {
    const t = o.targets || [];
    const lines = [
      { name: 'T2', price: t[1] && t[1].price, cls: 'is-target' },
      { name: 'T1', price: t[0] && t[0].price, cls: 'is-target' },
      { name: 'Entry', price: o.entryZone.max, cls: 'is-entry' },
      { name: 'SL', price: o.invalidation, cls: 'is-stop' },
      { name: 'Last', price: livePrice, cls: 'is-last' },
    ].filter((l) => l.price > 0);
    const all = [...lines.map((l) => l.price), o.entryZone.min];
    const hi = Math.max(...all); const lo = Math.min(...all);
    const pad = (hi - lo) * 0.12 || hi * 0.01;
    const top = (p) => `${((hi + pad - p) / (hi - lo + 2 * pad)) * 100}%`;

    const chart = el('div', { className: 'opp-chart' });
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', `Price levels: ${lines.map((l) => `${l.name} ${px(l.price, o)}`).join(', ')}`);
    const band = el('div', { className: 'opp-band' });
    band.style.top = top(o.entryZone.max);
    band.style.height = `calc(${top(o.entryZone.min)} - ${top(o.entryZone.max)})`;
    chart.append(band, el('div', { className: 'opp-chart-note', textContent: 'Chart feed not connected: levels only' }));
    for (const l of lines) {
      const line = el('div', { className: `opp-line ${l.cls}` }, [
        el('span', { className: 'opp-line-label', textContent: `${l.name} ${px(l.price, o)}` })]);
      line.style.top = top(l.price);
      chart.append(line);
    }
    return chart;
  }

  // A complete algorithmic setup: levels AND server-sized risk. Market Watch (or
  // anything missing these) is display-only: "—" everywhere, nothing executable.
  const hasLevels = (o) => !o.isWatch && !!o.id && !!o.entryZone && o.invalidation > 0
    && Array.isArray(o.targets) && o.targets.length > 0 && o.positionSize > 0;

  const WATCH_TEXT = 'Market Watch Mode: Waiting for algorithmic setups.';

  // Market Watch chart: just the live price, centred, until a setup brings levels.
  function watchChart(o, livePrice) {
    const chart = el('div', { className: 'opp-chart' });
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', `${displaySymbol(o)} last price ${livePrice > 0 ? px(livePrice, o) : 'unavailable'}`);
    chart.append(el('div', { className: 'opp-watch-mode', textContent: WATCH_TEXT }));
    if (livePrice > 0) {
      const line = el('div', { className: 'opp-line is-last' }, [el('span', { className: 'opp-line-label', textContent: `Last ${px(livePrice, o)}` })]);
      line.style.top = '50%';
      chart.append(line);
    }
    chart.append(el('div', { className: 'opp-chart-note', textContent: 'Chart feed not connected: live price only' }));
    return chart;
  }

  function center(o, { livePrice, refPrice }) {
    // No live price: show the last close (display only) instead of a bare "—".
    const ref = !(livePrice > 0) && refPrice && refPrice.price > 0 ? refPrice : null;
    const watch = !hasLevels(o);
    const dir = o.direction === 'short' ? 'short' : 'long';
    const change = !watch && livePrice > 0 && o.entryPrice > 0 ? livePrice / o.entryPrice - 1 : null;
    return el('section', { className: 'opp-center' }, [
      el('header', { className: 'opp-head' }, [
        el('h2', { className: 'opp-symbol', textContent: displaySymbol(o) }),
        ...(watch ? [el('span', { className: 'opp-watch-tag', textContent: 'Market watch' })] : [el('span', { className: `badge-${dir}`, textContent: dir })]),
        el('span', { className: 'opp-meta', textContent: `${o.setupType || 'Setup'} · ${o.timeframe || '—'}${o.strategyId ? ` · ${o.strategyId}` : ''}` }),
        el('span', { className: 'opp-last' }, [
          el('span', { className: 'opp-k', textContent: ref ? 'Last close ' : 'Last ' }),
          el('strong', { textContent: livePrice > 0 ? px(livePrice, o) : ref ? px(ref.price, o) : '—' }),
          ...(change === null ? [] : [el('span', { className: pnlClass(change), textContent: ` ${change >= 0 ? '+' : '−'}${Math.abs(change * 100).toFixed(2)}% vs entry` })]),
          ...(livePrice > 0 ? [] : [el('span', { className: 'opp-k', textContent: ref
            ? ` · ${new Date(ref.time).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}, no live price (market closed or feed quiet)`
            : ' · no fresh price (market closed or feed quiet)' })]),
        ]),
      ]),
      // Live candles when the chart library loaded; static level chart otherwise.
      SD.liveChart.mount(o, { withLevels: !watch, banner: watch ? WATCH_TEXT : '' })
        || (watch ? watchChart(o, livePrice) : levelChart(o, livePrice)),
      el('div', { className: 'opp-thesis' }, watch ? [
        el('p', { className: 'opp-thesis-text', textContent: WATCH_TEXT }),
        el('p', { className: 'opp-muted', textContent: 'Setups appear in the queue when a strategy proposes one and the risk engine approves it. '
          + 'Pick any symbol under Market watch to follow its live price meanwhile.' }),
      ] : [
        el('p', { className: 'opp-thesis-text', textContent: o.thesis || 'No thesis provided.' }),
        ...(o.catalyst && o.catalyst.headline ? [el('p', { className: 'opp-catalyst' }, [
          el('span', { className: 'opp-k', textContent: 'Catalyst ' }),
          `${o.catalyst.headline} (sentiment ${o.catalyst.sentimentScore > 0 ? '+' : ''}${o.catalyst.sentimentScore})`])] : []),
        el('ul', { className: 'opp-criteria' }, (o.confirmationCriteria || []).map((c) => el('li', { textContent: c }))),
      ]),
    ]);
  }

  // ---------- Right: risk & execution ----------
  function scenarioTable(o) {
    const s = hasLevels(o) ? o.scenarios || {} : {};
    const rows = hasLevels(o) ? [['Stop', s.stop], ['T1', s.t1], ['T2', s.t2]].filter(([, v]) => v) : [['Stop'], ['T1'], ['T2']];
    const dash = (cls = 'num') => el('td', { className: cls, textContent: '—' });
    return el('table', { className: 'data-table opp-scenarios' }, [
      el('thead', {}, el('tr', {}, ['At', 'Price', 'Gross P&L', 'Est. fees', 'Net'].map((h, i) => el('th', { textContent: h, className: i ? 'num' : '' })))),
      el('tbody', {}, rows.map(([name, v]) => el('tr', {}, !v ? [el('td', { textContent: name }), dash(), dash(), dash(), dash()] : [
        el('td', { textContent: name }),
        el('td', { className: 'num', textContent: px(v.price, o) }),
        el('td', { className: `num ${pnlClass(v.gross)}`, textContent: signed(v.gross, money) }),
        el('td', { className: 'num', textContent: money(v.fees) }),
        el('td', { className: `num ${pnlClass(v.net)}` }, [signed(v.net, money),
          ...(Number.isFinite(v.r) ? [el('span', { className: 'opp-r', textContent: `${v.r >= 0 ? '+' : ''}${v.r.toFixed(2)}R` })] : [])]),
      ]))),
    ]);
  }

  // Execution button reflects the venue the server will use (it re-checks anyway).
  // Without a complete setup it is always disabled: "Waiting for Setup".
  function actions(o, ctx) {
    const ready = hasLevels(o);
    const [modeKey, broker] = VENUE[o.market] || [null, '?'];
    const live = ctx.settings && modeKey && ctx.settings[modeKey] === 'live';
    const liveOptions = live && o.market === 'options';
    let label = live ? `Execute live on ${broker}` : 'Start paper tracking';
    if (liveOptions) label = 'Live options not supported';
    if (ctx.busy) label = 'Sending…';
    if (!ready) label = 'Waiting for Setup';
    const primary = el('button', {
      type: 'button',
      className: `btn ${live && ready ? 'btn-live' : 'btn-primary'} opp-go`,
      textContent: label,
      disabled: !ready || !ctx.online || ctx.busy || liveOptions,
      title: !ready ? 'No algorithmic setup selected: nothing can be executed' : !ctx.online ? 'Offline' : '',
    });
    const dismiss = el('button', { type: 'button', className: 'btn', textContent: 'Dismiss', disabled: !ready || !ctx.online || ctx.busy });
    if (ready) {
      primary.onclick = () => ctx.onApprove(o, { live, broker });
      dismiss.onclick = () => ctx.onDismiss(o);
    }
    const mode = live ? `LIVE · ${broker}` : `Paper · ${broker}`;
    return el('div', { className: 'opp-actions' }, [
      el('div', { className: `opp-venue${live && ready ? ' is-live' : ''}`, textContent: ready ? (live ? `LIVE · real order at ${broker}` : `Paper · ${broker} mode is Paper`) : `${mode} · no setup selected, nothing can be sent` }),
      primary,
      dismiss,
    ]);
  }

  function right(o, ctx) {
    const ready = hasLevels(o);
    const t = o.targets || [];
    const s = o.scenarios || {};
    const lv = (fn) => (ready ? fn() : '—');
    const rr = ready && s.t1 && s.stop && s.stop.net < 0 ? `${(s.t1.net / -s.stop.net).toFixed(2)} : 1` : '—';
    const bankroll = ctx.settings && ctx.settings.bankroll;
    const riskPct = bankroll > 0 && o.dollarRisk > 0 ? ` · ${((o.dollarRisk / bankroll) * 100).toFixed(2)}% of bankroll` : '';
    return el('aside', { className: 'opp-right' }, [
      el('h3', { className: 'opp-section', textContent: 'Levels' }),
      kv('Entry range', lv(() => `${px(o.entryZone.min, o)} – ${px(o.entryZone.max, o)}`)),
      kv('Invalidation (stop)', lv(() => px(o.invalidation, o)), ready ? 'text-short' : ''),
      kv('Take profit 1', lv(() => (t[0] ? px(t[0].price, o) : '—')), ready ? 'text-long' : ''),
      kv('Take profit 2', lv(() => (t[1] ? px(t[1].price, o) : '—')), ready ? 'text-long' : ''),
      ...(ready && o.optionsData ? [kv('Structure', `${(o.optionsData.legs || []).map((l) => `${l.side} ${l.strike}${l.type === 'put' ? 'P' : 'C'}`).join(' / ')} · ${o.optionsData.debit} debit`)] : []),
      el('h3', { className: 'opp-section', textContent: 'Risk' }),
      kv('Planned size', lv(() => size(o))),
      kv('Risk amount', lv(() => `${money(o.dollarRisk)}${riskPct}`)),
      kv('Net reward / risk (T1)', rr),
      kv('Fee drag', ready && Number.isFinite(o.feeDrag) ? `${o.feeDrag.toFixed(2)}R` : '—'),
      el('h3', { className: 'opp-section', textContent: 'Price scenario' }),
      scenarioTable(o),
      actions(o, ctx),
    ]);
  }

  SD.oppDetail = { center, right, displaySymbol, hasLevels };
})();
