// Opportunities → Approvals: everything that passed every gate and now waits for
// the user, in one list with a one-click "Approve / Execute" each:
//   setups         staged orders from every strategy (incl. Portfolio Pilot buys):
//                  APPROVE runs the same order guard and live routing as Setups
//   pilot actions  Portfolio Pilot SELL / TRIM proposals for open positions:
//                  APPROVE_ACTION closes (or trims) the PAPER position at the live
//                  price; LIVE / adopted holdings are sold at the broker instead
// The server stays the source of truth: a card leaves only when its state does.
// Exposes window.SignalDesk.oppApprovals: { render(state, ctx), count(state) }.
(() => {
  const SD = window.SignalDesk;
  const { el, age, money, price, size } = SD.ui;

  const EXPIRY_MS = 30 * 60 * 1000; // order guard: a staged setup expires after 30 minutes
  const VENUE = { stocks: ['stockMode', 'Alpaca'], options: ['stockMode', 'Alpaca'], crypto: ['cryptoMode', 'Coinbase'] };
  const count = (state) => (state.pending || []).length + (state.pilotActions || []).length;
  const kv = (k, v, cls = '') => el('div', { className: 'apv-kv' }, [el('span', { textContent: k }), el('strong', { className: cls, textContent: v })]);

  function catalystChips(list) {
    return (list || []).length ? [el('div', { className: 'apv-cats' }, list.map((c) => el('span', { className: `apv-cat is-${String(c.type).toLowerCase()}`,
      textContent: `${c.type} ${c.daysAway === 0 ? 'today' : `in ${c.daysAway}d`}`, title: `${c.title} · ${c.date}${c.time ? ` ${c.time}` : ''} (${c.source})` })))] : [];
  }

  function setupCard(o, ctx) {
    const [modeKey, broker] = VENUE[o.market] || [null, '?'];
    const live = !!(ctx.state.settings && modeKey && ctx.state.settings[modeKey] === 'live');
    const busy = ctx.inFlight.has(o.id);
    const t1 = o.targets && o.targets[0] ? o.targets[0].price : null;
    const s = o.scenarios || {};
    const rr = s.t1 && s.stop && s.stop.net < 0 ? `${(s.t1.net / -s.stop.net).toFixed(2)} : 1` : '—';
    const left = Math.max(0, EXPIRY_MS - (Date.now() - (o.stagedAt || 0)));
    const blocked = live && o.market === 'options';
    const approve = el('button', { type: 'button', className: `btn apv-approve${live ? ' is-live' : ''}`, disabled: busy || !ctx.online || blocked,
      textContent: busy ? 'Sending…' : blocked ? 'Live options not wired' : live ? `Approve / Execute LIVE (${broker})` : 'Approve / Execute (paper)' });
    approve.onclick = () => ctx.onApprove(o, { live, broker });
    const review = el('button', { type: 'button', className: 'btn', textContent: 'Review chart' });
    review.onclick = () => ctx.onReview(o.id);
    const dismiss = el('button', { type: 'button', className: 'btn apv-dismiss', textContent: 'Dismiss', disabled: busy || !ctx.online });
    dismiss.onclick = () => ctx.onDismiss(o);
    const od = o.optionsData;
    return el('article', { className: 'apv-card' }, [
      el('header', { className: 'apv-head' }, [
        SD.scannerDetail.badge(o.asset),
        el('div', { className: 'apv-title' }, [el('strong', { textContent: `${o.direction === 'short' ? 'SELL' : 'BUY'} ${SD.oppDetail.displaySymbol(o)}` }),
          el('span', { textContent: `${o.setupType || 'Setup'} · ${o.strategyId} · ${o.tradeType || o.timeframe || ''}` })]),
        el('span', { className: `apv-expiry${left < 5 * 60 * 1000 ? ' is-soon' : ''}`, textContent: `staged ${age(o.stagedAt)} ago · expires in ${Math.ceil(left / 60000)}m` }),
      ]),
      el('div', { className: 'apv-grid' }, [
        kv('Size', `${size(o)}${od && od.contract ? ` · ${od.contract}` : ''}`),
        kv('Entry', `${price(o.entryZone.min, o)} – ${price(o.entryZone.max, o)}`),
        kv('Stop', price(o.invalidation, o), 'text-short'),
        kv('Target 1', t1 ? price(t1, o) : '—', 'text-long'),
        kv('Risk', `${money(o.dollarRisk)} (${o.sizingBankroll > 0 ? ((o.dollarRisk / o.sizingBankroll) * 100).toFixed(2) : '—'}%)`),
        kv('Reward : risk', rr),
      ]),
      ...(o.capitalCapped ? [el('p', { className: 'apv-note', textContent: `Capital cap: risking ${(o.actualRiskPct * 100).toFixed(2)}% instead of ${(o.riskPct * 100).toFixed(2)}%.` })] : []),
      ...(o.cappedByAmount ? [el('p', { className: 'apv-note', textContent: `Sized to the Pilot's ${money(o.maxNotional)} allocation.` })] : []),
      ...catalystChips(o.catalysts),
      el('p', { className: 'apv-thesis', textContent: o.thesis ? o.thesis.split(/(?<=\.)\s/).slice(0, 2).join(' ') : '' }),
      el('div', { className: 'apv-actions' }, [approve, review, dismiss]),
    ]);
  }

  function actionCard(a, ctx) {
    const pos = (ctx.state.positions || []).find((p) => p.id === a.positionId);
    const atBroker = a.execution === 'LIVE' || a.adopted;
    const busy = ctx.inFlight.has(a.id);
    const qty = pos ? (a.action === 'SELL' ? pos.positionSize : pos.positionSize * a.fraction) : null;
    const what = a.action === 'SELL' ? 'Sell the whole position' : `Sell ${Math.round(a.fraction * 100)}% of the position`;
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
        el('div', { className: 'apv-title' }, [el('strong', { textContent: `${a.action} ${SD.oppDetail.displaySymbol({ asset: a.asset, market: a.market })}` }),
          el('span', { textContent: `Portfolio Pilot defense · ${a.reason}` })]),
        el('span', { className: 'apv-expiry', textContent: `proposed ${age(a.createdAt)} ago` }),
      ]),
      el('div', { className: 'apv-grid' }, [
        kv('Holding', pos ? `${size(pos)} @ ${price(pos.fillPrice, pos)} · ${pos.execution === 'LIVE' ? 'LIVE' : 'paper'}` : '—'),
        kv('Live price', price(a.price, { market: a.market, entryPrice: a.price })),
        kv('200-day SMA', String(a.levels.sma200)),
        kv('50-day SMA', String(a.levels.sma50)),
      ]),
      el('p', { className: 'apv-thesis', textContent: a.detail }),
      el('div', { className: 'apv-actions' }, [approve, dismiss]),
    ]);
  }

  // ctx: { state, online, inFlight:Set, onApprove(o, {live, broker}), onDismiss(o), onReview(id), sendAction(type, id), matchesAsset(market) }
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

  SD.oppApprovals = { render, count, catalystChips };
})();
