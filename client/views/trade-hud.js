// Active Trade HUD: a floating panel over the Setups chart (top right) when the
// charted symbol has open position(s). Live unrealized P&L re-marks on every
// price update, with the same maths as the Portfolio tab (portfolio-metrics.mark).
// Manual exit: PAPER positions close at the live price via CLOSE_POSITION (the
// server re-checks and books it like any exit). LIVE and adopted positions are
// closed at the broker: their exits are broker orders (or the user's own sale),
// so the button is disabled there, exactly as on the Portfolio tab.
// Real option contracts lead with the contract itself: its live premium (the
// real bid, or the modelled value when no fresh quote exists) and the option's
// own P&L; the underlying's price follows for context.
// Placement: drag it by its title bar anywhere inside the chart (double-click the
// title bar to put it back top-right); "–" minimizes it to a small pill with the
// symbol and P&L (click the pill to expand; the pill drags too). Position and
// minimized state are kept per browser (localStorage) and survive the re-renders
// every price tick causes, including in the middle of a drag.
// Exposes window.SignalDesk.tradeHud: { hud(o, ctx) (Chart 1), create(opts) (another chart's own HUD, Phase 64) }.
(() => {
  const SD = window.SignalDesk;
  const { el, money, price, size, signed, pnlClass } = SD.ui;

  // 'QQQ 761C · 30 Oct' from the position's real contract.
  function contractName(p) {
    const od = p.optionsData;
    const exp = new Date(`${od.expiration}T12:00:00Z`).toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return `${od.underlying || p.asset} ${od.strike}${od.shortStrike ? `/${od.shortStrike}` : ''}${od.type === 'put' ? 'P' : 'C'} · ${exp}`;
  }

  // Premium + P&L block for a real option contract (m from portfolioMetrics.mark).
  function optionBlock(p, m) {
    const od = p.optionsData;
    const n = p.positionSize;
    const head = el('div', { className: 'hud-contract' }, [el('strong', { textContent: contractName(p) }),
      el('span', { className: 'hud-muted', textContent: `${n} contract${n === 1 ? '' : 's'}` })]);
    head.title = od.contract;
    if (m.optionValue === undefined) {
      return [head, el('div', { className: 'hud-pnl hud-muted', textContent: 'No option price (no fresh quote or live underlying)' })];
    }
    const basis = m.optionBasis === 'bid' ? 'live bid' : m.optionBasis === 'mid' ? 'live net mid' : 'modelled';
    const when = m.optionAt ? new Date(m.optionAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const premium = el('div', { className: 'hud-premium' }, [
      el('span', { className: 'hud-muted', textContent: 'Premium ' }),
      el('strong', { textContent: m.optionValue.toFixed(2) }),
      el('span', { className: `hud-basis is-${m.optionBasis}`, textContent: basis }),
      el('span', { className: 'hud-muted', textContent: ` paid ${od.debit}` }),
    ]);
    premium.title = m.optionBasis === 'mid' ? 'Net mid of both legs\' live quotes (closing fills 0.15 x their combined bid/ask under it)' : m.optionBasis === 'bid' ? `Real bid (${od.feed || 'indicative'} feed) at ${when}` : 'No fresh quote: Black-Scholes value at the live underlying price, anchored to the entry quote';
    return [head, premium, SD.netPnl.hero(p, m, { compact: true, noBreakEven: true })]; // Phase 63: net first
  }

  function underlyingLine(p, m) {
    if (!(m.price > 0)) return el('div', { className: 'hud-muted', textContent: 'Underlying: no live price' });
    const mv = m.underlyingMove;
    return el('div', { className: 'hud-muted hud-underlying', textContent: `Underlying: ${price(m.price, { market: 'stocks', entryPrice: m.price })}`
      + `${Number.isFinite(mv) ? ` (${mv >= 0 ? '+' : '−'}${Math.abs(mv * 100).toFixed(2)}% since entry at ${price(p.fillPrice, { market: 'stocks', entryPrice: p.fillPrice })})` : ''}` });
  }

  function row(p, livePrice, ctx) {
    const m = SD.portfolioMetrics.mark(p, livePrice);
    const realOption = p.market === 'options' && p.optionsData && p.optionsData.contract;
    const venue = p.adopted ? 'ADOPTED' : p.execution === 'LIVE' ? `LIVE · ${p.broker}` : 'PAPER';
    const t1 = p.targets && p.targets[0] && p.targets[0].price;
    // Phase 63: the true net is the hero (gross + friction under it, then the break-even).
    const pnl = m.gross !== null && m.gross !== undefined ? SD.netPnl.hero(p, m, { compact: true })
      : el('div', { className: 'hud-pnl hud-muted', textContent: !m.live ? 'No live price' : m.underlyingMove !== undefined
        ? `Underlying ${m.underlyingMove >= 0 ? '+' : '−'}${Math.abs(m.underlyingMove * 100).toFixed(2)}%` : '—' });

    const atBroker = p.execution === 'LIVE' || p.execution === 'BROKER';
    const closing = ctx.closing.has(p.id);
    const exit = el('button', {
      type: 'button',
      className: `btn hud-exit${atBroker ? '' : ' is-armed'}`,
      textContent: atBroker ? `Close at ${p.broker}` : closing ? 'Closing…' : SD.positionDetail.closeText(p), // net if closed now (exit quote)
      disabled: atBroker || closing || !m.live || !ctx.online,
      title: atBroker ? (p.adopted ? 'Adopted holding: sell it at the broker (SignalDesk places no orders for it)' : 'LIVE position: its exits are orders at the broker; close it there')
        : !m.live ? 'No live price: cannot close at a known price' : !ctx.online ? 'Offline' : 'Close this paper position now at the live price',
    });
    exit.onclick = () => ctx.onClosePosition(p, m);
    const exitBtn = SD.liveClose.can(p) ? SD.liveClose.button(p, m, ctx) : exit; // [Close at Coinbase] (Phase 60)
    return el('div', { className: 'hud-pos' }, [
      el('div', { className: 'hud-line' }, [el('span', { className: `hud-venue${p.execution === 'LIVE' ? ' is-live' : ''}`, textContent: venue }),
        el('span', { textContent: realOption ? `${p.optionsData.structure === 'vertical' ? (p.optionsData.type === 'put' ? 'BEAR PUT SPREAD' : 'BULL CALL SPREAD') : `LONG ${p.optionsData.type === 'put' ? 'PUT' : 'CALL'}`}` : `${p.direction.toUpperCase()} ${size(p)} @ ${price(p.fillPrice, p)}` })]),
      ...(realOption ? [...optionBlock(p, m), underlyingLine(p, m)] : [pnl]),
      ...(p.market === 'options' && !realOption ? [el('div', { className: 'hud-muted', textContent: 'Simulated spread from the old options strategy: '
        + 'no listed contract, so no live premium. Close it to retire it.' })] : []),
      el('div', { className: 'hud-levels' }, [el('span', { className: 'text-short', textContent: `${realOption ? `${p.asset} stop` : 'Stop'} ${price(p.invalidation, p)}` }),
        el('span', { className: 'text-long', textContent: `T1 ${t1 ? price(t1, p) : '—'}` })]),
      exitBtn,
    ]);
  }

  // ---------- One HUD instance per chart (Phase 64: Chart 1 and the Dual Chart's Chart 2) ----------
  // Each keeps its own placement, minimized state and [Lines] switch (its pane's, live-chart.js).
  // opts: { id, storageKey, pane: () => the chart pane, title }
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  function createHud({ id = 'main', storageKey = 'signaldesk.tradeHud', pane = () => SD.liveChart.primary, title = 'Active trade' } = {}) {
    // ---------- Placement: drag + minimize (kept across re-renders) ----------
    const view = (() => { try { return { collapsed: false, pos: null, ...JSON.parse(localStorage.getItem(storageKey) || '{}') }; } catch { return { collapsed: false, pos: null }; } })();
    const saveView = () => { try { localStorage.setItem(storageKey, JSON.stringify(view)); } catch { /* storage blocked: this session only */ } };

    // Applies the saved position, kept inside the chart wrap (null = CSS default, top-right).
    function place(node) {
      if (!view.pos) { node.style.left = ''; node.style.top = ''; node.style.right = ''; return; }
      const wrap = node.parentElement;
      const maxX = wrap ? Math.max(0, wrap.clientWidth - node.offsetWidth) : view.pos.left;
      const maxY = wrap ? Math.max(0, wrap.clientHeight - node.offsetHeight) : view.pos.top;
      node.style.right = 'auto';
      node.style.left = `${clamp(view.pos.left, 0, maxX)}px`;
      node.style.top = `${clamp(view.pos.top, 0, maxY)}px`;
    }

    // Pointer drag from a handle. The HUD element is re-found on every move: a price
    // tick may have replaced it mid-drag. A press that never moves is a click (onClick).
    function startDrag(e, onClick) {
      if (e.button !== 0 || e.target.closest('button:not(.hud-pill)')) return;
      const node = e.currentTarget.closest('.trade-hud');
      if (!node || getComputedStyle(node).position === 'static') { if (onClick) onClick(); return; } // phone layout: no dragging
      const start = { x: e.clientX, y: e.clientY, left: node.offsetLeft, top: node.offsetTop };
      let moved = false;
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
        moved = true;
        ev.preventDefault();
        view.pos = { left: start.left + ev.clientX - start.x, top: start.top + ev.clientY - start.y };
        const cur = document.querySelector(`.trade-hud[data-hud="${id}"]`);
        if (cur) { place(cur); view.pos = { left: cur.offsetLeft, top: cur.offsetTop }; } // keep what is shown (clamped)
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.classList.remove('hud-dragging');
        if (moved) saveView(); else if (onClick) onClick();
      };
      document.body.classList.add('hud-dragging');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      e.preventDefault();
    }

    const redraw = (node, o, ctx) => { const next = hud(o, ctx); if (next) node.replaceWith(next); };

    // Minimized: "UNI/USD +$0.11" (option positions: the option's own P&L).
    function pill(o, positions, ctx) {
      const marks = positions.map((p) => SD.portfolioMetrics.mark(p, ctx.livePrice));
      // Phase 63: the minimized pill sums the TRUE net (gross only where no net is known).
      const nets = positions.map((p, i) => SD.netPnl.figures(p, marks[i])).filter(Boolean);
      const known = nets.map((f) => (f.net ?? f.gross)).filter(Number.isFinite);
      const total = known.reduce((s, x) => s + x, 0);
      const label = SD.oppDetail.displaySymbol(o);
      const p0 = positions[0];
      const t1 = p0.targets && p0.targets[0] && p0.targets[0].price;
      const ul = { market: 'stocks', entryPrice: p0.invalidation };
      const b = el('button', { type: 'button', className: `hud-pill ${known.length ? pnlClass(total) : 'hud-muted'}`, title: 'Show the trade panel (drag to move)' }, [
        el('span', { className: 'hud-pill-sym', textContent: `${label}${positions.length > 1 ? ` ×${positions.length}` : ''}` }),
        el('strong', { textContent: known.length ? `${signed(total, money)} net` : '—' }),
        // Phase 58C: the (underlying) stop and T1 beside the P&L.
        el('span', { className: 'hud-pill-lv text-short', textContent: `SL ${price(p0.invalidation, p0.market === 'options' ? ul : p0)}` }),
        el('span', { className: 'hud-pill-lv text-long', textContent: `T1 ${t1 ? price(t1, p0.market === 'options' ? ul : p0) : '—'}` }),
      ]);
      b.setAttribute('aria-label', `Active trade ${label}: expand`);
      return b;
    }

    // ctx: { state, livePrice, online, closing:Set, onClosePosition(p, m) }
    function hud(o, ctx) {
      const positions = ((ctx.state && ctx.state.positions) || []).filter((p) => p.asset === o.asset);
      if (!positions.length) return null;
      let node;
      if (view.collapsed) {
        const b = pill(o, positions, ctx);
        node = el('aside', { className: 'trade-hud is-collapsed', ariaLabel: `${title} (minimized)`, dataset: { hud: id } }, [b]);
        const expand = () => { view.collapsed = false; saveView(); redraw(node, o, ctx); };
        b.addEventListener('pointerdown', (e) => startDrag(e, expand));
        b.addEventListener('click', (e) => { if (e.detail === 0) expand(); }); // keyboard (Enter/Space); pointer clicks go through startDrag
      } else {
        const min = el('button', { type: 'button', className: 'hud-min', textContent: '–', title: 'Minimize' });
        min.setAttribute('aria-label', 'Minimize the trade panel');
        min.onclick = () => { view.collapsed = true; saveView(); redraw(node, o, ctx); };
        // Level lines on the chart (ENTRY / SL / T1 / T2 / BE): on or off.
        const pn = pane();
        const on = pn ? pn.levelsVisible() : true;
        const lines = el('button', { type: 'button', className: `hud-min hud-lines${on ? ' is-on' : ''}`, textContent: on ? 'Lines ✓' : 'Lines', title: 'Show / hide the entry, stop, target and breakeven lines on the chart' });
        lines.onclick = () => { if (pn) pn.setLevelsVisible(!on); redraw(node, o, ctx); }; // this chart's lines only
        const bar = el('div', { className: 'hud-title', title: 'Drag to move · double-click to reset' }, [
          el('span', { textContent: `${title}${positions.length > 1 ? ` (${positions.length})` : ''}` }), lines, min]);
        bar.addEventListener('pointerdown', (e) => startDrag(e));
        bar.addEventListener('dblclick', () => { view.pos = null; saveView(); place(node); });
        node = el('aside', { className: 'trade-hud', ariaLabel: title, dataset: { hud: id } }, [bar, ...positions.map((p) => row(p, ctx.livePrice, ctx))]);
      }
      // Position once it is in the chart wrap (its size is known then).
      requestAnimationFrame(() => { if (node.isConnected) place(node); });
      if (view.pos) { node.style.right = 'auto'; node.style.left = `${Math.max(0, view.pos.left)}px`; node.style.top = `${Math.max(0, view.pos.top)}px`; }
      return node;
    }
    return { hud };
  }

  const main = createHud();
  SD.tradeHud = { hud: main.hud, create: createHud };
})();
