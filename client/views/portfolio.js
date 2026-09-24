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
  };
})();
