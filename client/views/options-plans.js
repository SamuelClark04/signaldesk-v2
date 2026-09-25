// After-hours options plans (Phase 57, OPTIONS_PLANS: server/execution/after-hours-plans.js).
// With the market closed, System 5's call / put spreads are priced on the last
// close and the chain's last quotes and run through the real risk engine; the ones
// it approves are shown here, in Approvals, as reviewable plans. They are never
// approvable from here: at the open the same setup is re-priced on live quotes and
// staged like any other (then it gets its Approve button).
// Exposes window.SignalDesk.optionsPlans: { section(state, ctx) }.
(() => {
  const SD = window.SignalDesk;
  const { el, age, money, price } = SD.ui;

  const kv = (k, v, cls = '') => el('div', { className: 'apv-kv' }, [el('span', { textContent: k }), el('strong', { className: cls, textContent: v })]);
  const usd = (x) => money(x * 100);

  // Chart the underlying with this plan's ENTRY / SL / T1 / T2 / BE lines (Setups, Market Watch overlay).
  function chartBtn(p, ctx) {
    const b = el('button', { type: 'button', className: 'btn', textContent: 'Chart levels', disabled: !ctx.onWatch });
    b.onclick = () => ctx.onWatch(p.asset);
    return b;
  }

  function card(p, ctx) {
    const o = { market: 'stocks', entryPrice: p.refSpot };
    const bear = p.type === 'put';
    const legs = p.legs.map((l) => `${l.side === 'buy' ? 'Buy' : 'Sell'} ${l.strike}${l.type === 'put' ? 'P' : 'C'} (Δ ${Math.abs(l.delta).toFixed(2)})`).join(' · ');
    return el('article', { className: 'apv-card is-plan' }, [
      el('header', { className: 'apv-head' }, [
        SD.scannerDetail.badge(p.asset),
        el('div', { className: 'apv-title' }, [el('strong', { textContent: `BUY ${p.label}` }),
          el('span', { textContent: `${p.setupType} · ${p.timeframe} · ${p.dte} DTE · ${legs}` })]),
        el('span', { className: `opp-pill ${bear ? 'is-bear' : 'is-bull'}`, textContent: bear ? 'Bearish · put' : 'Bullish · call' }),
      ]),
      el('div', { className: 'apv-grid' }, [
        kv('Debit (package)', `${p.debit} · ${usd(p.debit)}${p.width ? ` of ${usd(p.width)} max` : ''}`),
        kv('Size', `${p.positionSize} ${p.structure === 'vertical' ? 'spread' : 'contract'}${p.positionSize === 1 ? '' : 's'} · ${money(p.premium)}`),
        kv('Stop (its value)', `${p.stopValue} · ${p.asset} ~${price(p.invalidation, o)}`, 'text-short'),
        kv('T1 / T2 (its value)', `${p.t1Value}${p.t2Value ? ` / ${p.t2Value}` : ''} · ${p.asset} ~${price(p.t1, o)}`, 'text-long'),
        kv('Risk', `${money(p.dollarRisk)} (${((p.dollarRisk / p.sizingBankroll) * 100).toFixed(2)}%)${p.smallAccountCap ? ' · 1-contract cap' : ''}`),
        kv('T1 net reward : risk', `${p.netRR.toFixed(2)} : 1 · costs ${p.feeDrag.toFixed(2)}R`),
      ]),
      ...(p.stats ? [el('div', { className: 'apv-grid' }, SD.optionStats.rows({ asset: p.asset, optionsData: { type: p.type, midHoldAt: p.midHoldAt, exitRule: { targetValue: p.t1Value }, refSpot: p.refSpot },
        targets: [{ price: p.t1 }] }, p.stats, p.refSpot).map(([k, v, cls]) => kv(k, v, cls)))] : []),
      el('p', { className: 'apv-thesis', textContent: p.thesis.split(/(?<=\.)\s/).slice(0, 3).join(' ') }),
      el('div', { className: 'apv-actions' }, [el('button', { type: 'button', className: 'btn btn-solid', disabled: true, textContent: 'Stages on live quotes at the open',
        title: 'Priced on the last close: nothing can be approved until the market is open' }), chartBtn(p, ctx)]),
      el('p', { className: 'apv-note', textContent: `Planned ${age(p.plannedAt)} ago on the last close; cleared the risk engine. Re-priced live at 9:30 ET.` }),
    ]);
  }

  // ctx: { matchesAsset(market) }. [] when there is nothing to show.
  function section(state, ctx) {
    const list = (state.optionsPlans || []).filter(() => ctx.matchesAsset('options'));
    if (!list.length) return [];
    return [el('h4', { className: 'opp-section', textContent: `Options plans for the open (${list.length}, market closed)` }), ...list.map((p) => card(p, ctx))];
  }

  SD.optionsPlans = { section };
})();
