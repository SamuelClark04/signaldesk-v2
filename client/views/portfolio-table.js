// Portfolio → Holdings pieces: the holdings table, exposure by asset, "Needs
// attention" and the holding details card. The money maths (marks, totals,
// capital breakdown) live in portfolio-metrics.js.
// Exposes window.SignalDesk.portfolioTable.
(() => {
  const SD = window.SignalDesk;
  const { el, price, money, size, signed, pnlClass, clock } = SD.ui;
  const D = () => SD.scannerData;

  // Money maths live in portfolio-metrics.js; re-exported below for older callers.
  const PM = () => SD.portfolioMetrics;
  const pct = (x) => PM().pct(x);
  const display = (p) => PM().display(p);
  // ---------- Holdings table ----------
  function pnlCell(m, p) {
    if (m.noBasis) return el('td', { className: 'num pf-muted', textContent: 'No cost basis', title: 'Coinbase reports no entry price for this balance (e.g. coins transferred in)' });
    if (!m.live && m.priceSource !== 'sync' && !(m.gross !== null && m.optionBasis)) return el('td', { className: 'num pf-muted', textContent: 'No live price' });
    if (m.gross === null) {
      if (!Number.isFinite(m.underlyingMove)) return el('td', { className: 'num pf-muted', textContent: 'No option price' });
      return el('td', { className: 'num pf-muted', title: 'No live option prices: showing the underlying move since entry' },
        [el('span', { textContent: `Underlying ${pct(m.underlyingMove)}` })]);
    }
    const basis = m.optionBasis ? `Option at ${m.optionValue.toFixed(2)} (${m.optionBasis === 'bid' ? 'live bid' : 'modelled'}). ` : '';
    return el('td', { className: `num ${pnlClass(m.gross)}`, title: `${basis}${m.net === null ? '' : `After est. exit fees ${signed(m.net, money)}`}` }, [
      el('span', { className: 'pf-pnl', textContent: signed(m.gross, money) }),
      el('span', { className: 'pf-pnl-pct', textContent: m.pctGross === null ? '' : pct(m.pctGross) }),
    ]);
  }

  // Venue badge in the Asset cell: green LIVE for broker money, amber MANUAL for
  // holdings at brokers SignalDesk cannot reach, grey PAPER for the ledger.
  function venueBadge(p) {
    if (p.external === 'manual') {
      return el('span', { className: 'pf-venue is-manual', textContent: `MANUAL · ${p.broker}`,
        title: `Entered by hand; held at ${p.broker}. SignalDesk tracks it and proposes actions; you trade at ${p.broker} and confirm in Approvals.` });
    }
    const live = p.execution === 'LIVE' || p.execution === 'BROKER';
    return el('span', { className: `pf-venue${live ? ' is-live' : ''}`, textContent: live ? `LIVE · ${p.broker}` : 'PAPER',
      title: p.execution === 'BROKER' ? `Synced from ${p.broker}${p.tracked && p.tracked.length ? '; includes SignalDesk trades' : ''}` : p.execution === 'LIVE' ? `Opened live by SignalDesk at ${p.broker}` : 'SignalDesk paper ledger' });
  }

  // opts: { selectedId, onSelect(id), onClose(position, mark), closing:Set, online }
  function holdingsTable(data, opts) {
    const head = ['Asset', 'Direction', 'Size', 'Entry price', 'Stop loss', 'Target 1', 'Current price', 'Unrealized P/L', 'Next step', 'Action'];
    const numeric = new Set(['Size', 'Entry price', 'Stop loss', 'Target 1', 'Current price', 'Unrealized P/L']);
    const A = SD.portfolioAdopt;
    const X = SD.externalForm;
    const body = data.rows.flatMap((row) => {
      const { p, m, alert } = row;
      // A synced holding with exactly one managed position shows that position's levels.
      const lv = p.execution === 'BROKER' && p.tracked && p.tracked.length === 1 ? p.tracked[0] : p;
      const t1 = (lv.targets || [])[0];
      const closing = opts.closing.has(p.id);
      const atBroker = p.execution === 'LIVE' || p.execution === 'BROKER';
      const canClose = !atBroker && m.live && opts.online && !closing;
      const close = el('button', { type: 'button', className: 'btn pf-close', textContent: closing ? 'Closing…' : 'Close', disabled: !canClose,
        title: atBroker ? 'Close at broker' : !m.live ? 'No live price: cannot close at a known price' : !opts.online ? 'Offline' : 'Close at the live price (paper)' });
      close.onclick = (e) => { e.stopPropagation(); opts.onClose(p, m); };
      const tr = el('tr', { className: `row${p.id === opts.selectedId ? ' is-selected' : ''}` }, [
        el('td', {}, el('div', { className: 'scan-asset' }, [SD.scannerDetail.badge(p.asset),
          el('div', {}, [el('strong', { textContent: display(p) }), el('span', {}, [`${D().nameOf(p.asset)} `,
            venueBadge(p)])])])),
        el('td', { className: `text-upper text-${p.direction === 'short' ? 'short' : 'long'} pf-dir`, textContent: p.direction }),
        el('td', { className: 'num', textContent: size(p) }),
        el('td', { className: 'num', textContent: price(p.fillPrice, p) }),
        el('td', { className: 'num text-short', textContent: price(lv.invalidation, p) }),
        el('td', { className: 'num text-long', textContent: t1 ? price(t1.price, p) : '—' }),
        el('td', { className: 'num', title: m.priceSource === 'sync' ? `Value at the last Coinbase sync (${clock(p.syncedAt)}); no live price` : '' },
          [m.price ? price(m.price, p) : '—', ...(m.priceSource === 'sync' ? [el('span', { className: 'pf-pnl-pct pf-muted', textContent: 'at sync' })] : [])]),
        pnlCell(m, p),
        el('td', {}, alert ? el('span', { className: `pf-step is-${alert.tone}`, textContent: alert.action, title: alert.detail }) : el('span', { className: 'pf-muted', textContent: '—' })),
        el('td', { className: 'pf-action' }, p.external === 'manual' ? X.rowActions(p, opts)
          : [...(A.canAdopt(row) ? [A.button(row, opts)] : [p.extId ? null : close]), ...(p.extId ? X.rowActions(p, opts) : [])].filter(Boolean)),
      ]);
      tr.onclick = () => opts.onSelect(p.id);
      if (X.isEditing(p)) return [tr, X.formRow(head.length, opts)];
      return A.isOpen(row) ? [tr, A.formRow(row, head.length, opts)] : [tr];
    });
    return el('section', { className: 'pf-card pf-holdings' }, [
      el('div', { className: 'pf-card-head' }, [el('h3', { className: 'pf-h', textContent: 'Holdings' }),
        el('span', { className: 'pf-sub', textContent: 'Ledger positions, synced broker balances and manual holdings · P/L marked on every live price update' })]),
      el('div', { className: 'table-wrap' }, el('table', { className: 'data-table pf-table' }, [
        el('thead', {}, el('tr', {}, head.map((h) => el('th', { textContent: h, className: numeric.has(h) ? 'num' : '' })))),
        el('tbody', {}, body.length ? body : [el('tr', {}, el('td', { colSpan: head.length, className: 'pf-empty', textContent: 'No open positions. Approved setups appear here once filled; add holdings from other brokers with "+ Add External Holding".' }))]),
      ])),
    ]);
  }

  // ---------- Exposure donut (paper + live, by current value) ----------
  function exposure(data) {
    const byAsset = new Map();
    for (const { p, m } of data.rows) byAsset.set(p.asset, (byAsset.get(p.asset) || 0) + Math.max(0, m.marketValue));
    const total = [...byAsset.values()].reduce((s, v) => s + v, 0);
    const parts = [...byAsset].sort((a, b) => b[1] - a[1]);
    let at = 0;
    const stops = parts.map(([a, v]) => { const from = at; at += (v / total) * 100; return `${D().colorOf(a)} ${from}% ${at}%`; });
    const donut = el('div', { className: 'pf-donut' }, el('div', { className: 'pf-donut-hole' }, [
      el('strong', { textContent: total > 0 ? money(total) : '—' }), el('span', { textContent: 'Holdings' })]));
    donut.style.background = total > 0 ? `conic-gradient(${stops.join(', ')})` : 'var(--surface-2)';
    const top = parts[0];
    return el('section', { className: 'pf-card' }, [
      el('div', { className: 'pf-card-head' }, [el('h3', { className: 'pf-h', textContent: 'Exposure by asset' })]),
      el('div', { className: 'pf-exposure' }, [donut, el('ul', { className: 'pf-legend' }, parts.map(([a, v]) => {
        const dot = el('span', { className: 'pf-dot' });
        dot.style.background = D().colorOf(a);
        return el('li', {}, [dot, el('span', { textContent: a.replace('-USD', '') }), el('span', { className: 'num', textContent: `${((v / total) * 100).toFixed(1)}%` }),
          el('span', { className: 'num pf-muted', textContent: money(v) })]);
      }))]),
      el('p', { className: 'pf-foot', textContent: top && total > 0 ? `Top holding: ${top[0].replace('-USD', '')} at ${((top[1] / total) * 100).toFixed(1)}% of holdings.` : 'No holdings yet.' }),
    ]);
  }

  // ---------- Needs attention (DASHBOARD_INTELLIGENCE alerts that are not "Hold") ----------
  function attention(data, opts) {
    // Synced holdings only appear here when a managed position inside them needs action.
    const items = data.rows.filter((r) => r.alert && r.alert.action !== 'Hold' && !(r.p.execution === 'BROKER' && r.alert.tone === 'info'));
    return el('section', { className: 'pf-card' }, [
      el('div', { className: 'pf-card-head' }, [el('h3', { className: 'pf-h', textContent: 'Needs attention' }), el('span', { className: 'pf-sub', textContent: `${items.length} item${items.length === 1 ? '' : 's'}` })]),
      el('ul', { className: 'pf-attn' }, items.length ? items.map(({ p, alert }) => {
        const b = el('button', { type: 'button', className: 'btn pf-attn-btn', textContent: 'Review' });
        b.onclick = () => opts.onSelect(p.id);
        return el('li', { className: `is-${alert.tone}` }, [el('span', { className: 'pf-attn-icon', textContent: '!' }),
          el('div', {}, [el('strong', { textContent: `${display(p)}: ${alert.action}` }), el('span', { textContent: alert.detail })]), b]);
      }) : [el('li', { className: 'pf-muted' }, 'Nothing needs attention right now.')]),
      el('button', { type: 'button', className: 'btn btn-solid pf-open-pilot', textContent: 'Open Portfolio Pilot', onclick: () => opts.onPilot() }),
    ]);
  }

  // ---------- Holding details (selected row) ----------
  function details(row, state, opts) {
    if (!row) return null;
    const { p, m } = row;
    const broker = p.execution === 'BROKER';
    const realized = (state.journal || []).filter((t) => t.asset === p.asset).reduce((s, t) => s + (t.netPnl || 0), 0);
    const kv = (k, v, cls = '') => el('div', { className: 'pf-kv' }, [el('span', { textContent: k }), el('span', { className: `num ${cls}`, textContent: v })]);
    const move = m.price && p.fillPrice > 0 ? m.price / p.fillPrice - 1 : null;
    return el('section', { className: 'pf-card pf-details' }, [
      el('div', { className: 'pf-card-head' }, [SD.scannerDetail.badge(p.asset), el('h3', { className: 'pf-h', textContent: `Holding details — ${display(p)} (${D().nameOf(p.asset)})` })]),
      el('div', { className: 'pf-details-grid' }, [
        el('div', {}, [
          el('div', { className: 'pf-bigprice' }, [el('strong', { textContent: m.price ? price(m.price, p) : '—' }),
            move === null ? el('span', { className: 'pf-muted', textContent: m.price ? 'No entry price' : 'No live price' })
              : el('span', { className: pnlClass(move * (p.direction === 'short' ? -1 : 1)), textContent: `${pct(move)} ${broker ? 'vs average entry' : 'since entry'}` })]),
          ...(broker ? [
            kv('Source', `${p.broker} account (synced ${clock(p.syncedAt)})`),
            kv('Average entry', p.fillPrice > 0 ? price(p.fillPrice, p) : '—'),
            kv('Price basis', m.priceSource === 'live' ? 'Live stream' : 'Value at last sync'),
          ] : [
            kv('Opened', `${new Date(p.openedAt).toLocaleDateString()} ${clock(p.openedAt)}`),
            kv('Venue', p.execution === 'LIVE' ? `LIVE · ${p.broker}` : 'Paper ledger'),
            kv('Strategy', `${p.strategyId || '—'} · ${p.setupType || 'Setup'} · ${p.timeframe || '—'}`),
          ]),
        ]),
        el('div', {}, [el('h4', { className: 'pf-h4', textContent: broker ? 'About this holding' : 'Investment thesis' }), el('p', { className: 'pf-text', textContent: broker
          ? `Synced from your ${p.broker} account: ${p.managedQty > 0 ? `${p.managedQty} managed by SignalDesk` : 'not managed by SignalDesk'}${p.freeQty > 0 ? `, ${p.freeQty} external` : ''}. `
            + `SignalDesk's own live trades have stop/target orders at ${p.broker}; adopted coins are watched with alerts only. Selling happens at ${p.broker}.`
          : p.thesis || 'No thesis recorded.' }),
        ...(broker ? [SD.portfolioAdopt.releaseList(row, opts)].filter(Boolean) : [])]),
        el('div', {}, [
          el('h4', { className: 'pf-h4', textContent: 'Position performance' }),
          kv('Cost basis', money(m.cost)),
          kv('Market value', m.gross === null ? '—' : money(m.marketValue)),
          kv('Unrealized (before est. exit cost)', m.gross === null ? '—' : signed(m.gross, money), m.gross === null ? '' : pnlClass(m.gross)),
          kv('Estimated exit cost', m.fees === null ? '—' : `−${money(m.fees)}`),
          kv('Unrealized (after est. cost)', m.net === null ? '—' : signed(m.net, money), m.net === null ? '' : pnlClass(m.net)),
          kv('R multiple (gross)', Number.isFinite(m.r) ? `${m.r >= 0 ? '+' : ''}${m.r.toFixed(2)}R` : '—'),
          ...(broker ? [] : [kv(`Realized P/L (${p.asset.replace('-USD', '')}, closed trades)`, signed(realized, money), pnlClass(realized))]),
        ]),
      ]),
    ]);
  }

  SD.portfolioTable = {
    holdingsTable, exposure, attention, details, display, pct,
    mark: (...a) => PM().mark(...a), metrics: (...a) => PM().metrics(...a), venueBankroll: (...a) => PM().venueBankroll(...a),
  };
})();
