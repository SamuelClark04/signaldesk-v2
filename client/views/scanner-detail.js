// Scanner detail panel (right column): the selected row's summary and gate
// checklist. Only checks SignalDesk really runs are listed (scanner-data.gates).
// Exposes window.SignalDesk.scannerDetail.panel(row, state, opts).
(() => {
  const SD = window.SignalDesk;
  const { el } = SD.ui;
  const D = () => SD.scannerData;

  // Round initials badge in the symbol's color (no logos).
  function badge(asset, big = false) {
    const b = el('span', { className: `scan-badge${big ? ' is-big' : ''}`, textContent: D().initials(asset) });
    b.style.setProperty('--badge', D().colorOf(asset));
    b.setAttribute('aria-hidden', 'true');
    return b;
  }

  function summary(row) {
    if (row.order) return row.order.thesis || 'No thesis provided.';
    if (row.rejection) {
      return row.state === 'dismissed'
        ? `You dismissed the ${row.setup} setup today.`
        : `A ${row.setup !== '—' ? row.setup : ''} setup from ${row.rejection.strategyId || 'a strategy'} was rejected by the risk engine: ${row.rejection.reason}.`;
    }
    return row.data.live
      ? 'Live price is streaming. No strategy has proposed a setup for this symbol yet; it is re-checked on every scan.'
      : 'No live price right now (market closed or feed quiet). The strategies only analyze symbols with a fresh price.';
  }

  const ICON = { pass: '✓', fail: '✕', wait: '…', info: 'i' };

  function checklist(row, state) {
    const list = D().gates(row, state);
    const passed = list.filter((g) => g.status === 'pass').length;
    const scored = list.filter((g) => g.status !== 'info').length;
    return [
      el('div', { className: 'scan-gates-head' }, [
        el('h3', { className: 'scan-h', textContent: 'Gate checklist' }),
        el('span', { className: 'scan-gates-n', textContent: `${passed} of ${scored} passed` }),
      ]),
      el('ul', { className: 'scan-gates' }, list.map((g) => el('li', { className: `scan-gate is-${g.status}` }, [
        el('span', { className: 'scan-gate-icon', textContent: ICON[g.status] }),
        el('span', { className: 'scan-gate-text' }, [el('strong', { textContent: g.name }), el('span', { textContent: g.sub })]),
        el('span', { className: 'scan-gate-value', textContent: g.value }),
      ]))),
    ];
  }

  // opts: { onReview(id), onWatch(symbol), onOptions() }
  function panel(row, state, opts) {
    if (!row) {
      return el('aside', { className: 'scan-detail' }, el('p', { className: 'opp-muted', textContent: 'Select a row to see its details.' }));
    }
    const primary = row.order
      ? el('button', { type: 'button', className: 'btn btn-primary scan-detail-go', textContent: 'Review setup' })
      : el('button', { type: 'button', className: 'btn scan-detail-go', textContent: 'Open chart' });
    primary.onclick = () => (row.order ? opts.onReview(row.order.id) : opts.onWatch(row.asset));
    const saved = row.order && opts.isSaved && opts.isSaved(row.order.id);
    const save = row.order && opts.onToggleSave
      ? el('button', { type: 'button', className: `btn scan-detail-go opp-bookmark${saved ? ' is-saved' : ''}`, textContent: saved ? '★ Saved' : '☆ Save for later', disabled: !opts.online })
      : null;
    if (save) save.onclick = () => opts.onToggleSave(row.order);
    const optionsLink = el('button', { type: 'button', className: 'scan-link', textContent: 'Show options setups ›' });
    optionsLink.onclick = () => opts.onOptions();

    return el('aside', { className: 'scan-detail' }, [
      el('header', { className: 'scan-detail-head' }, [
        badge(row.asset, true),
        el('div', { className: 'scan-detail-title' }, [
          el('strong', { textContent: row.display }),
          el('span', { textContent: `${row.name}${row.setup !== '—' && row.setup !== 'No setup yet' ? ` — ${row.setup}` : ''}` }),
        ]),
        el('span', { className: `scan-pill is-${row.state}` }, [
          el('span', { className: `scan-state is-${row.state}`, textContent: row.label }),
          el('small', { textContent: row.sub }),
        ]),
      ]),
      el('h3', { className: 'scan-h', textContent: 'Setup summary' }),
      el('p', { className: 'scan-summary', textContent: summary(row) }),
      ...checklist(row, state),
      primary,
      ...(save ? [save] : []),
      el('div', { className: 'scan-note' }, [
        el('span', { className: 'scan-note-icon', textContent: 'i' }),
        el('div', {}, [
          el('p', { textContent: 'Options setups are listed under the Options market.' }),
          optionsLink,
          el('p', { className: 'scan-note-fine', textContent: 'The scanner only reads market data. Orders are placed from Setups, and only after your approval.' }),
        ]),
      ]),
    ]);
  }

  SD.scannerDetail = { panel, badge };
})();
