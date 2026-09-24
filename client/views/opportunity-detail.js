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

  // Header: badge, symbol + name, big price with its change, setup meta.
  // Change: vs entry for a setup; over the loaded chart range in Market Watch.
  // The thesis lives in the analysis card below (setup-analysis.js).
  function center(o, ctx) {
    const { livePrice, refPrice } = ctx;
    const ref = !(livePrice > 0) && refPrice && refPrice.price > 0 ? refPrice : null; // last close (display only)
    const watch = !hasLevels(o);
    const dir = o.direction === 'short' ? 'short' : 'long';
    const shown = livePrice > 0 ? livePrice : ref ? ref.price : null;
    // Live candles when the chart library loaded; static level chart otherwise.
    const chart = SD.liveChart.mount(o, { withLevels: !watch, banner: watch ? WATCH_TEXT : '' })
      || (watch ? watchChart(o, livePrice) : levelChart(o, livePrice));
    let change = null;
    let basis = '';
    if (!watch && livePrice > 0 && o.entryPrice > 0) {
      change = livePrice / o.entryPrice - 1;
      basis = 'vs entry';
    } else if (watch && shown) {
      const s = SD.liveChart.stats && SD.liveChart.stats(o.asset);
      if (s && s.first.open > 0) { change = shown / s.first.open - 1; basis = `over ${s.bars} × ${s.tf}`; }
    }
    const note = livePrice > 0 ? '' : ref
      ? `Last close · ${new Date(ref.time).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · no live price (market closed or feed quiet)`
      : 'No fresh price (market closed or feed quiet)';
    return el('section', { className: 'opp-center' }, [
      el('header', { className: 'opp-head' }, [
        SD.scannerDetail.badge(o.asset, true),
        // Symbol picker over the whole universe once it has arrived; plain title until then.
        el('div', { className: 'opp-title' }, ctx.state && ctx.state.universe && ctx.onPickSymbol ? [SD.symbolPicker.build(o, ctx)]
          : [el('h2', { className: 'opp-symbol', textContent: displaySymbol(o) }), el('span', { className: 'opp-name', textContent: SD.scannerData.nameOf(o.asset) })]),
        el('div', { className: 'opp-price' }, [
          el('strong', { className: 'opp-price-big', textContent: shown ? px(shown, { ...o, entryPrice: o.entryPrice || shown }) : '—' }),
          ...(change === null ? [] : [el('span', { className: `opp-price-chg ${pnlClass(change)}`, textContent: `${change >= 0 ? '+' : '−'}${Math.abs(change * 100).toFixed(2)}%` }),
            el('span', { className: 'opp-k', textContent: basis })]),
          ...(note ? [el('span', { className: 'opp-k opp-price-note', textContent: note })] : []),
        ]),
        el('div', { className: 'opp-head-meta' }, watch ? [el('span', { className: 'opp-watch-tag', textContent: 'Market watch' })] : [
          el('span', { className: `badge-${dir}`, textContent: dir }),
          el('span', { className: 'opp-meta', textContent: `${o.setupType || 'Setup'} · ${o.timeframe || '—'}` })]),
      ]),
      // Active Trade HUD floats over the chart when this symbol has open position(s).
      el('div', { className: 'opp-chart-wrap' }, [chart, ...[SD.tradeHud.hud(o, ctx)].filter(Boolean)]),
    ]);
  }

  // ---------- Right: risk & execution ----------
  // Bookmark toggle (Saved tab). The server snapshots its own copy of the setup.
  function bookmark(o, ctx) {
    const saved = ctx.isSaved(o.id);
    const b = el('button', { type: 'button', className: `btn opp-bookmark${saved ? ' is-saved' : ''}`, textContent: saved ? '★ Saved' : '☆ Save',
      disabled: !ctx.online, title: saved ? 'Remove from Saved' : 'Save for later (Opportunities → Saved)' });
    b.setAttribute('aria-pressed', String(saved));
    b.onclick = () => ctx.onToggleSave(o);
    return b;
  }

  const BASIS = { paper: 'Paper bankroll', 'coinbase-live': 'Live Coinbase account value', 'alpaca-live': 'Live Alpaca equity' };
  // Was this order sized for the venue it would execute on now? (server rule:
  // message-handler refuses a LIVE approval of a setup not sized from that account)
  function sizing(o, ctx) {
    const [modeKey, broker] = VENUE[o.market] || [null, '?'];
    const liveVenue = !!(ctx.settings && modeKey && ctx.settings[modeKey] === 'live');
    const basis = o.sizingBasis || 'paper'; // setups staged before venue sizing were all sized from paper
    const venueKey = liveVenue ? broker.toLowerCase() : 'paper'; // 'paper' | 'coinbase' | 'alpaca'
    return { broker, basis, venueKey, mismatch: hasLevels(o) && liveVenue && basis !== `${broker.toLowerCase()}-live` };
  }

  // The money, plainly: where the cash comes from, what the buy costs in total,
  // and what is lost if the stop is hit (before and after fees).
  function moneyGroup(o, ctx, ready) {
    const { venueKey } = sizing(o, ctx);
    const f = SD.portfolioMetrics.fundingSource(ctx.state || {}, venueKey);
    const entryFee = o.costs && Number.isFinite(o.costs.entry) ? o.costs.entry : 0;
    const required = Number.isFinite(o.notional) ? o.notional + entryFee : null;
    const lossWithFees = o.scenarios && o.scenarios.stop ? -o.scenarios.stop.net : null;
    const short = ready && f.amount !== null && required !== null && f.amount < required;
    const fund = f.amount === null ? `${f.label}: ${f.note}` : `${f.label}: ${f.amount < 0 ? '−' : ''}${money(Math.abs(f.amount))}`;
    return el('div', { className: 'opp-kv-group opp-money' }, [
      kv('Funding source', fund, short ? 'text-short' : ''),
      kv('Total capital required to buy', ready && required !== null ? `${money(required)}${entryFee ? ` (incl. ${money(entryFee)} est. fee)` : ''}` : '—'),
      kv('Quantity (est.)', ready ? size(o) : '—'),
      kv('Capital at risk (stop hit)', ready ? `${money(o.dollarRisk)}${lossWithFees !== null ? ` · ${money(lossWithFees)} incl. fees` : ''}` : '—', ready ? 'text-short' : ''),
      ...(short ? [el('p', { className: 'opp-size-warn', textContent: `Not enough cash: the buy needs ${money(required)} but ${f.label} is ${f.amount < 0 ? "−" : ""}${money(Math.abs(f.amount))}.`
        + (venueKey === 'paper' ? ' Paper will still fill it (over-committing the bankroll).' : ' The broker will reject the order.') })] : []),
    ]);
  }

  function scenarioTable(o) {
    const s = hasLevels(o) ? o.scenarios || {} : {};
    const rows = hasLevels(o) ? [['Stop', s.stop], ['T1', s.t1], ['T2', s.t2]].filter(([, v]) => v) : [['Stop'], ['T1'], ['T2']];
    const dash = () => el('td', { className: 'num', textContent: '—' });
    return el('table', { className: 'data-table opp-scenarios' }, [
      el('thead', {}, el('tr', {}, ['Level', 'Price', 'Gross P&L', 'Est. net (fees)'].map((h, i) => el('th', { textContent: h, className: i ? 'num' : '' })))),
      el('tbody', {}, rows.map(([name, v]) => el('tr', {}, !v ? [el('td', { textContent: name }), dash(), dash(), dash()] : [
        el('td', { className: name === 'Stop' ? 'text-short' : 'text-long', textContent: name }),
        el('td', { className: 'num', textContent: px(v.price, o) }),
        el('td', { className: `num ${pnlClass(v.gross)}`, textContent: signed(v.gross, money) }),
        el('td', { className: `num ${pnlClass(v.net)}`, title: `Estimated fees ${money(v.fees)}` }, [signed(v.net, money),
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
    const wrongSizing = sizing(o, ctx).mismatch;
    if (wrongSizing) label = `Sized for ${sizing(o, ctx).basis === 'paper' ? 'paper' : 'another venue'}: dismiss & re-scan`;
    if (ctx.busy) label = 'Sending…';
    if (!ready) label = 'Waiting for Setup';
    const primary = el('button', {
      type: 'button',
      className: `btn ${live && ready ? 'btn-live' : 'btn-solid'} opp-go`,
      textContent: label,
      disabled: !ready || !ctx.online || ctx.busy || liveOptions || wrongSizing,
      title: !ready ? 'No algorithmic setup selected: nothing can be executed' : !ctx.online ? 'Offline' : '',
    });
    const analysis = el('button', { type: 'button', className: 'btn', textContent: 'View full analysis' });
    analysis.onclick = () => { const a = document.getElementById('opp-analysis'); if (a) a.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    const dismiss = el('button', { type: 'button', className: 'btn', textContent: 'Dismiss', disabled: !ready || !ctx.online || ctx.busy });
    if (ready) {
      primary.onclick = () => ctx.onApprove(o, { live, broker });
      dismiss.onclick = () => ctx.onDismiss(o);
    }
    const mode = live ? `LIVE · ${broker}` : `Paper · ${broker}`;
    return el('div', { className: 'opp-actions' }, [
      primary,
      el('div', { className: 'opp-actions-row' }, [analysis, dismiss]),
      el('div', { className: `opp-venue${live && ready ? ' is-live' : ''}`, textContent: ready
        ? (live ? `LIVE · a real order is sent to ${broker} on approval` : `Paper tracking · no broker order (${broker} mode is Paper)`)
        : `${mode} · no setup selected, nothing can be sent` }),
    ]);
  }

  function right(o, ctx) {
    const ready = hasLevels(o);
    const t = o.targets || [];
    const s = o.scenarios || {};
    const c = o.costs || {};
    const lv = (fn) => (ready ? fn() : '—');
    const cost = (x) => (Number.isFinite(x) ? money(x) : '—');
    const rr = ready && s.t1 && s.stop && s.stop.net < 0 ? `${(s.t1.net / -s.stop.net).toFixed(2)} : 1` : '—';
    // Sizing basis: what the SERVER sized this order against (o.sizingBasis +
    // o.sizingBankroll, set by venue-capital at staging). If the venue's mode has
    // changed since, a LIVE approval is refused server-side; say so up front.
    const { broker, basis, mismatch } = sizing(o, ctx);
    const sizedFrom = o.sizingBankroll > 0 ? `${money(o.sizingBankroll)} · ${BASIS[basis] || basis}` : `${BASIS[basis] || basis}`;
    const riskShare = o.sizingBankroll > 0 && o.dollarRisk > 0 ? o.dollarRisk / o.sizingBankroll : null;
    const summary = ready && o.thesis ? o.thesis.split(/(?<=\.)\s/)[0] : '';
    return el('aside', { className: 'opp-right' }, [
      el('header', { className: 'opp-right-head' }, [
        SD.scannerDetail.badge(o.asset, true),
        el('div', { className: 'opp-title' }, [el('strong', { className: 'opp-right-symbol', textContent: displaySymbol(o) }),
          el('span', { className: 'opp-name', textContent: ready ? `${o.direction === 'short' ? 'Short' : 'Long'} — ${o.setupType || 'Setup'}` : 'Market watch' })]),
        ...(ready && ctx.onToggleSave ? [bookmark(o, ctx)] : []),
        el('span', { className: `opp-pill${ready ? ' is-ready' : ''}`, textContent: ready ? 'Ready for review' : 'Waiting for setup' }),
      ]),
      ...(summary ? [el('p', { className: 'opp-right-summary', textContent: summary })] : []),
      el('div', { className: 'opp-kv-group' }, [
        kv('Entry range', lv(() => `${px(o.entryZone.min, o)} – ${px(o.entryZone.max, o)}`)),
        kv('Invalidation (stop)', lv(() => px(o.invalidation, o)), ready ? 'text-short' : ''),
        kv('Take profit 1 (T1)', lv(() => (t[0] ? px(t[0].price, o) : '—')), ready ? 'text-long' : ''),
        kv('Take profit 2 (T2)', lv(() => (t[1] ? px(t[1].price, o) : '—')), ready ? 'text-long' : ''),
        ...(ready && o.optionsData ? [kv('Structure', `${(o.optionsData.legs || []).map((l) => `${l.side} ${l.strike}${l.type === 'put' ? 'P' : 'C'}`).join(' / ')} · ${o.optionsData.debit} debit`)] : []),
      ]),
      moneyGroup(o, ctx, ready),
      el('div', { className: 'opp-kv-group' }, [
        kv('Sizing basis', lv(() => sizedFrom)),
        kv('Risk vs sizing bankroll', lv(() => (riskShare === null ? '—' : `${(riskShare * 100).toFixed(2)}% (${money(o.dollarRisk)})`)), mismatch ? 'text-short' : ''),
        ...(mismatch ? [el('p', { className: 'opp-size-warn', textContent: `Sized from the ${BASIS[basis] || basis}, but ${broker} is now LIVE. `
          + 'LIVE approval is blocked for this setup: dismiss it and the next scan re-proposes it sized from the live account.' })] : []),
        kv('Estimated entry cost', lv(() => cost(c.entry))),
        kv('Estimated exit cost (T1)', lv(() => cost(c.exitT1))),
        kv('Break-even move', lv(() => (Number.isFinite(c.breakEvenPct) ? `${o.direction === 'short' ? '−' : '+'}${(c.breakEvenPct * 100).toFixed(2)}%` : '—'))),
        kv('Net reward / risk (T1)', rr),
        kv('Fee drag', ready && Number.isFinite(o.feeDrag) ? `${o.feeDrag.toFixed(2)}R` : '—'),
      ]),
      el('h3', { className: 'opp-section opp-scen-title', textContent: ready ? `Price scenario (per ${size(o)})` : 'Price scenario' }),
      scenarioTable(o),
      actions(o, ctx),
    ]);
  }

  SD.oppDetail = { center, right, displaySymbol, hasLevels };
})();
