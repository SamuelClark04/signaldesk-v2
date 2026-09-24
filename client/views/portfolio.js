// Portfolio tab: Active Positions (server snapshot) and the What to Buy allocator.
// The allocator only sends the deposit amount; all math happens on the server.
// Exposes window.SignalDesk.portfolio.
(() => {
  const SD = window.SignalDesk;
  const { $, el, td, price, money, size, clock, dirCell, assetCell, setTable } = SD.ui;

  let transport = { isOnline: () => false, send: () => {} }; // set by app.js via init()
  const pct = (x) => `${(x * 100).toFixed(1)}%`;

  function setStatus(text, isError = false) {
    $('alloc-status').textContent = text;
    $('alloc-status').classList.toggle('is-error', isError);
  }

  function requestAllocation(e) {
    e.preventDefault();
    const amount = Number($('alloc-amount').value);
    if (!Number.isFinite(amount) || amount <= 0) return setStatus('Enter a deposit amount above $0.', true);
    if (!transport.isOnline()) return setStatus('Offline: cannot reach the server.', true);
    $('alloc-submit').disabled = true;
    setStatus('Calculating…');
    transport.send({ type: 'CALCULATE_ALLOCATION', amount });
    // If the reply never comes (socket dropped), don't leave the button stuck.
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      $('alloc-submit').disabled = false;
      setStatus('No response from the server. Try again.', true);
    }, 10000);
  }

  let pendingTimer = null;

  function renderAllocation(proposal) {
    clearTimeout(pendingTimer);
    $('alloc-submit').disabled = false;
    if (!proposal || proposal.error) {
      $('alloc-result').hidden = true;
      return setStatus((proposal && proposal.error) || 'No proposal returned.', true);
    }
    setStatus('');

    const { deposit, portfolioValue, newTotal, unallocated, recommendations, notes } = proposal;
    $('alloc-summary').replaceChildren(
      'Holdings ', el('strong', { textContent: money(portfolioValue) }),
      ' + deposit ', el('strong', { textContent: money(deposit) }),
      ' → ', el('strong', { textContent: money(newTotal) }),
      unallocated > 0 ? ` · ${money(unallocated)} left unallocated` : '',
    );
    $('alloc-body').replaceChildren(...recommendations.map((r) => el('tr', {}, [
      el('td', {}, el('span', { className: 'asset', textContent: r.asset })),
      td(pct(r.currentWeight), 'num'),
      td(pct(r.targetWeight), 'num'),
      td(money(r.recommendedBuyAmount), `num ${r.recommendedBuyAmount > 0 ? 'text-long' : ''}`),
      td(r.estimatedUnits > 0 ? r.estimatedUnits.toFixed(r.estimatedUnits < 1 ? 6 : 4) : '—', 'num'),
    ])));
    $('alloc-notes').replaceChildren(...(notes || []).map((n) => el('li', { textContent: n })));
    $('alloc-result').hidden = false;
  }

  $('alloc-form').addEventListener('submit', requestAllocation);

  // ---------- Trading capital (BROKER_STATE from the server) ----------
  function capitalTile(v, bankroll) {
    const live = v.mode === 'live';
    const failed = live && !v.ok;
    const body = [];
    if (!live) {
      body.push(el('div', { className: 'capital-label', textContent: 'Paper bankroll' }),
        el('div', { className: 'capital-value', textContent: money(bankroll) }),
        el('div', { className: 'capital-sub', textContent: 'Simulated; approvals fill in the paper ledger' }));
    } else if (failed) {
      body.push(el('div', { className: 'capital-label', textContent: 'Live buying power' }),
        el('div', { className: 'capital-value', textContent: '—' }),
        el('div', { className: 'capital-error', textContent: `Account unavailable: ${v.error}` }));
    } else {
      const extra = v.balances ? `USD ${money(v.balances.USD)} + USDC ${money(v.balances.USDC)}`
        : `Cash ${money(v.cash)} · equity ${money(v.equity)}${v.tradingBlocked ? ' · TRADING BLOCKED' : ''}`;
      body.push(el('div', { className: 'capital-label', textContent: 'Live buying power' }),
        el('div', { className: 'capital-value', textContent: money(v.buyingPower) }),
        el('div', { className: 'capital-sub', textContent: `${extra} · as of ${clock(v.fetchedAt)}` }));
    }
    return el('div', { className: `capital-tile${live ? ' is-live' : ''}${failed ? ' is-error' : ''}` }, [
      el('div', { className: 'capital-head' }, [
        el('span', { className: 'capital-mode', textContent: live ? 'LIVE' : 'Paper' }),
        `${v.label} · ${v.markets}`,
      ]),
      ...body,
    ]);
  }

  function renderBrokerState(state) {
    if (!state || !state.venues) return;
    const venues = Object.values(state.venues);
    $('capital').replaceChildren(...venues.map((v) => capitalTile(v, state.bankroll)));
    // Be explicit about what the risk engine actually sizes from.
    $('capital-hint').textContent = venues.some((v) => v.mode === 'live')
      ? `Position sizing still uses the paper bankroll (${money(state.bankroll)}) for every venue`
      : 'Per execution venue';
  }

  function render(positions) {
    const rows = [...positions].sort((a, b) => b.openedAt - a.openedAt).map((p) => {
      const t1 = (p.targets || []).find((t) => t.level === 1) || (p.targets || [])[0];
      return el('tr', {}, [
        assetCell(p, `${p.market} · opened ${clock(p.openedAt)}`),
        dirCell(p),
        td(size(p), 'num'),
        td(price(p.fillPrice, p), 'num'),
        td(price(p.invalidation, p), 'num'),
        td(t1 ? price(t1.price, p) : '—', 'num'),
      ]);
    });
    setTable('positions', rows);
  }

  SD.portfolio = {
    init: (t) => { transport = t; },
    render,
    renderAllocation,
    renderBrokerState,
  };
})();
