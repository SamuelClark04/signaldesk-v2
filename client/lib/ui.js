// Shared DOM + formatting helpers for every view. Loaded first; exposes
// window.SignalDesk.ui. No state lives here.
(() => {
  const SD = (window.SignalDesk = window.SignalDesk || {});

  const $ = (id) => document.getElementById(id);

  // ---------- Formatting ----------
  // Prices: thousands separators (83,900.00) with a fixed number of decimals per
  // market (2, or 4 for sub-$10 crypto). en-US pinned, like money() below.
  // Sub-cent coins (BONK, PEPE ~ $0.00001) get ~4 significant digits instead of 0.0000.
  // Phase 68: one rule for text and the chart's price scale (live-chart.js): >= $10: 2; $1-10:
  // 4; under $1: at least 4 significant digits (0.005240, 0.002116), 4-8 decimals (Coinbase
  // quotes down to 1e-8, so 0.00000912).
  const decimalsFor = (ref) => (!(ref > 0) ? 2 : !(ref < 1) ? (ref < 10 ? 4 : 2) : Math.min(8, Math.max(4, 3 - Math.floor(Math.log10(ref)))));
  const decimals = (o, x) => (o.market !== 'crypto' ? 2 : decimalsFor(o.entryPrice > 0 ? o.entryPrice : Math.abs(x)));
  const price = (x, o) => {
    if (!Number.isFinite(x)) return '—';
    const d = decimals(o || {}, x);
    return x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  // Dollar amounts: thousands separators, always 2 decimals. Locale is pinned to
  // en-US so "$" always pairs with "," grouping and "." decimals ($50,000.00),
  // whatever the browser's language. Negatives keep their sign: -$98.83.
  const USD = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  const money = (x) => (Number.isFinite(x)
    ? `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', USD)}`
    : '—');
  // Size with its unit: options trade in contracts, stocks in shares, crypto in coins.
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const size = (o) => (o.market === 'options' ? plural(o.positionSize, 'contract')
    : o.market === 'stocks' ? (Number.isInteger(o.positionSize) ? plural(o.positionSize, 'share') : `${o.positionSize.toFixed(4)} shares`) // fractional (Pilot)
      : `${o.positionSize.toFixed(6)} coins`);
  const signed = (x, fmt) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${fmt(Math.abs(x))}`;
  const pnlClass = (x) => (x > 0 ? 'pnl-pos' : x < 0 ? 'pnl-neg' : '');
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function age(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  }

  // Build elements with textContent only: headlines and theses are untrusted text.
  function el(tag, { dataset, ...props } = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    if (dataset) Object.assign(node.dataset, dataset);
    for (const c of [].concat(children)) node.append(c);
    return node;
  }
  const td = (text, className = '') => el('td', { textContent: text, className });

  // ---------- Shared cells ----------
  const dirCell = (o) => td(o.direction, `text-upper text-${o.direction === 'short' ? 'short' : 'long'}`);
  const assetCell = (o, subText) => el('td', {}, [el('span', { className: 'asset', textContent: o.asset }),
    el('span', { className: 'sub', textContent: subText })]);

  // Fill a panel's table body, count badge and empty state (ids: <name>-body/-count/-empty).
  function setTable(name, rows) {
    $(`${name}-body`).replaceChildren(...rows);
    $(`${name}-count`).textContent = rows.length;
    $(`${name}-empty`).hidden = rows.length > 0;
  }

  SD.ui = { $, el, td, price, decimalsFor, money, size, signed, pnlClass, clock, age, dirCell, assetCell, setTable };
})();
