// [⬍ Dual Chart] (Phase 61): splits the Opportunities chart area into two stacked
// live charts. Top: the primary chart (whatever Opportunities is showing). Bottom: a
// second, independent pane (its own timeframe pills, follow switch, live ticks and
// ENTRY / SL / T1 / T2 overlays for a held position or a staged setup on it), with a
// compact symbol picker and [✕ Close Split]. It defaults to the second active
// position (another symbol than the top chart), else the first, else BTC-USD.
// Shift + click on a position / symbol in the left rail sends it to the bottom chart
// without touching the top one (opportunities-rail.js). Remembered per device.
// Phase 64: Chart 2 is a full trading surface: its own floating ACTIVE TRADE HUD (own
// placement, minimize and [Lines] switch; the close button acts on Chart 2's position),
// [+ Manual Trade SYM] in its header, and its own Open Position / Setup card in the right
// column under Chart 1's (side()); [✕ Close Split] removes both.
// Exposes window.SignalDesk.dualChart: { isOn, toggle, toggleButton, setSecondary, wrap, side, symbol }.
(() => {
  const SD = window.SignalDesk;
  const { el } = SD.ui;
  const KEY = 'signaldesk.dualChart';

  let on = (() => { try { return localStorage.getItem(KEY) === 'on'; } catch { return false; } })();
  let secondary = null; // the bottom chart's symbol (null: the default)
  let pane = null; // the second chart instance (live-chart.js makeChart)
  let hud = null; // its ACTIVE TRADE HUD (trade-hud.js create)
  const buttons = new Set();
  let select = null;
  let selectKey = '';

  const save = () => { try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* this session only */ } };
  const paint = () => { for (const b of buttons) { b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', String(on)); } };

  function toggle(force) {
    on = typeof force === 'boolean' ? force : !on;
    save();
    paint();
    SD.app.refresh();
  }
  function toggleButton() {
    const b = el('button', { type: 'button', className: 'lwc-tool lwc-dual', textContent: '⬍ Dual Chart', title: 'Stack a second live chart under this one (Shift + click a rail position to load it there)' });
    b.onclick = () => toggle();
    buttons.add(b);
    paint();
    return b;
  }
  function setSecondary(symbol) {
    secondary = symbol;
    if (!on) toggle(true); else SD.app.refresh();
  }

  // Held symbols as the rail lists them: newest position first.
  const heldOf = (state) => [...new Set(((state && state.positions) || []).slice().sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0)).map((p) => p.asset))];

  // The bottom chart's symbol: the user's pick, else the next held symbol after the top one.
  function symbolFor(state, top) {
    if (secondary) return secondary;
    const held = heldOf(state);
    return held.filter((a) => a !== top)[0] || (held[1] || held[0]) || (top === 'BTC-USD' ? 'ETH-USD' : 'BTC-USD');
  }

  // Everything pickable: held symbols first, then the monitored universe.
  function choices(state, current) {
    const held = heldOf(state);
    const u = (state && state.universe) || {};
    const rest = [...(u.crypto || []), ...(u.stocks || [])].filter((s) => !held.includes(s));
    const list = [...held, ...rest];
    return list.includes(current) ? list : [current, ...list];
  }

  const marketOf = (state, symbol) => { const p = ((state && state.positions) || []).find((x) => x.asset === symbol); return symbol.includes('-') ? 'crypto' : p ? p.market : 'stocks'; };
  // Chart 2's own context: its symbol's live price (the HUD / card marks), everything else as Chart 1's.
  const ctxFor = (ctx, state, symbol) => ({ ...ctx, livePrice: state && state.prices ? state.prices[symbol] : null, refPrice: state && state.refPrices ? state.refPrices[symbol] : null });

  function bottom(state, top, ctx) {
    const symbol = symbolFor(state, top);
    if (!pane) pane = SD.liveChart.create({ tf: '15m', levelsKey: 'signaldesk.chartLevels.2' });
    if (!hud) hud = SD.tradeHud.create({ id: 'chart2', storageKey: 'signaldesk.tradeHud.2', pane: () => pane, title: 'Chart 2 · active trade' });
    const order = ((state && state.pending) || []).find((o) => o.asset === symbol);
    const position = ((state && state.positions) || []).find((p) => p.asset === symbol);
    const market = marketOf(state, symbol);
    const host = pane.mount(order || { isWatch: true, asset: symbol, market, setupType: 'Chart 2', timeframe: pane.timeframe() },
      { withLevels: !!order, overlay: order ? null : position || null, banner: '' });
    // The select survives re-renders (a rebuild on every tick would snap it shut while open).
    const held = new Set(((state && state.positions) || []).map((p) => p.asset));
    const list = choices(state, symbol);
    const key = `${list.join(',')}|${[...held].join(',')}`;
    if (!select || selectKey !== key) {
      select = el('select', { className: 'dual-select', id: 'dual-chart-symbol', title: 'Bottom chart symbol' },
        list.map((s) => el('option', { value: s, textContent: `${s.replace('-', '/')}${held.has(s) ? ' · open' : ''}` })));
      select.onchange = () => setSecondary(select.value);
      selectKey = key;
    }
    if (document.activeElement !== select) select.value = symbol;
    const close = el('button', { type: 'button', className: 'btn dual-close', textContent: '✕ Close Split', title: 'Back to one chart' });
    close.onclick = () => toggle(false);
    const trade = ctx ? hud.hud({ asset: symbol, market }, ctxFor(ctx, state, symbol)) : null; // Chart 2's own ACTIVE TRADE HUD
    const barH = pane.barHeight();
    return el('div', { className: 'dual-bottom' }, [
      el('div', { className: 'dual-head' }, [el('span', { className: 'dual-label', textContent: 'Chart 2' }), select,
        el('span', { className: 'dual-hint', textContent: position ? `${position.direction.toUpperCase()} position · levels shown` : order ? 'Staged setup · levels shown' : 'Shift + click a rail position to load it here' }),
        SD.manualTicket.button(symbol, `+ Manual Trade ${symbol.replace('-', '/')}`), close]),
      host ? el('div', { className: 'opp-chart-wrap dual-chart2', style: barH ? `--lwc-bar-h:${barH}px` : '' }, [host, ...(trade ? [trade] : [])])
        : el('p', { className: 'opp-muted', textContent: 'Chart library unavailable (offline).' }),
    ]);
  }

  // Right column (Phase 64): Chart 1's card, then Chart 2's own Open Position / Setup card (not
  // when both charts show the same symbol). Labelled only while split. -> [nodes]
  function side(primaryCard, state, top, ctx) {
    if (!on) return [primaryCard];
    const symbol = symbolFor(state, top);
    if (symbol === top) return [primaryCard];
    const c2 = ctxFor(ctx, state, symbol);
    const o = { asset: symbol, market: marketOf(state, symbol) };
    const order = ((state && state.pending) || []).find((x) => x.asset === symbol);
    const card = SD.positionDetail.panel(o, c2) || SD.oppDetail.right(order || { isWatch: true, ...o, setupType: 'Market Watch', timeframe: '1h' }, c2);
    const tag = (text, node) => el('section', { className: 'dual-side' }, [el('div', { className: 'dual-side-label', textContent: text }), node]);
    return [tag(`Chart 1 · ${top.replace('-', '/')}`, primaryCard), tag(`Chart 2 · ${symbol.replace('-', '/')}`, card)];
  }

  // primaryHost: the top chart's node. Returns it alone, or both stacked. ctx: Chart 1's (Chart 2's HUD derives its own).
  function wrap(primaryHost, state, topSymbol, ctx) {
    if (!on || !primaryHost) return primaryHost;
    return el('div', { className: 'dual-charts' }, [el('div', { className: 'dual-top' }, [primaryHost]), bottom(state, topSymbol, ctx)]);
  }

  SD.dualChart = { isOn: () => on, toggle, toggleButton, setSecondary, wrap, side, symbol: (state, top) => (on ? symbolFor(state, top) : null), secondary: () => secondary };
})();
