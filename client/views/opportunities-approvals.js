// Opportunities → Approvals: everything that passed every gate and now waits for
// the user, in one list with a one-click "Approve / Execute" each:
//   setups         staged orders from every strategy (incl. Portfolio Pilot buys):
//                  APPROVE runs the same order guard and live routing as Setups,
//                  at the card's Trade Amount ($) (trade-amount.js)
//   pilot actions  Portfolio Pilot SELL / TRIM proposals for open positions:
//                  APPROVE_ACTION closes (or trims) the PAPER position at the live
//                  price; LIVE / adopted holdings are sold at the broker instead.
//                  EXTERNAL holdings: [MANUAL · ROBINHOOD] cards carry the exact
//                  instruction and "Confirm Executed" updates the holding; broker-
//                  synced ones send a real market sell (Coinbase / Alpaca LIVE)
// The server stays the source of truth: a card leaves only when its state does.
// Exposes window.SignalDesk.oppApprovals: { render(state, ctx), count(state) }.
(() => {
  const SD = window.SignalDesk;
  const { el, age, money, price, size } = SD.ui;

  const EXPIRY_MS = 30 * 60 * 1000; // order guard: a staged setup expires after 30 minutes
  const VENUE = { stocks: ['stockMode', 'Alpaca'], options: ['stockMode', 'Alpaca'], crypto: ['cryptoMode', 'Coinbase'] };
  const count = (state) => (state.pending || []).length + (state.pilotActions || []).length;
  const kv = (k, v, cls = '') => el('div', { className: 'apv-kv' }, [el('span', { textContent: k }), el('strong', { className: cls, textContent: v })]);

  // Order-guard and broker reasons from the server, in plain words (ACTION_FAILED notices).
  const FAIL_REASONS = {
    EXPIRED: 'setup is older than 30 minutes and was discarded',
    PRICE_ESCAPED: 'price moved past the entry zone and the setup was discarded',
    INVALIDATED: 'price is already through the stop and the setup was discarded',
    NO_LIVE_PRICE: 'no fresh price available; still pending, try again shortly',
    LIVE_OPTIONS_UNSUPPORTED: 'live options orders are not wired to Alpaca yet (the contract and prices are real; the order routing is not). Nothing was sent; '
      + 'the order is still pending (set Alpaca mode to Paper to fill it on paper)',
    ORDER_BUSY: 'an action for this order is already in progress',
    LIVE_CLOSE_UNSUPPORTED: 'it is a LIVE position: close it at the broker (its exits are orders there)',
  };
  function describeFailure(error) {
    if (FAIL_REASONS[error]) return FAIL_REASONS[error];
    const [code, ...rest] = String(error).split(': ');
    if (code === 'LIVE_ORDER_FAILED') return `live order rejected, nothing was filled (${rest.join(': ')})`;
    if (code === 'LIVE_UNRECORDED') return `CHECK YOUR BROKER NOW: ${rest.join(': ')}`;
    if (code.startsWith('AMOUNT_')) return `trade amount not accepted, nothing was sent and the setup is still pending (${rest.join(': ')})`;
    if (code === 'SIZED_FOR_OTHER_VENUE') return `nothing was sent: this setup was ${rest.join(': ')}. Dismiss it; the next scan re-proposes it sized from the live account`;
    return error;
  }

  function catalystChips(list) {
    return (list || []).length ? [el('div', { className: 'apv-cats' }, list.map((c) => el('span', { className: `apv-cat is-${String(c.type).toLowerCase()}`,
      textContent: `${c.type} ${c.daysAway === 0 ? 'today' : `in ${c.daysAway}d`}`, title: `${c.title} · ${c.date}${c.time ? ` ${c.time}` : ''} (${c.source})` })))] : [];
  }

  function setupCard(staged, ctx) {
    const [modeKey, broker] = VENUE[staged.market] || [null, '?'];
    const live = !!(ctx.state.settings && modeKey && ctx.state.settings[modeKey] === 'live');
    const amount = SD.tradeAmount.resolve(staged, live);
    const o = amount.order; // size, risk and P&L at the chosen amount
    const busy = ctx.inFlight.has(o.id);
    const t1 = o.targets && o.targets[0] ? o.targets[0].price : null;
    const s = o.scenarios || {};
    const best = s.plan || s.t1; // a T1/T2 plan: the blended result
    const rr = best && s.stop && s.stop.net < 0 ? `${(best.net / -s.stop.net).toFixed(2)} : 1${s.plan ? ' blended' : ''}` : '—';
    // The order guard's window runs from the setup's own timestamp, not from staging.
    const left = Math.max(0, EXPIRY_MS - (Date.now() - (Date.parse(o.timestamp) || o.stagedAt || 0)));
    const blocked = live && o.market === 'options';
    const failing = SD.scannerData.blockers(staged, ctx.state); // any failed gate (Expired, Escaped...) blocks approval
    const approve = el('button', { type: 'button', className: `btn apv-approve${live ? ' is-live' : ''}`, disabled: busy || !ctx.online || blocked || amount.state === 'blocked' || failing.length > 0,
      textContent: busy ? 'Sending…' : failing.length ? `Blocked: ${failing.join(', ')}` : blocked ? 'Live options not wired' : live ? `Approve / Execute LIVE (${broker})` : 'Approve / Execute (paper)' });
    approve.onclick = () => ctx.onApprove(staged, { live, broker });
    const review = el('button', { type: 'button', className: 'btn', textContent: 'Review chart' });
    review.onclick = () => ctx.onReview(o.id);
    const dismiss = el('button', { type: 'button', className: 'btn apv-dismiss', textContent: 'Dismiss', disabled: busy || !ctx.online });
    dismiss.onclick = () => ctx.onDismiss(o);
    const od = o.optionsData;
    return el('article', { className: `apv-card${o.speculative ? ' is-moon' : ''}` }, [
      el('header', { className: 'apv-head' }, [
        SD.scannerDetail.badge(o.asset),
        ...(o.speculative ? [el('span', { className: 'opp-moon', textContent: 'Speculative Moonshot' })] : []),
        el('div', { className: 'apv-title' }, [el('strong', { textContent: `${o.direction === 'short' ? 'SELL' : 'BUY'} ${SD.oppDetail.displaySymbol(o)}` }),
          el('span', { textContent: `${o.setupType || 'Setup'} · ${o.strategyId} · ${o.tradeType || o.timeframe || ''}` })]),
        el('span', { className: `apv-expiry${left < 5 * 60 * 1000 ? ' is-soon' : ''}`, textContent: left > 0 ? `staged ${age(o.stagedAt)} ago · expires in ${Math.ceil(left / 60000)}m` : 'Expired: leaving the queue' }),
      ]),
      el('div', { className: 'apv-grid' }, [
        kv('Size', `${size(o)} · ${money(o.notional)}${od && od.contract ? ` · ${od.label || od.contract}` : ''}`),
        kv('Entry', `${price(o.entryZone.min, o)} – ${price(o.entryZone.max, o)}`),
        kv('Stop', price(o.invalidation, o), 'text-short'),
        kv(o.targets && o.targets[1] ? 'T1 (50%) / T2' : 'Target 1', t1 ? `${price(t1, o)}${o.targets[1] ? ` / ${price(o.targets[1].price, o)}` : ''}` : '—', 'text-long'),
        kv('Risk', `${money(o.dollarRisk)} (${o.sizingBankroll > 0 ? ((o.dollarRisk / o.sizingBankroll) * 100).toFixed(2) : '—'}%)`),
        kv('Reward : risk', rr),
      ]),
      ...(o.speculative ? [el('p', { className: 'apv-note', textContent: `Smart Investment Amount ${money(o.notional)}: ${Math.round(o.speculativeScale * 100)}% of normal risk (${(o.speculativeRiskPct * 100).toFixed(2)}% of the bankroll, conviction ${o.conviction}). Hype moves reverse fast.` })] : []),
      ...(o.smallAccountCap ? [el('p', { className: 'apv-note is-small-cap', textContent: `${o.smallAccountLabel}: 1 contract risks ${money(o.dollarRisk)} `
        + `(${((o.dollarRisk / o.sizingBankroll) * 100).toFixed(1)}% of the bankroll) to its stop, above the ${money(o.budgetRisk)} profile budget; debit ${money(o.notional)}.` })] : []),
      ...(o.capitalCapped ? [el('p', { className: 'apv-note', textContent: `Capital cap: risking ${(o.actualRiskPct * 100).toFixed(2)}% instead of ${(o.riskPct * 100).toFixed(2)}%.` })] : []),
      ...(o.cappedByAmount && amount.amount === null ? [el('p', { className: 'apv-note', textContent: `Sized to the Pilot's ${money(o.maxNotional)} allocation.` })] : []),
      ...catalystChips(o.catalysts),
      el('p', { className: 'apv-thesis', textContent: o.thesis ? o.thesis.split(/(?<=\.)\s/).slice(0, 2).join(' ') : '' }),
      SD.tradeAmount.control(staged, amount, ctx.rerender),
      el('div', { className: 'apv-actions' }, [approve, review, dismiss]),
    ]);
  }

  function actionCard(a, ctx) {
    const pos = (ctx.state.positions || []).find((p) => p.id === a.positionId)
      || ((ctx.state.external && ctx.state.external.positions) || []).find((p) => p.id === a.positionId);
    if (a.external) return externalCard(a, pos, ctx);
    const atBroker = a.execution === 'LIVE' || a.adopted;
    const busy = ctx.inFlight.has(a.id);
    const qty = pos ? (a.action === 'SELL' ? pos.positionSize : pos.positionSize * a.fraction) : null;
    const what = a.action === 'SELL' ? `Sell the whole position${a.rotation ? ` (then rotate ~${money(a.rotation.proceeds)} into ${a.rotation.asset}: its buy waits below as a setup)` : ''}`
      : `Sell ${Math.round(a.fraction * 100)}% of the position`;
    const label = a.action === 'SELL' && a.rotation ? 'SELL + ROTATE' : a.action;
    const approve = el('button', { type: 'button', className: 'btn apv-approve is-sell', disabled: busy || !ctx.online || atBroker,
      textContent: busy ? 'Sending…' : atBroker ? 'Sell at the broker' : `Approve / Execute ${a.action} (paper)` });
    approve.title = atBroker ? 'LIVE / adopted holding: SignalDesk places no sell orders for it; sell it at the broker' : '';
    approve.onclick = () => {
      if (!window.confirm(`${a.action} ${a.asset} (paper) at the live price?\n\n${what}${qty ? ` (~${qty.toFixed(qty < 1 ? 6 : 2)})` : ''}.\n${a.reason}.`)) return;
      ctx.sendAction('APPROVE_ACTION', a.id);
    };
    const dismiss = el('button', { type: 'button', className: 'btn apv-dismiss', textContent: 'Dismiss for today', disabled: busy || !ctx.online });
    dismiss.onclick = () => ctx.sendAction('DISMISS_ACTION', a.id);
    return el('article', { className: `apv-card is-${a.action.toLowerCase()}` }, [
      el('header', { className: 'apv-head' }, [
        SD.scannerDetail.badge(a.asset),
        el('div', { className: 'apv-title' }, [el('strong', { textContent: `${label} ${SD.oppDetail.displaySymbol({ asset: a.asset, market: a.market })}${a.rotation ? ` → ${a.rotation.asset}` : ''}` }),
          el('span', { textContent: `Portfolio Pilot defense · ${a.reason}` })]),
        el('span', { className: 'apv-expiry', textContent: `proposed ${age(a.createdAt)} ago` }),
      ]),
      el('div', { className: 'apv-grid' }, [
        kv('Holding', pos ? `${size(pos)} @ ${price(pos.fillPrice, pos)} · ${pos.execution === 'LIVE' ? 'LIVE' : 'paper'}` : '—'),
        ...(a.rotation ? [kv('Rotate into', `${a.rotation.asset} (#1 ranked, score ${a.rotation.score})`, 'text-long')] : []),
        kv('Live price', price(a.price, { market: a.market, entryPrice: a.price })),
        kv('200-day SMA', String(a.levels.sma200)),
        kv('50-day SMA', String(a.levels.sma50)),
      ]),
      el('p', { className: 'apv-thesis', textContent: a.detail }),
      el('div', { className: 'apv-actions' }, [approve, dismiss]),
    ]);
  }

  // An action on a holding SignalDesk did not open: the instruction first.
  function externalCard(a, pos, ctx) {
    const busy = ctx.inFlight.has(a.id);
    const label = a.action === 'SELL' && a.rotation ? 'SELL + ROTATE' : a.action;
    const tag = `${a.manual ? 'MANUAL' : 'LIVE'} · ${String(a.broker).toUpperCase()}`;
    const approve = el('button', { type: 'button', className: `btn apv-approve ${a.manual ? 'is-manual' : 'is-sell'}`, disabled: busy || !ctx.online,
      textContent: busy ? 'Sending…' : a.manual ? `Confirm Executed in ${a.broker}` : `Approve / ${a.action === 'ADD' ? 'BUY' : 'SELL'} LIVE at ${a.broker}` });
    approve.onclick = () => {
      const msg = a.manual ? `Confirm you did this in ${a.broker}?\n\n${a.instruction}\n\nSignalDesk updates the ${a.asset} holding (${a.action === 'ADD' ? 'adds' : 'deducts'} ${a.quantity}).`
        : `Send a REAL market order to ${a.broker}?\n\n${a.instruction}\n\n${a.reason}. This uses real money.`;
      if (window.confirm(msg)) ctx.sendAction('APPROVE_ACTION', a.id);
    };
    const dismiss = el('button', { type: 'button', className: 'btn apv-dismiss', textContent: 'Dismiss for today', disabled: busy || !ctx.online });
    dismiss.onclick = () => ctx.sendAction('DISMISS_ACTION', a.id);
    const lv = a.levels || {};
    return el('article', { className: `apv-card is-${a.action.toLowerCase()} is-external` }, [
      el('header', { className: 'apv-head' }, [
        SD.scannerDetail.badge(a.asset),
        el('div', { className: 'apv-title' }, [el('span', { className: `apv-tag${a.manual ? ' is-manual' : ''}`, textContent: `[${tag}]` }),
          el('strong', { textContent: `${label} ${SD.oppDetail.displaySymbol({ asset: a.asset, market: a.market })}${a.rotation ? ` → ${a.rotation.asset}` : ''}` }),
          el('span', { textContent: `Portfolio Pilot · ${a.reason}` })]),
        el('span', { className: 'apv-expiry', textContent: `proposed ${age(a.createdAt)} ago` }),
      ]),
      el('p', { className: 'apv-instruction', textContent: a.instruction }),
      el('div', { className: 'apv-grid' }, [
        kv('Holding', pos ? `${size(pos)} @ ${price(pos.fillPrice, pos)} · ${pos.broker}` : '—'),
        kv('Live price', price(a.price, { market: a.market, entryPrice: a.price })),
        ...(lv.stop ? [kv('Stop / T1', `${price(lv.stop, { market: a.market, entryPrice: a.price })} / ${lv.t1 ? price(lv.t1, { market: a.market, entryPrice: a.price }) : '—'}`)] : []),
        ...(lv.sma200 ? [kv('200-day SMA', String(lv.sma200))] : []),
        ...(a.rotation ? [kv('Rotate into', `${a.rotation.asset} (#1 ranked, score ${a.rotation.score})`, 'text-long')] : []),
      ]),
      el('p', { className: 'apv-thesis', textContent: a.detail || '' }),
      el('div', { className: 'apv-actions' }, [approve, dismiss]),
    ]);
  }

  // ctx: { state, online, inFlight:Set, onApprove(o, {live, broker}), onDismiss(o), onReview(id), sendAction(type, id), matchesAsset(market), rerender() }
  function render(state, ctx) {
    const orders = [...(state.pending || [])].filter((o) => ctx.matchesAsset(o.market)).sort((a, b) => b.stagedAt - a.stagedAt);
    const actions = (state.pilotActions || []).filter((a) => ctx.matchesAsset(a.market));
    const empty = !orders.length && !actions.length;
    return el('div', { className: 'apv' }, [
      el('div', { className: 'apv-bar' }, [el('h3', { className: 'scan-h', textContent: `Approvals (${orders.length + actions.length})` }),
        el('span', { className: 'slog-muted', textContent: 'Every item here passed the risk engine or a Pilot rule. Nothing executes until you approve it.' })]),
      ...(actions.length ? [el('h4', { className: 'opp-section', textContent: 'Portfolio Pilot: protect open positions' }), ...actions.map((a) => actionCard(a, ctx))] : []),
      ...(orders.length ? [el('h4', { className: 'opp-section', textContent: 'New trades' }), ...orders.map((o) => setupCard(o, ctx))] : []),
      ...(empty ? [el('p', { className: 'opp-muted', textContent: 'Nothing is waiting for approval. New setups appear here the moment a strategy stages one; '
        + 'enter a deposit in Portfolio → Pilot to generate buy setups.' })] : []),
    ]);
  }

  SD.oppApprovals = { render, count, catalystChips, setupCard, describeFailure };
})();
