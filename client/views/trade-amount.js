// Trade Amount ($): the per-trade dollar override of a staged setup, on the
// Setups risk card and on every Approvals card. The risk engine sized the order
// (risk budget + Max Capital Per Trade); here the user can scale it DOWN to any
// valid minimum, or UP (confirmed on approval) as far as the bankroll it was
// sized from. Quantity, capital, risk and the price scenarios are the server's
// own figures scaled by the new quantity: fees, P&L and risk are all linear in
// size, so the preview is exact. On approval the server re-sizes the order the
// same way (risk-engine.js resizeOrder) and refuses anything invalid.
// Exposes window.SignalDesk.tradeAmount: { resolve(o, live), control(o, r, onChange), prune(pending) }.
(() => {
  const SD = window.SignalDesk;
  const { el, money, size } = SD.ui;

  const MIN_USD = 1; // risk-engine.js MIN_TRADE_USD
  const PILLS = [['$25', () => 25], ['$50', () => 50], ['$100', () => 100], ['$250', () => 250], ['10%', (o) => 0.10 * o.sizingBankroll], ['Max', null]];
  const drafts = new Map(); // order id -> the amount as typed (absent: the risk engine's size)

  const perUnit = (o) => (o.market === 'options' ? o.optionsData.debit * o.optionsData.multiplier : o.entryPrice);
  const minText = (o, live) => (o.market === 'options' ? 'one contract' : o.market === 'stocks' && live && !o.fractional ? 'one whole share' : `$${MIN_USD}`);

  // Units for `dollars`, rounded down like the server: whole option contracts;
  // shares to 0.0001 when fractional (paper, or a Pilot buy), else whole (live
  // Alpaca brackets need whole shares); coins to 8 decimals.
  function units(o, dollars, live) {
    const q = dollars / perUnit(o);
    if (o.market === 'options') return Math.floor(q + 1e-9);
    if (o.market === 'stocks') return o.fractional || !live ? Math.floor(q * 1e4 + 1e-9) / 1e4 : Math.floor(q);
    return Math.floor(q * 1e8) / 1e8;
  }

  // The order as it would execute at the chosen amount:
  // { order, amount (null = the risk engine's size), raw, state: ok | above | blocked, note }.
  function resolve(o, live) {
    const raw = drafts.get(o.id);
    const base = { order: o, amount: null, raw: raw === undefined ? (o.notional || 0).toFixed(2) : raw, state: 'ok', note: '' };
    if (raw === undefined || !(o.positionSize > 0) || !(o.notional > 0)) return base;
    const dollars = Number(String(raw).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(dollars) || dollars <= 0) return { ...base, state: 'blocked', note: 'Enter a dollar amount above $0.' };
    const same = Math.abs(dollars - o.notional) < 0.005;
    const qty = same ? o.positionSize : units(o, dollars, live);
    const notional = qty * perUnit(o);
    if (!(qty > 0) || (o.market !== 'options' && notional < MIN_USD)) {
      return { ...base, state: 'blocked', note: `Too small: ${money(dollars)} buys less than ${minText(o, live)}${o.market === 'options' ? ` (${money(perUnit(o))})` : ''}.` };
    }
    if (notional > o.sizingBankroll + 0.005) return { ...base, state: 'blocked', note: `Above the ${money(o.sizingBankroll)} bankroll this setup was sized from.` };
    const k = qty / o.positionSize;
    const scale = (v) => (v ? { ...v, gross: v.gross * k, fees: v.fees * k, net: v.net * k } : v);
    const c = o.costs;
    const order = {
      ...o, positionSize: qty, notional, dollarRisk: o.dollarRisk * k, actualRiskPct: (o.dollarRisk * k) / o.sizingBankroll, estimatedFees: o.estimatedFees * k,
      scenarios: Object.fromEntries(Object.entries(o.scenarios || {}).map(([name, v]) => [name, scale(v)])),
      costs: c ? { ...c, entry: c.entry * k, exitT1: Number.isFinite(c.exitT1) ? c.exitT1 * k : c.exitT1 } : c,
      capitalCapped: same && o.capitalCapped, smallAccountCap: same && o.smallAccountCap,
    };
    const above = qty > o.positionSize;
    return { order, amount: same ? null : dollars, raw, state: above ? 'above' : 'ok',
      note: above ? `Above the risk engine's max safe size (${money(o.notional)}): approval asks you to confirm.` : '' };
  }

  // The input + quick-select pills. onChange re-renders the view (the view keeps
  // this input focused across re-renders through its data-focus-key).
  function control(o, r, onChange) {
    const input = el('input', { className: 'input ta-input', type: 'text', value: r.raw, inputMode: 'decimal', autocomplete: 'off', spellcheck: false,
      dataset: { focusKey: `amount:${o.id}` } });
    input.setAttribute('aria-label', `Trade amount in dollars, ${o.asset}`);
    input.oninput = () => { drafts.set(o.id, input.value); onChange(); };
    const chosen = r.state === 'blocked' ? null : r.amount === null ? o.notional : r.amount;
    const pills = PILLS.map(([label, fn]) => {
      const v = fn ? fn(o) : null;
      const active = fn ? chosen !== null && Math.abs(chosen - v) < 0.005 : r.amount === null && r.state !== 'blocked';
      const b = el('button', { type: 'button', className: `ta-pill${active ? ' is-active' : ''}`, textContent: label,
        title: fn ? money(v) : `The risk engine's size: ${money(o.notional)}` });
      b.setAttribute('aria-pressed', String(active));
      b.onclick = () => { if (fn) drafts.set(o.id, v.toFixed(2)); else drafts.delete(o.id); onChange(); };
      return b;
    });
    const note = r.note || (r.amount === null ? `Risk engine size (max safe): ${money(o.notional)} · ${size(o)}`
      : `${size(r.order)} · risk engine max ${money(o.notional)}`);
    return el('div', { className: `ta${r.state === 'blocked' ? ' is-blocked' : r.state === 'above' ? ' is-above' : ''}` }, [
      el('label', { className: 'ta-row' }, [el('span', { className: 'ta-label', textContent: 'Trade Amount ($)' }),
        el('span', { className: 'input-wrap ta-wrap' }, [el('span', { className: 'input-prefix', textContent: '$' }), input])]),
      el('div', { className: 'ta-pills' }, pills),
      el('p', { className: 'ta-note', textContent: note }),
    ]);
  }

  // Forget amounts for setups that left the queue (approved, dismissed, expired).
  function prune(pending) {
    for (const id of drafts.keys()) if (!(pending || []).some((o) => o.id === id)) drafts.delete(id);
  }

  SD.tradeAmount = { resolve, control, prune };
})();
