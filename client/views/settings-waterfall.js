// Settings: "Crypto Waterfall Routing & Broker Status" (Phase 70). The three crypto venues in
// route order, from BROKER_STATE.cryptoWaterfall (server: crypto-waterfall.js):
//   Priority #1 OKX US · #2 Kraken Pro · #3 Coinbase Advanced, each with its status badge
//   (CONNECTED / NOT CONFIGURED / UNAVAILABLE), the cash one order can spend (+ OKX funding
//   cash, which must be moved to Trading first), its fees and break-even, and its role;
// and the venue a standard $20 ETH trade would take right now (listing + live cash).
// Exposes window.SignalDesk.settingsWaterfall: { render(brokerState) }.
(() => {
  const SD = window.SignalDesk;
  const { $, el, money } = SD.ui;
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z]+/g, '-');

  const feeText = (r) => `${pct(r.maker)} Maker / ${pct(r.taker)} Taker · ~${pct(r.bePct)} BE`;
  const hhmm = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  // Phase 92: where the rates come from: "Verified from your account Oct 4, 18:07 (OKX US account Lv1 ...)", or UNVERIFIED + why.
  function feeSource(r) {
    const f = r.fee || {};
    const failed = f.lookupOk === false && f.lookupError ? ` · last lookup failed${f.lookupAt ? ` ${hhmm(f.lookupAt)}` : ''}: ${f.lookupError}` : '';
    if (f.verified) return { text: `Fees verified from your account ${hhmm(f.at)} (${f.source})${failed}`, warn: !!failed };
    return { text: `Fees UNVERIFIED: ${f.source || 'default'}${failed || ' · not read yet'}`, warn: true };
  }
  function cashText(r) {
    if (r.status === 'NOT CONFIGURED') return r.id === 'coinbase' ? 'No Coinbase API key in .env' : 'Add its API keys to .env to enable it';
    if (r.status !== 'CONNECTED') return `Balance unavailable: ${r.error || 'no answer'}`;
    return `${money(r.cash)} spendable${r.fundingCash > 0 ? ` · ${money(r.fundingCash)} in Funding (move to Trading to use)` : ''}`;
  }
  // "Active $20 route today: Coinbase ($91.65 cash) — fund OKX US or Kraken Pro to auto-switch to lower fees"
  function activeText(w) {
    const a = w.active || {};
    const row = w.rows.find((r) => r.id === a.venue);
    const cheaper = w.rows.filter((r) => row && r.rank < row.rank && r.status === 'CONNECTED').map((r) => r.label);
    return `Active $${a.notional || 20} route today: ${a.label || '—'}${row && row.cash !== null ? ` (${money(row.cash)} cash)` : ''}`
      + `${cheaper.length ? ` — fund ${cheaper.join(' or ')} to auto-switch to lower fees` : ''}`;
  }

  function row(r, activeId) {
    return el('li', { className: `wf-row is-${slug(r.status)}${r.id === activeId ? ' is-active' : ''}` }, [
      el('div', { className: 'wf-head' }, [
        el('span', { className: 'wf-rank', textContent: `Priority #${r.rank}` }), el('strong', { className: 'wf-name', textContent: r.label }),
        el('span', { className: `wf-badge is-${slug(r.status)}`, textContent: r.status }),
        ...(r.id === activeId ? [el('span', { className: 'wf-badge is-route', textContent: 'ACTIVE ROUTE' })] : [])]),
      el('span', { className: 'wf-cash', textContent: cashText(r) }),
      el('span', { className: 'wf-fees', textContent: feeText(r) }),
      (() => { const s = feeSource(r); return el('span', { className: `wf-fee-src${s.warn ? ' is-unverified' : ''}`, textContent: s.text }); })(),
      el('span', { className: 'wf-role', textContent: r.role }),
    ]);
  }

  function render(broker) {
    const box = $('settings-waterfall');
    if (!box) return;
    const w = broker && broker.cryptoWaterfall;
    const head = el('div', { className: 'wf-title' }, [el('h3', { className: 'pf-h', textContent: 'Crypto Waterfall Routing & Broker Status' }),
      el('span', { className: 'panel-hint', textContent: 'Each crypto order goes to the first venue that lists the coin and has the cash' })]);
    if (!w || !Array.isArray(w.rows) || !w.rows.length) {
      box.replaceChildren(head, el('p', { className: 'settings-status', textContent: w && w.error ? `Status unavailable: ${w.error}` : 'Waiting for the server…' }));
      return;
    }
    const activeId = w.active && w.active.venue;
    box.replaceChildren(head, el('p', { className: 'wf-active', textContent: activeText(w) }), el('ol', { className: 'wf-rows' }, w.rows.map((r) => row(r, activeId))));
  }

  SD.settingsWaterfall = { render };
})();
