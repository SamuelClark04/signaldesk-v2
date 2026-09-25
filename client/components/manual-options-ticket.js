// Manual Trade Ticket → Options (Phase 60), for the 25 optionable stocks.
//   Structure    Call Spread · Put Spread · Single Call · Single Put
//   1-click      [⚡ Auto-Find Best Bull Call Spread] / [⚡ Auto-Find Best Bear Put
//                Spread]: System 5's builder on the live Alpaca chain (every gate,
//                incl. the exit-spread cap) -> the best spread + 2 alternatives
//   Custom       expiry (6-45 DTE), long strike, short strike, stop / T1 values
//                (blank = -50% / +80% of the debit), contracts
// The picks are sent as a spec (contract symbols); the server re-prices them on the
// live chain for the preview (net debit, projected exit spread, net delta, theta/day,
// max profit, breakeven, mid-hold T1, risk engine verdict) and again when opening.
// Exposes window.SignalDesk.manualOptionsTicket (used by manual-trade-ticket.js).
(() => {
  const SD = window.SignalDesk;
  const { el, money, signed } = SD.ui;

  const KINDS = [['call-spread', 'Call Spread', 'call', true], ['put-spread', 'Put Spread', 'put', true], ['call', 'Single Call', 'call', false], ['put', 'Single Put', 'put', false]];
  const kindOf = (k) => KINDS.find((x) => x[0] === k) || KINDS[0];
  const fresh = () => ({ kind: 'call-spread', chain: null, chainReq: 0, chainErr: null, plans: null, findReq: 0, findErr: null, finding: null, exp: '', long: '', short: '', stopValue: '', t1Value: '', contracts: '1' });

  function enter(t, api) {
    t.opt.chainReq = api.req('MANUAL_OPTIONS', { action: 'chain', asset: t.asset });
  }

  const expOf = (o) => (o.chain && o.chain.expirations || []).find((e) => e.expiration === o.exp) || null;
  const sideOf = (o) => { const e = expOf(o); const s = o.chain && o.chain.spot; return e ? (kindOf(o.kind)[2] === 'call' ? e.calls : e.puts).filter((c) => !s || Math.abs(c.strike / s - 1) <= 0.12) : []; };

  // Default picks: the first expiration >= 9 DTE, a ~0.55 delta long, a ~0.30 delta short.
  function autoPick(o) {
    const exps = (o.chain && o.chain.expirations) || [];
    if (!exps.length) return;
    if (!expOf(o)) o.exp = (exps.find((e) => e.dte >= 9) || exps[0]).expiration;
    const side = sideOf(o);
    const near = (d) => side.filter((c) => Number.isFinite(c.delta)).sort((a, b) => Math.abs(Math.abs(a.delta) - d) - Math.abs(Math.abs(b.delta) - d))[0];
    if (!side.some((c) => c.symbol === o.long)) o.long = (near(0.55) || {}).symbol || '';
    const spread = kindOf(o.kind)[3];
    const beyond = shortChoices(o);
    if (!spread) o.short = '';
    else if (!beyond.some((c) => c.symbol === o.short)) o.short = ((beyond.filter((c) => Number.isFinite(c.delta)).sort((a, b) => Math.abs(Math.abs(a.delta) - 0.3) - Math.abs(Math.abs(b.delta) - 0.3))[0]) || beyond[0] || {}).symbol || '';
  }
  function shortChoices(o) {
    const side = sideOf(o);
    const long = side.find((c) => c.symbol === o.long);
    if (!long) return [];
    return side.filter((c) => (kindOf(o.kind)[2] === 'call' ? c.strike > long.strike : c.strike < long.strike));
  }

  function received(t, p, api) {
    const o = t.opt;
    if (p.requestId === o.chainReq) {
      o.chain = p.ok ? p : null;
      o.chainErr = p.ok ? null : p.error;
      autoPick(o);
      api.schedulePreview();
    } else if (p.requestId === o.findReq) {
      o.finding = null;
      o.plans = p.ok ? p.plans : null;
      o.findErr = p.ok ? p.capNote : p.error;
      if (p.ok && p.plans[0]) use(t, p.plans[0], api);
    }
  }

  // Load an auto-found plan into the custom picker (it stays editable).
  function use(t, plan, api) {
    const o = t.opt;
    o.kind = `${plan.type}-spread`;
    if (plan.structure === 'single') o.kind = plan.type;
    Object.assign(o, { exp: plan.spec.expiration, long: plan.spec.long, short: plan.spec.short || '', stopValue: String(plan.stopValue), t1Value: String(plan.t1Value) });
    api.schedulePreview();
  }

  function ticket(t) {
    const o = t.opt;
    const spec = o.long && (o.short || !kindOf(o.kind)[3]) ? { type: kindOf(o.kind)[2], expiration: o.exp, long: o.long, short: kindOf(o.kind)[3] ? o.short : null,
      stopValue: Number(o.stopValue) || null, t1Value: Number(o.t1Value) || null } : null;
    return { mode: 'options', asset: t.asset, spec, contracts: Math.max(1, Math.floor(Number(o.contracts) || 1)) };
  }

  // ---------- Rendering ----------
  const kv = (k, v, cls = '') => el('div', { className: 'mt-kv' }, [el('span', { textContent: k }), el('strong', { className: cls, textContent: v })]);
  const usd = (x) => (Number.isFinite(x) ? money(x) : '—');
  const select = (id, label, value, choices, onPick) => {
    const s = el('select', { id: `mt-${id}`, className: 'input mt-select' }, choices.map(([v, text]) => el('option', { value: v, textContent: text })));
    s.value = value;
    s.onchange = () => onPick(s.value);
    return el('label', { className: 'mt-field' }, [el('span', { className: 'mt-label', textContent: label }), s]);
  };
  const input = (id, label, o, key, api, placeholder) => {
    const i = el('input', { id: `mt-${id}`, className: 'input mt-input', type: 'text', inputMode: 'decimal', value: o[key], placeholder });
    i.oninput = () => { o[key] = i.value; api.schedulePreview(); };
    return el('label', { className: 'mt-field' }, [el('span', { className: 'mt-label', textContent: label }), i]);
  };
  const legText = (c) => `${c.strike} · Δ ${Number.isFinite(c.delta) ? Math.abs(c.delta).toFixed(2) : '—'} · ${c.bid.toFixed(2)}/${c.ask.toFixed(2)}`;

  function planCard(t, p, api, i) {
    const b = el('button', { type: 'button', className: 'btn mt-use', textContent: i === 0 ? 'Best · use' : 'Use' });
    b.onclick = () => { use(t, p, api); api.render(); };
    return el('div', { className: `mt-plan${p.overCap ? ' is-wide' : ''}` }, [
      el('strong', { textContent: p.label }),
      el('span', { textContent: `$${Math.round(p.debit * 100)} debit · exit spread $${p.exitSpread.toFixed(2)} · Δ ${p.netDelta.toFixed(2)} · θ ${signed(p.thetaDay, money)}/day · max ${usd(p.maxProfit)} · BE ${p.breakeven} · T1 ${p.t1}` }), b]);
  }

  function summary(t) {
    const p = t.preview;
    if (!p) return [el('p', { className: 'mt-note', textContent: t.opt.long ? 'Pricing on the live chain…' : 'Pick strikes, or let ⚡ Auto-Find choose.' })];
    const s = p.options;
    const out = [];
    if (s) {
      out.push(el('div', { className: 'mt-grid mt-out' }, [
        kv('Net debit', `${s.debit} · ${usd(s.debit * 100)}/contract (net mid ${s.netMid})`),
        kv('Projected exit spread', `${usd(s.exitSpread)}/contract${s.cap ? ` (cap $${s.cap.toFixed(2)})` : ''}`, s.overCap ? 'pnl-neg' : ''),
        kv('Net delta', Number.isFinite(s.netDelta) ? `${s.netDelta.toFixed(2)} · ${signed(s.netDelta * 100, money)} per $1` : '—'),
        kv('Net theta / day', Number.isFinite(s.thetaDay) ? signed(s.thetaDay, money) : '—', s.thetaDay < 0 ? 'pnl-neg' : 'pnl-pos'),
        kv('Max profit', s.maxProfit ? usd(s.maxProfit) : 'uncapped (single)'),
        kv('Breakeven (expiry)', String(s.breakeven)),
        kv('Mid-hold T1', `${t.asset} ${s.t1} (worth ${s.t1Value})`),
        kv('Stop / T1 / T2 (value)', `${s.stopValue} / ${s.t1Value}${s.t2Value ? ` / ${s.t2Value}` : ''}`),
      ]));
      if (s.overCap) out.push(el('p', { className: 'mt-note is-warn', textContent: `Exit spread $${s.exitSpread.toFixed(2)} is over your $${s.cap.toFixed(2)} cap: System 5 would skip it. A manual ticket may still open it.` }));
    }
    if (p.priceBasis && !p.live) out.push(el('p', { className: 'mt-note is-warn', textContent: `Priced on the ${p.priceBasis}; the chain shows its last quotes.` }));
    if (!p.ok) out.push(el('p', { className: 'mt-error', textContent: p.error }));
    else out.push(el('div', { className: 'mt-grid mt-out' }, [kv('Size', `${p.qty} contract${p.qty === 1 ? '' : 's'} · ${usd(p.notional)}`), kv('Risk ($) at the stop', usd(p.dollarRisk), 'pnl-neg'),
      kv('Net at T1', Number.isFinite(p.t1Net) ? signed(p.t1Net, money) : '—', p.t1Net > 0 ? 'pnl-pos' : 'pnl-neg'), kv('Net R:R (T1)', p.rr ? `${p.rr.toFixed(2)} : 1` : '—')]));
    return out;
  }

  function section(t, api) {
    const o = t.opt;
    const [, , type, spread] = kindOf(o.kind);
    const seg = el('div', { className: 'mt-seg', role: 'radiogroup' }, KINDS.map(([k, label]) => {
      const b = el('button', { type: 'button', className: `mt-seg-btn${k === o.kind ? ' is-active' : ''}`, textContent: label });
      b.onclick = () => { if (k === o.kind) return; o.kind = k; o.long = ''; o.short = ''; o.stopValue = ''; o.t1Value = ''; autoPick(o); api.schedulePreview(); api.render(); };
      return b;
    }));
    const find = (ty) => {
      const b = el('button', { type: 'button', className: 'btn mt-find', disabled: !!o.finding, textContent: o.finding === ty ? 'Searching the live chain…' : `⚡ Auto-Find Best ${ty === 'call' ? 'Bull Call' : 'Bear Put'} Spread` });
      b.onclick = () => { o.finding = ty; o.plans = null; o.findErr = null; o.findReq = api.req('MANUAL_OPTIONS', { action: 'autofind', asset: t.asset, optType: ty }); api.render(); };
      return b;
    };
    const exps = (o.chain && o.chain.expirations) || [];
    const side = sideOf(o);
    const picker = !o.chain ? [el('p', { className: o.chainErr ? 'mt-error' : 'mt-note', textContent: o.chainErr || 'Loading the live chain…' })] : [el('div', { className: 'mt-grid' }, [
      select('exp', 'Expiry (6-45 DTE)', o.exp, exps.map((e) => [e.expiration, `${e.expiration} · ${e.dte} DTE`]), (v) => { o.exp = v; autoPick(o); api.schedulePreview(); api.render(); }),
      select('long', `Long ${type} (buy)`, o.long, side.map((c) => [c.symbol, legText(c)]), (v) => { o.long = v; if (spread) { o.short = ''; autoPick(o); } api.schedulePreview(); api.render(); }),
      ...(spread ? [select('short', `Short ${type} (sell)`, o.short, shortChoices(o).map((c) => [c.symbol, legText(c)]), (v) => { o.short = v; api.schedulePreview(); api.render(); })] : []),
      input('stopv', 'Stop (spread value)', o, 'stopValue', api, '−50% of debit'),
      input('t1v', 'T1 (spread value)', o, 't1Value', api, '+80% of debit'),
      input('contracts', 'Contracts', o, 'contracts', api, '1'),
    ])];
    return [
      seg,
      el('div', { className: 'mt-finds' }, [find('call'), find('put')]),
      ...(o.findErr ? [el('p', { className: o.plans ? 'mt-note is-warn' : 'mt-error', textContent: o.findErr })] : []),
      ...(o.plans ? [el('div', { className: 'mt-plans' }, o.plans.map((p, i) => planCard(t, p, api, i)))] : []),
      ...picker,
      ...summary(t),
    ];
  }

  SD.manualOptionsTicket = { fresh, enter, received, ticket, section };
})();
