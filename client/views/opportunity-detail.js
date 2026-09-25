// Setups tab: center (analysis) and right (risk & execution) panels for one
// pending order. Pure builders; opportunities.js owns selection and actions.
// Scenario figures come from the server (order.scenarios, same maths as the
// ledger), so what's shown here is exactly what would be booked.
// Exposes window.SignalDesk.oppDetail.
(() => {
  const SD = window.SignalDesk;
  const { el, money, price, size, signed, pnlClass } = SD.ui;

  const VENUE = { stocks: ['stockMode', 'Alpaca'], options: ['stockMode', 'Alpaca'], crypto: ['cryptoMode', 'Coinbase'] };
  const venueLive = (o, ctx) => { const [k] = VENUE[o.market] || []; return !!(ctx.settings && k && ctx.settings[k] === 'live'); };
  const displaySymbol = (o) => (o.market === 'crypto' ? o.asset.replace('-', '/') : o.asset);
  const px = (x, o) => price(x, o);
  const kv = (k, v, cls = '') => el('div', { className: 'opp-kv' }, [
    el('span', { className: 'opp-k', textContent: k }), el('span', { className: `opp-v ${cls}`, textContent: v })]);

  // ---------- Center: analysis ----------
  // A complete algorithmic setup: levels AND server-sized risk. Market Watch (or
  // anything missing these) is display-only: "—" everywhere, nothing executable.
  // Portfolio Pilot core holdings have no take-profit by design (stop + Pilot sell/trim).
  const hasLevels = (o) => !o.isWatch && !!o.id && !!o.entryZone && o.invalidation > 0
    && Array.isArray(o.targets) && (o.targets.length > 0 || o.strategyId === 'portfolio-pilot') && o.positionSize > 0;

  const WATCH_TEXT = 'Market Watch Mode: Waiting for algorithmic setups.';

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
    const chart = SD.liveChart.mount(o, { withLevels: !watch, banner: SD.positionDetail.banner(o, ctx, watch ? WATCH_TEXT : '') })
      || (watch ? SD.levelChart.watch(o, livePrice, WATCH_TEXT) : SD.levelChart.levels(o, livePrice));
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

  // Trade type and expected hold: from the setup (strategies set them); older
  // setups fall back to their strategy's defaults.
  const DURATION = {
    'equity-day': ['Day Trade', '1-4 hours (closed by the end of the session)'], 'crypto-swing': ['Swing Trade', '2-7 days'],
    'equity-swing': ['Swing Trade', '3-10 days'], 'options-system': ['Options Swing', '5-15 trading days (exit well before expiry)'],
  };
  function holdChip(o) {
    const [type, dur] = o.tradeType ? [o.tradeType, o.expectedDuration] : DURATION[o.strategyId] || [];
    return type ? el('div', { className: 'opp-hold' }, [el('strong', { textContent: type }), ` · expected hold ${dur}`]) : null;
  }

  // Options: the real contract (Phase 37) or, for older setups, the legs + debit.
  // Entry, stop and targets above are UNDERLYING prices; the premium is per share.
  function optionRows(od) {
    if (!od.contract) return [kv('Structure', `${(od.legs || []).map((l) => `${l.side} ${l.strike}${l.type === 'put' ? 'P' : 'C'}`).join(' / ')} · ${od.debit} debit`)];
    const exp = new Date(`${od.expiration}T12:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const em = od.expectedMove ? [kv('Expected Move', `±${od.expectedMove.value} (${(od.expectedMove.pct * 100).toFixed(1)}%) · T1 at ${od.expectedMove.t1Share.toFixed(2)} x EM${od.ivPercentile ? ` · IVP ${od.ivPercentile.pct} (proxy)` : ''}`)] : [];
    if (od.structure === 'vertical') {
      return [kv('Spread', `${od.label} · buy ${od.contract} / sell ${od.shortContract}`), kv('Net debit · max profit', `${od.debit} ($${(od.debit * od.multiplier).toFixed(0)}) · ${od.maxProfit} of ${od.width}`),
        kv('Exit on spread value', `stop ${od.exitRule.stopValue} (-50%) · T1 ${od.exitRule.targetValue} (80% of max)`), ...em, kv('Why a spread', od.spreadReason)];
    }
    return [
      kv('Contract', `${od.contract} (${exp} ${od.strike}C)`),
      kv('Premium (ask / bid)', `${od.ask} / ${od.bid} · $${(od.ask * od.multiplier).toFixed(0)} per contract`),
      kv('DTE · delta · IV', `${od.dte} days · ${Number(od.delta).toFixed(2)} · ${(od.iv * 100).toFixed(1)}%${od.greeksSource === 'model' ? ' (modelled)' : ''}`),
      kv('Option at stop / T1 (bid)', `${od.valueAtStop} / ${od.valueAtTarget}${od.stopLossPct ? ` · stop -${Math.round(od.stopLossPct * 100)}% of premium` : ' (modelled)'}`), ...em,
    ];
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
  function actions(o, ctx, amount) {
    const ready = hasLevels(o);
    const failing = ready ? SD.scannerData.blockers(o, ctx.state || {}) : []; // any failed gate (Expired...) blocks approval
    const blocked = (!!amount && amount.state === 'blocked') || failing.length > 0;
    const [modeKey, broker] = VENUE[o.market] || [null, '?'];
    const live = ctx.settings && modeKey && ctx.settings[modeKey] === 'live';
    const liveOptions = live && o.market === 'options';
    let label = live ? `Execute live on ${broker}` : 'Start paper tracking';
    if (liveOptions) label = 'Live options orders not wired yet';
    const wrongSizing = sizing(o, ctx).mismatch;
    if (wrongSizing) label = `Sized for ${sizing(o, ctx).basis === 'paper' ? 'paper' : 'another venue'}: dismiss & re-scan`;
    if (failing.length) label = `Blocked: ${failing.join(', ')}`;
    if (ctx.busy) label = 'Sending…';
    if (!ready) label = 'Waiting for Setup';
    const primary = el('button', {
      type: 'button',
      className: `btn ${live && ready ? 'btn-live' : 'btn-solid'} opp-go`,
      textContent: label,
      disabled: !ready || !ctx.online || ctx.busy || liveOptions || wrongSizing || blocked,
      title: !ready ? 'No algorithmic setup selected: nothing can be executed' : !ctx.online ? 'Offline' : failing.length ? 'A gate failed (Scanner gate checklist)' : blocked ? amount.note : '',
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

  function right(staged, ctx) {
    const ready = hasLevels(staged);
    const held = ready ? null : SD.positionDetail.panel(staged, ctx); // an open position on this symbol: its details
    if (held) return held;
    // Trade Amount ($): every figure below is for the amount chosen (trade-amount.js).
    const amount = ready ? SD.tradeAmount.resolve(staged, venueLive(staged, ctx)) : null;
    const o = amount ? amount.order : staged;
    const t = o.targets || [];
    const s = o.scenarios || {};
    const c = o.costs || {};
    const lv = (fn) => (ready ? fn() : '—');
    const cost = (x) => (Number.isFinite(x) ? money(x) : '—');
    const win = s.plan || s.t1; // a T1/T2 plan: the blended result (T1's share at T1, the runner at T2)
    const rr = ready && win && s.stop && s.stop.net < 0 ? `${(win.net / -s.stop.net).toFixed(2)} : 1` : '—';
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
      ...[ready ? holdChip(o) : null].filter(Boolean),
      ...(ready ? SD.oppApprovals.catalystChips(o.catalysts) : []), // FOMC / CPI / FDA inside the expected hold
      ...(ready && o.speculative ? [el('p', { className: 'opp-size-warn opp-moon-note', textContent: `Speculative Moonshot: micro-sized at ${Math.round(o.speculativeScale * 100)}% of normal risk (conviction ${o.conviction}).` })] : []),
      ...(summary ? [el('p', { className: 'opp-right-summary', textContent: summary })] : []),
      SD.sentiment.badge(o.asset, { compact: true }),
      el('div', { className: 'opp-kv-group' }, [
        kv('Entry range', lv(() => `${px(o.entryZone.min, o)} – ${px(o.entryZone.max, o)}`)),
        kv('Invalidation (stop)', lv(() => px(o.invalidation, o)), ready ? 'text-short' : ''),
        kv('Take profit 1 (T1)', lv(() => (t[0] ? px(t[0].price, o) : '—')), ready ? 'text-long' : ''),
        kv('Take profit 2 (T2)', lv(() => (t[1] ? px(t[1].price, o) : '—')), ready ? 'text-long' : ''),
        ...(ready && o.optionsData ? optionRows(o.optionsData) : []),
      ]),
      moneyGroup(o, ctx, ready),
      el('div', { className: 'opp-kv-group' }, [
        kv('Sizing basis', lv(() => sizedFrom)),
        kv('Risk vs sizing bankroll', lv(() => (riskShare === null ? '—' : `${(riskShare * 100).toFixed(2)}% (${money(o.dollarRisk)})`)), mismatch ? 'text-short' : ''),
        ...(mismatch ? [el('p', { className: 'opp-size-warn', textContent: `Sized from the ${BASIS[basis] || basis}, but ${broker} is now LIVE. `
          + 'LIVE approval is blocked for this setup: dismiss it and the next scan re-proposes it sized from the live account.' })] : []),
        ...(ready && o.capitalCapped ? [el('p', { className: 'opp-size-warn', textContent: `Capital cap: size limited to ${o.capitalCapPct * 100}% of the bankroll, `
          + `so this trade risks ${(o.actualRiskPct * 100).toFixed(2)}% instead of the profile's ${(o.riskPct * 100).toFixed(2)}% (the stop is tight relative to price).` })] : []),
        kv('Estimated entry cost', lv(() => cost(c.entry))),
        kv('Estimated exit cost (T1)', lv(() => cost(c.exitT1))),
        kv('Break-even move', lv(() => (Number.isFinite(c.breakEvenPct) ? `${o.direction === 'short' ? '−' : '+'}${(c.breakEvenPct * 100).toFixed(2)}%` : '—'))),
        kv(s.plan ? 'Net reward / risk (T1 + T2 plan)' : 'Net reward / risk (T1)', rr),
        kv('Fee drag', ready && Number.isFinite(o.feeDrag) ? `${o.feeDrag.toFixed(2)}R` : '—'),
      ]),
      el('h3', { className: 'opp-section opp-scen-title', textContent: ready ? `Price scenario (per ${size(o)})` : 'Price scenario' }),
      scenarioTable(o),
      ...(amount ? [SD.tradeAmount.control(staged, amount, ctx.rerender)] : []),
      actions(staged, ctx, amount),
    ]);
  }

  SD.oppDetail = { center, right, displaySymbol, hasLevels };
})();
