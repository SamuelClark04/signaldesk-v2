// Portfolio → Holdings pieces: live P/L marks, the holdings table, exposure by
// asset, "Needs attention" and the holding details card.
// P/L uses the ledger's own maths: gross = (price − fill) × size (× −1 short);
// estimated exit fees use the position's fee model (sent by the server), exactly
// as the ledger books a close. Options have no live option prices, so no $ P/L.
// Exposes window.SignalDesk.portfolioTable.
(() => {
  const SD = window.SignalDesk;
  const { el, price, money, size, signed, pnlClass, clock } = SD.ui;
  const D = () => SD.scannerData;

  const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
  const display = (p) => (p.market === 'crypto' ? p.asset.replace('-', '/') : p.asset);
  const costBasis = (p) => (p.market === 'options' && p.optionsData
    ? p.positionSize * p.optionsData.debit * p.optionsData.multiplier : p.positionSize * p.fillPrice);

  // One position marked at a live price (null when there is no fresh price).
  // Broker holdings without a live price are marked at their value from the
  // last sync (priceSource 'sync'); their cost is Coinbase's own cost basis.
  function mark(p, livePrice) {
    if (p.execution === 'BROKER') return markBroker(p, livePrice);
    const cost = costBasis(p);
    const fm = p.feeModel || {};
    const exitFees = (x) => (fm.perContractRoundTrip ? fm.perContractRoundTrip * p.positionSize
      : fm.legRate ? fm.legRate * p.positionSize * (p.fillPrice + x) : null);
    if (!(livePrice > 0)) return { live: false, cost, marketValue: cost, gross: null, net: null, fees: null, pctGross: null };
    if (p.market === 'options') {
      return { live: true, price: livePrice, cost, marketValue: cost, gross: null, net: null, fees: exitFees(livePrice), pctGross: null,
        underlyingMove: livePrice / p.fillPrice - 1 };
    }
    const sign = p.direction === 'short' ? -1 : 1;
    const gross = (livePrice - p.fillPrice) * p.positionSize * sign;
    const fees = exitFees(livePrice);
    return { live: true, price: livePrice, cost, marketValue: cost + gross, gross, fees, net: fees === null ? null : gross - fees,
      pctGross: cost > 0 ? gross / cost : null, r: p.dollarRisk > 0 ? gross / p.dollarRisk : null };
  }

  function markBroker(p, livePrice) {
    const qty = p.positionSize;
    const syncPx = p.brokerValue > 0 && qty > 0 ? p.brokerValue / qty : null;
    const px = livePrice > 0 ? livePrice : syncPx;
    const cost = Number.isFinite(p.costBasis) && p.costBasis > 0 ? p.costBasis : p.fillPrice > 0 ? qty * p.fillPrice : null;
    const marketValue = px ? qty * px : 0;
    const gross = px && cost !== null ? marketValue - cost : null;
    const fees = px && p.feeModel && p.feeModel.legRate ? p.feeModel.legRate * qty * ((p.fillPrice || px) + px) : null;
    return { live: livePrice > 0, priceSource: livePrice > 0 ? 'live' : syncPx ? 'sync' : null, price: px, cost: cost === null ? marketValue : cost, marketValue,
      gross, fees, net: gross === null || fees === null ? null : gross - fees, pctGross: gross !== null && cost > 0 ? gross / cost : null, r: null, noBasis: cost === null };
  }

  // Which rows a venue filter shows. 'crypto' = the synced Coinbase account; until
  // a sync succeeds it falls back to the ledger's LIVE Coinbase positions. The
  // ledger's LIVE Coinbase trades are part of the synced balance, so they are
  // never added on top of it (they annotate the matching holding instead).
  const VENUE_KEYS = { paper: ['paper'], crypto: ['coinbase'], combined: ['paper', 'coinbase', 'alpaca-live'] };

  function ledgerVenue(p) {
    if (p.execution !== 'LIVE') return 'paper';
    return p.broker === 'Coinbase' ? 'coinbase-ledger' : 'alpaca-live';
  }

  // Rows + totals for the active venue. Paper KPIs use the configured bankroll;
  // Coinbase KPIs use the synced account (holdings + cash); Combined sums both.
  // LIVE Alpaca positions are listed under Combined but not synced, so excluded from KPIs.
  function metrics(state, venue = 'paper') {
    const alerts = new Map(((state.intelligence && state.intelligence.attention) || []).filter((a) => a.positionId).map((a) => [a.positionId, a]));
    const cb = state.holdings && state.holdings.coinbase;
    const synced = !!(cb && cb.ok);
    const ledger = (state.positions || []).map((p) => ({ p, key: ledgerVenue(p) }));
    const broker = synced ? cb.positions.map((p) => {
      const tracked = ledger.filter((x) => x.key === 'coinbase-ledger' && x.p.asset === p.asset).map((x) => x.p);
      const action = tracked.length ? 'SignalDesk bracket at Coinbase' : 'External holding';
      const detail = tracked.length ? `${tracked.length} SignalDesk trade(s) in this balance; their stop/target orders live at Coinbase`
        : 'Held at Coinbase; SignalDesk exit rules do not apply';
      return { p: { ...p, tracked }, key: 'coinbase', alert: { asset: p.asset, tone: 'info', action, detail } };
    }) : [];
    const keys = new Set(VENUE_KEYS[venue] || VENUE_KEYS.paper);
    if (!synced && keys.has('coinbase')) keys.add('coinbase-ledger'); // no snapshot yet: show what the ledger knows
    const rows = [...ledger, ...broker].filter((r) => keys.has(r.key))
      .sort((a, b) => (b.p.openedAt || 0) - (a.p.openedAt || 0))
      .map((r) => ({ ...r, m: mark(r.p, state.prices && state.prices[r.p.asset]), alert: r.alert || alerts.get(r.p.id) || null }));

    const paper = rows.filter((r) => r.key === 'paper');
    const cbRows = rows.filter((r) => r.key === 'coinbase');
    const counted = [...paper, ...cbRows];
    const usePaper = keys.has('paper');
    const useCb = keys.has('coinbase') && synced;
    const bankroll = usePaper ? (state.settings && state.settings.bankroll) || 0 : 0;
    const realized = usePaper ? (state.journal || []).filter((t) => t.execution !== 'LIVE').reduce((s, t) => s + (t.netPnl || 0), 0) : 0;
    const cbCash = useCb ? cb.cash || 0 : 0;
    const paperCost = paper.reduce((s, r) => s + r.m.cost, 0);
    const unrealized = counted.reduce((s, r) => s + (r.m.gross || 0), 0);
    const cbValue = cbRows.reduce((s, r) => s + r.m.marketValue, 0);
    const committed = counted.reduce((s, r) => s + (r.m.noBasis ? 0 : r.m.cost), 0); // no cost basis: not in the P/L % base
    const totals = {
      venue, bankroll, realized, committed, paperCost, unrealized, synced, usePaper, useCb, cbCash, syncedAt: cb && cb.syncedAt,
      holdingsValue: counted.reduce((s, r) => s + r.m.marketValue, 0),
      accountValue: (usePaper ? bankroll + realized + paper.reduce((s, r) => s + (r.m.gross || 0), 0) : 0) + (useCb ? cbValue + cbCash : 0),
      cash: (usePaper ? bankroll + realized - paperCost : 0) + cbCash,
      unrealizedPct: committed > 0 ? unrealized / committed : null,
      exitFees: counted.reduce((s, r) => s + (r.m.fees || 0), 0),
      fresh: rows.filter((r) => r.m.live).length,
      unmarked: counted.filter((r) => r.m.gross === null).length,
      live: rows.length - counted.length,
    };
    return { rows, totals };
  }

  // ---------- Holdings table ----------
  function pnlCell(m, p) {
    if (m.noBasis) return el('td', { className: 'num pf-muted', textContent: 'No cost basis', title: 'Coinbase reports no entry price for this balance (e.g. coins transferred in)' });
    if (!m.live && m.priceSource !== 'sync') return el('td', { className: 'num pf-muted', textContent: 'No live price' });
    if (m.gross === null) {
      return el('td', { className: 'num pf-muted', title: 'No live option prices: showing the underlying move since entry' },
        [el('span', { textContent: `Underlying ${pct(m.underlyingMove)}` })]);
    }
    return el('td', { className: `num ${pnlClass(m.gross)}`, title: m.net === null ? '' : `After est. exit fees ${signed(m.net, money)}` }, [
      el('span', { className: 'pf-pnl', textContent: signed(m.gross, money) }),
      el('span', { className: 'pf-pnl-pct', textContent: m.pctGross === null ? '' : pct(m.pctGross) }),
    ]);
  }

  // Venue badge in the Asset cell: green LIVE for broker money, grey PAPER for the ledger.
  function venueBadge(p) {
    const live = p.execution === 'LIVE' || p.execution === 'BROKER';
    return el('span', { className: `pf-venue${live ? ' is-live' : ''}`, textContent: live ? `LIVE · ${p.broker}` : 'PAPER',
      title: p.execution === 'BROKER' ? `Synced from ${p.broker}${p.tracked && p.tracked.length ? '; includes SignalDesk trades' : ''}` : p.execution === 'LIVE' ? `Opened live by SignalDesk at ${p.broker}` : 'SignalDesk paper ledger' });
  }

  // opts: { selectedId, onSelect(id), onClose(position, mark), closing:Set, online }
  function holdingsTable(data, opts) {
    const head = ['Asset', 'Direction', 'Size', 'Entry price', 'Stop loss', 'Target 1', 'Current price', 'Unrealized P/L', 'Next step', 'Action'];
    const numeric = new Set(['Size', 'Entry price', 'Stop loss', 'Target 1', 'Current price', 'Unrealized P/L']);
    const body = data.rows.map(({ p, m, alert }) => {
      const t1 = (p.targets || [])[0];
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
        el('td', { className: 'num text-short', textContent: price(p.invalidation, p) }),
        el('td', { className: 'num text-long', textContent: t1 ? price(t1.price, p) : '—' }),
        el('td', { className: 'num', title: m.priceSource === 'sync' ? `Value at the last Coinbase sync (${clock(p.syncedAt)}); no live price` : '' },
          [m.price ? price(m.price, p) : '—', ...(m.priceSource === 'sync' ? [el('span', { className: 'pf-pnl-pct pf-muted', textContent: 'at sync' })] : [])]),
        pnlCell(m, p),
        el('td', {}, alert ? el('span', { className: `pf-step is-${alert.tone}`, textContent: alert.action, title: alert.detail }) : el('span', { className: 'pf-muted', textContent: '—' })),
        el('td', { className: 'pf-action' }, close),
      ]);
      tr.onclick = () => opts.onSelect(p.id);
      return tr;
    });
    return el('section', { className: 'pf-card pf-holdings' }, [
      el('div', { className: 'pf-card-head' }, [el('h3', { className: 'pf-h', textContent: 'Holdings' }),
        el('span', { className: 'pf-sub', textContent: 'Open positions from the ledger · P/L marked on every live price update' })]),
      el('div', { className: 'table-wrap' }, el('table', { className: 'data-table pf-table' }, [
        el('thead', {}, el('tr', {}, head.map((h) => el('th', { textContent: h, className: numeric.has(h) ? 'num' : '' })))),
        el('tbody', {}, body.length ? body : [el('tr', {}, el('td', { colSpan: head.length, className: 'pf-empty', textContent: 'No open positions. Approved setups appear here once filled.' }))]),
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
    const items = data.rows.filter((r) => r.alert && r.alert.action !== 'Hold' && r.p.execution !== 'BROKER');
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
  function details(row, state) {
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
          ? `Synced from your ${p.broker} account. ${p.tracked && p.tracked.length ? `It includes ${p.tracked.length} trade(s) SignalDesk opened live, protected by stop/target orders at ${p.broker}.` : 'SignalDesk did not open it, so no SignalDesk stop or target applies.'} Close or change it at ${p.broker}.`
          : p.thesis || 'No thesis recorded.' })]),
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

  SD.portfolioTable = { mark, metrics, holdingsTable, exposure, attention, details, display, pct };
})();
