// Opportunities → Saved: bookmarked setups (ledger savedSetups, via SAVED_SETUPS).
// A bookmark is the server's snapshot of a setup at the time it was saved. If the
// setup is still in the approvals queue, "Review in Setups" opens the live,
// executable version; otherwise the snapshot is read-only (levels vs the live
// price, thesis, criteria): nothing can be executed from here.
// Exposes window.SignalDesk.oppSaved.render(state, opts).
(() => {
  const SD = window.SignalDesk;
  const { el, price, money, size, age } = SD.ui;

  let selectedId = null;
  const EMPTY = 'No saved setups. Bookmark a setup from the Scanner or Queue to review it later.';
  const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(2)}%`;
  const display = (o) => (o.market === 'crypto' ? o.asset.replace('-', '/') : o.asset);

  function card(o, inQueue, active, opts) {
    const btn = el('button', { type: 'button', className: `opp-card${active ? ' is-active' : ''}` }, [
      SD.scannerDetail.badge(o.asset),
      el('div', { className: 'opp-card-body' }, [
        el('span', { className: 'asset', textContent: display(o) }),
        el('span', { className: 'opp-card-meta', textContent: `${o.direction === 'short' ? 'Short' : 'Long'} — ${o.setupType || 'Setup'}` }),
        el('span', { className: 'opp-card-sub' }, [`${String(o.timeframe || '—').toUpperCase()} `,
          el('span', { className: `scan-state ${inQueue ? 'is-ready' : 'is-waiting'}`, textContent: inQueue ? 'In queue' : 'No longer queued' }),
          ` · saved ${age(o.savedAt)} ago`]),
      ]),
      el('span', { className: 'opp-card-chev', textContent: '›' }),
    ]);
    btn.onclick = () => { selectedId = o.id; opts.rerender(); };
    return btn;
  }

  function detail(o, inQueue, state, opts) {
    const live = state.prices && state.prices[o.asset];
    const t = o.targets || [];
    const kv = (k, v, cls = '') => el('div', { className: 'opp-kv' }, [el('span', { className: 'opp-k', textContent: k }), el('span', { className: `opp-v ${cls}`, textContent: v })]);
    const vsLive = (lvl) => (live > 0 && lvl > 0 ? ` (${pct(lvl / live - 1)} from live)` : '');
    const review = el('button', { type: 'button', className: 'btn btn-solid', textContent: 'Review in Setups', disabled: !inQueue,
      title: inQueue ? 'Open the live setup in the Setups workspace' : 'This setup left the queue (expired, approved or dismissed)' });
    review.onclick = () => opts.onReview(o.id);
    const chart = el('button', { type: 'button', className: 'btn', textContent: 'Open chart' });
    chart.onclick = () => opts.onWatch(o.asset);
    const remove = el('button', { type: 'button', className: 'btn', textContent: 'Remove bookmark', disabled: !opts.online });
    remove.onclick = () => opts.send({ type: 'UNSAVE_SETUP', id: o.id });
    return el('aside', { className: 'opp-right saved-detail' }, [
      el('header', { className: 'opp-right-head' }, [SD.scannerDetail.badge(o.asset, true),
        el('div', { className: 'opp-title' }, [el('strong', { className: 'opp-right-symbol', textContent: display(o) }),
          el('span', { className: 'opp-name', textContent: `${SD.scannerData.nameOf(o.asset)} · ${o.direction === 'short' ? 'Short' : 'Long'} — ${o.setupType || 'Setup'}` })]),
        el('span', { className: `opp-pill${inQueue ? ' is-ready' : ''}`, textContent: inQueue ? 'In queue' : 'Snapshot' })]),
      el('p', { className: 'opp-right-summary', textContent: inQueue ? 'Still in the approvals queue: review it in Setups to approve or dismiss.'
        : `Saved ${new Date(o.savedAt).toLocaleString()}. It has left the queue, so this is a read-only snapshot of the setup as it was.` }),
      el('div', { className: 'opp-kv-group' }, [
        kv('Live price', live > 0 ? price(live, o) : '—'),
        kv('Entry range', `${price(o.entryZone.min, o)} – ${price(o.entryZone.max, o)}${vsLive(o.entryZone.max)}`),
        kv('Invalidation (stop)', `${price(o.invalidation, o)}${vsLive(o.invalidation)}`, 'text-short'),
        kv('Take profit 1 (T1)', t[0] ? `${price(t[0].price, o)}${vsLive(t[0].price)}` : '—', 'text-long'),
        ...(t[1] ? [kv('Take profit 2 (T2)', `${price(t[1].price, o)}${vsLive(t[1].price)}`, 'text-long')] : []),
      ]),
      el('div', { className: 'opp-kv-group' }, [
        kv('Size when saved', size(o)),
        kv('Risk when saved', o.dollarRisk > 0 ? money(o.dollarRisk) : '—'),
        kv('Strategy', `${o.strategyId || '—'} · ${o.timeframe || '—'}`),
        kv('Staged', o.stagedAt ? new Date(o.stagedAt).toLocaleString() : '—'),
      ]),
      el('h3', { className: 'opp-section', textContent: 'Thesis' }),
      el('p', { className: 'opp-right-summary', textContent: o.thesis || 'No thesis recorded.' }),
      ...((o.confirmationCriteria || []).length ? [el('ul', { className: 'opp-criteria' }, o.confirmationCriteria.map((c) => el('li', { textContent: c })))] : []),
      el('div', { className: 'opp-actions' }, [review, el('div', { className: 'opp-actions-row' }, [chart, remove])]),
    ]);
  }

  // opts: { onReview(id), onWatch(symbol), send(msg), online, rerender() }
  function render(state, opts) {
    const saved = state.saved || [];
    if (!saved.length) return el('div', { className: 'placeholder saved-empty', textContent: EMPTY });
    const pending = new Set((state.pending || []).map((o) => o.id));
    if (!saved.some((o) => o.id === selectedId)) selectedId = saved[0].id;
    const active = saved.find((o) => o.id === selectedId);
    return el('div', { className: 'saved-grid' }, [
      el('section', { className: 'opp-rail' }, [
        el('div', { className: 'opp-rail-head' }, [el('h3', { className: 'opp-section', textContent: 'Saved setups' }),
          el('span', { className: 'count', textContent: String(saved.length) })]),
        el('div', { className: 'opp-queue saved-list' }, saved.map((o) => card(o, pending.has(o.id), o.id === selectedId, opts))),
      ]),
      detail(active, pending.has(active.id), state, opts),
    ]);
  }

  SD.oppSaved = { render };
})();
