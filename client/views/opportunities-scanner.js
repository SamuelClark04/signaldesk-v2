// Opportunities → Scanner: header + Run scan, filter bar, funnel, results table
// (paged) with a detail panel, and scan diagnostics. Data comes from
// scanner-data.js (real server state only); the right panel from scanner-detail.js.
// Exposes window.SignalDesk.oppScanner.renderScanner(container, state, options).
(() => {
  const SD = window.SignalDesk;
  const { el } = SD.ui;
  const D = () => SD.scannerData;

  const PAGE_SIZE = 8;
  const MARKETS = [['all', 'All'], ['stocks', 'Stocks'], ['crypto', 'Crypto'], ['options', 'Options']];
  const DIRECTIONS = [['both', 'Both'], ['long', 'Long'], ['short', 'Short']];
  const SORT_OPTIONS = [['quality', 'Quality'], ['rr', 'Net R/R'], ['age', 'Data age'], ['asset', 'Asset']];

  // View state (survives re-renders on every price tick).
  const f = { direction: 'both', excludedTf: new Set(), setup: 'all', minRR: '', sort: 'quality' };
  let page = 0;
  let selectedKey = null;

  const field = (label, control) => el('label', { className: 'scan-field' }, [el('span', { className: 'scan-field-label', textContent: label }), control]);

  function select(options, value, onChange) {
    const s = el('select', { className: 'scan-select' }, options.map(([v, label]) => el('option', { value: v, textContent: label })));
    s.value = value;
    s.onchange = () => onChange(s.value);
    return s;
  }

  // ---------- Header ----------
  function header(state, opts) {
    const scan = state.scan || {};
    const busy = scan.running || !opts.online;
    const run = el('button', { type: 'button', className: 'btn scan-run', disabled: busy, textContent: scan.running ? 'Scanning…' : 'Run scan' });
    run.onclick = () => opts.onRunScan();
    const when = scan.finishedAt ? new Date(scan.finishedAt) : null;
    const status = scan.running ? 'Scanning now'
      : when ? `Complete · ${(scan.durationMs / 1000).toFixed(1)} s${scan.trigger === 'manual' ? ' (manual)' : ''}` : 'Waiting for the first scan';
    const sub = when ? `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · auto every ${Math.round((scan.intervalMs || 60000) / 1000)} s` : '';
    return el('div', { className: 'scan-header' }, [
      el('div', {}, [el('h2', { className: 'scan-title', textContent: 'Market scanner' }),
        el('p', { className: 'scan-subtitle', textContent: 'Qualified setups across stocks and crypto, from the live strategies.' })]),
      el('div', { className: 'scan-run-wrap' }, [
        run,
        el('div', { className: `scan-run-status${scan.running ? ' is-running' : ''}`, textContent: scan.notice || status }),
        ...(sub ? [el('div', { className: 'scan-run-sub', textContent: sub })] : []),
      ]),
    ]);
  }

  // ---------- Filters ----------
  function filters(rows, opts) {
    const timeframes = [...new Set(rows.map((r) => r.timeframe).filter(Boolean))].sort();
    const setups = [...new Set(rows.map((r) => r.setup).filter((s) => s && s !== '—' && s !== 'No setup yet'))].sort();
    const set = (key) => (v) => { f[key] = v; page = 0; opts.rerender(); };
    const tfBoxes = el('div', { className: 'scan-tfs' }, timeframes.length ? timeframes.map((tf) => {
      const box = el('input', { type: 'checkbox', checked: !f.excludedTf.has(tf) });
      box.onchange = () => { if (box.checked) f.excludedTf.delete(tf); else f.excludedTf.add(tf); page = 0; opts.rerender(); };
      return el('label', { className: 'scan-tf' }, [box, tf]);
    }) : [el('span', { className: 'opp-muted', textContent: 'None yet' })]);
    const minRR = el('input', { type: 'number', className: 'scan-input', min: '0', step: '0.1', placeholder: 'Any', value: f.minRR });
    minRR.onchange = () => set('minRR')(minRR.value);
    return el('div', { className: 'scan-filters' }, [
      field('Market', select(MARKETS, opts.market, (v) => { page = 0; opts.onMarket(v); })),
      field('Direction', select(DIRECTIONS, f.direction, set('direction'))),
      field('Timeframe', tfBoxes),
      field('Setup', select([['all', 'All'], ...setups.map((s) => [s, s])], setups.includes(f.setup) ? f.setup : 'all', set('setup'))),
      field('Minimum net R/R', minRR),
      field('Sort by', select(SORT_OPTIONS, f.sort, set('sort'))),
    ]);
  }

  // ---------- Funnel ----------
  function funnel(state, symbols, root) {
    const stages = D().funnel(state, symbols);
    const max = Math.max(1, symbols.length);
    const skipped = symbols.filter((s) => !D().isLive(state, s)).length + ((state.rejections && state.rejections.latest) || []).length;
    const reasons = el('button', { type: 'button', className: 'scan-link', textContent: 'View reasons ›' });
    reasons.onclick = () => { const x = root.querySelector('.scan-excluded'); if (x) x.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    return el('div', { className: 'scan-funnel' }, [
      ...stages.map((s) => {
        const bar = el('div', { className: 'scan-stage-bar' }, el('span', {}));
        bar.firstChild.style.width = `${Math.max(s.n ? 6 : 0, (s.n / max) * 100)}%`;
        return el('div', { className: `scan-stage${s.last ? ' is-last' : ''}`, title: s.hint }, [
          el('div', { className: 'scan-stage-text' }, [el('strong', { textContent: String(s.n) }), el('span', { textContent: s.label })]),
          bar,
        ]);
      }),
      el('div', { className: 'scan-skipped' }, [el('span', {}, [el('strong', { textContent: String(skipped) }), ' not live / rejected']), reasons]),
    ]);
  }

  // ---------- Table ----------
  function actionButton(row, opts) {
    const [label, cls] = { review: ['Review', 'btn btn-solid'], reason: ['View reason', 'btn'], watch: ['Watch', 'btn'] }[row.action];
    const b = el('button', { type: 'button', className: `${cls} scan-btn`, textContent: label });
    b.onclick = (e) => {
      e.stopPropagation();
      if (row.action === 'review') opts.onReview(row.order.id);
      else if (row.action === 'watch') opts.onWatch(row.asset);
      else { selectedKey = row.key; opts.rerender(); } // the reason is in the detail panel
    };
    return b;
  }

  function tableRow(r, opts) {
    const tr = el('tr', { className: `row${r.key === selectedKey ? ' is-selected' : ''}` }, [
      el('td', {}, el('div', { className: 'scan-asset' }, [SD.scannerDetail.badge(r.asset),
        el('div', {}, [el('strong', { textContent: r.display }), el('span', { textContent: r.name })])])),
      el('td', { textContent: { stocks: 'Stocks', crypto: 'Crypto', options: 'Options' }[r.market] || r.market }),
      el('td', { textContent: r.setup }),
      el('td', {}, r.side ? el('span', { className: `text-upper text-${r.side === 'short' ? 'short' : 'long'} scan-side`, textContent: r.side }) : '—'),
      el('td', { textContent: r.timeframe || '—' }),
      el('td', {}, el('div', { className: 'scan-statecell' }, [el('span', { className: `scan-state is-${r.state}`, textContent: r.label }), el('small', { textContent: r.sub })])),
      el('td', { className: 'num', textContent: r.rr === null ? '—' : r.rr.toFixed(2) }),
      el('td', { className: `num${r.data.live ? '' : ' scan-stale'}`, textContent: r.data.text, title: r.data.title }),
      el('td', { className: 'scan-action' }, actionButton(r, opts)),
    ]);
    tr.onclick = () => { selectedKey = r.key; opts.rerender(); };
    return tr;
  }

  function results(rows, total, opts) {
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    const shown = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const th = (label, cls = '') => el('th', { textContent: label, className: cls });
    const assetTh = el('th', { className: 'scan-sortable', textContent: `Asset ${f.sort === 'asset' ? '↑' : '↕'}`, title: 'Sort by asset' });
    assetTh.onclick = () => { f.sort = f.sort === 'asset' ? 'quality' : 'asset'; opts.rerender(); };
    const pager = el('div', { className: 'scan-pages' }, [
      ['‹', page - 1], ...Array.from({ length: pages }, (_, i) => [String(i + 1), i]), ['›', page + 1],
    ].map(([label, target]) => {
      const b = el('button', { type: 'button', className: `scan-page${target === page && label !== '‹' && label !== '›' ? ' is-active' : ''}`, textContent: label,
        disabled: target < 0 || target >= pages });
      b.onclick = () => { page = target; opts.rerender(); };
      return b;
    }));
    return el('section', { className: 'scan-results' }, [
      el('div', { className: 'table-wrap' }, el('table', { className: 'data-table scan-table' }, [
        el('thead', {}, el('tr', {}, [assetTh, th('Market'), th('Setup'), th('Side'), th('Timeframe'), th('State'), th('Net R/R', 'num'), th('Data age', 'num'), th('Action', 'scan-action')])),
        el('tbody', {}, shown.length ? shown.map((r) => tableRow(r, opts))
          : [el('tr', {}, el('td', { colSpan: 9, className: 'opp-muted', textContent: 'No rows match these filters.' }))]),
      ])),
      el('div', { className: 'scan-foot-row' }, [
        el('span', { className: 'opp-muted', textContent: rows.length ? `Showing ${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + shown.length} of ${rows.length}${rows.length < total ? ` (${total} before filters)` : ''}` : `0 of ${total}` }),
        pager,
      ]),
    ]);
  }

  // ---------- Diagnostics ----------
  function coverage(state, symbols) {
    const row = (label, list) => {
      const live = list.filter((s) => D().isLive(state, s)).length;
      const pct = list.length ? Math.round((live / list.length) * 100) : 0;
      const bar = el('div', { className: 'scan-cov-bar' }, el('span', {}));
      bar.firstChild.style.width = `${pct}%`;
      return el('div', { className: 'scan-cov' }, [el('span', { textContent: label }), bar,
        el('span', { className: 'scan-cov-n', textContent: `${live} / ${list.length}` }), el('span', { className: 'scan-cov-pct', textContent: `${pct}%` })]);
    };
    return el('section', { className: 'scan-panel' }, [
      el('h3', { className: 'scan-h', textContent: 'Scan coverage' }),
      el('p', { className: 'scan-panel-sub', textContent: 'Symbols with a live price this scan' }),
      row('Stocks', symbols.filter((s) => D().marketOf(s) === 'stocks')),
      row('Crypto', symbols.filter((s) => D().marketOf(s) === 'crypto')),
    ]);
  }

  function excluded(state, symbols) {
    const items = [['No live quote', symbols.filter((s) => !D().isLive(state, s)).length],
      ...((state.rejections && state.rejections.reasons) || []).map((r) => [r.reason, r.count])];
    return el('section', { className: 'scan-panel scan-excluded' }, [
      el('h3', { className: 'scan-h', textContent: 'Excluded today' }),
      el('p', { className: 'scan-panel-sub', textContent: items.length > 1 ? 'Symbols without a live quote, and setups rejected today' : 'Symbols without a live quote. No setups rejected yet today.' }),
      el('dl', { className: 'scan-excl' }, items.flatMap(([label, n]) => [el('dt', { textContent: label }), el('dd', { textContent: String(n) })])),
    ]);
  }

  // options: { market, onMarket(v), matchesAsset(market), onReview(id), onWatch(symbol), onRunScan(), online, rerender() }
  function renderScanner(container, state, options) {
    const opts = { market: 'all', onMarket() {}, matchesAsset: () => true, onReview() {}, onWatch() {}, onRunScan() {}, online: true, rerender() {}, ...options };
    const symbols = D().universe(state);
    const all = D().buildRows(state);
    const present = new Set(all.map((r) => r.timeframe).filter(Boolean));
    const allowed = f.excludedTf.size ? new Set([...present].filter((tf) => !f.excludedTf.has(tf))) : new Set();
    const rows = D().filterRows(all, { ...f, timeframes: allowed, minRR: Number(f.minRR), matchesAsset: opts.matchesAsset });
    if (!rows.some((r) => r.key === selectedKey)) selectedKey = rows.length ? rows[0].key : null;
    const root = el('div', { className: 'scan' });
    root.append(
      header(state, opts),
      filters(all, opts),
      funnel(state, symbols, root),
      el('div', { className: 'scan-grid' }, [
        el('div', { className: 'scan-main' }, [results(rows, all.length, opts),
          el('div', { className: 'scan-diag' }, [coverage(state, symbols), excluded(state, symbols)])]),
        SD.scannerDetail.panel(rows.find((r) => r.key === selectedKey), state, { ...opts, onOptions: () => { page = 0; opts.onMarket('options'); } }),
      ]),
    );
    container.replaceChildren(root);
  }

  SD.oppScanner = { renderScanner };
})();
