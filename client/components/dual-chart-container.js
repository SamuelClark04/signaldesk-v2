// [⬍ Dual Chart] (Phase 61): splits the Opportunities chart area into two stacked
// live charts. Top: the primary chart (whatever Opportunities is showing). Bottom: a
// second, independent pane (its own timeframe pills, follow switch, live ticks and
// ENTRY / SL / T1 / T2 overlays for a held position or a staged setup on it), with a
// compact symbol picker and [✕ Close Split]. It defaults to the second active
// position (another symbol than the top chart), else the first, else BTC-USD.
// Shift + click on a position / symbol in the left rail sends it to the bottom chart
// without touching the top one (opportunities-rail.js). Remembered per device.
// Exposes window.SignalDesk.dualChart: { isOn, toggle, toggleButton, setSecondary, wrap }.
(() => {
  const SD = window.SignalDesk;
  const { el } = SD.ui;
  const KEY = 'signaldesk.dualChart';

  let on = (() => { try { return localStorage.getItem(KEY) === 'on'; } catch { return false; } })();
  let secondary = null; // the bottom chart's symbol (null: the default)
  let pane = null; // the second chart instance (live-chart.js makeChart)
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

  function bottom(state, top) {
    const symbol = symbolFor(state, top);
    if (!pane) pane = SD.liveChart.create({ tf: '15m' });
    const order = ((state && state.pending) || []).find((o) => o.asset === symbol);
    const position = ((state && state.positions) || []).find((p) => p.asset === symbol);
    const market = symbol.includes('-') ? 'crypto' : position ? position.market : 'stocks';
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
    return el('div', { className: 'dual-bottom' }, [
      el('div', { className: 'dual-head' }, [el('span', { className: 'dual-label', textContent: 'Chart 2' }), select,
        el('span', { className: 'dual-hint', textContent: position ? `${position.direction.toUpperCase()} position · levels shown` : order ? 'Staged setup · levels shown' : 'Shift + click a rail position to load it here' }), close]),
      host || el('p', { className: 'opp-muted', textContent: 'Chart library unavailable (offline).' }),
    ]);
  }

  // primaryHost: the top chart's node. Returns it alone, or both stacked.
  function wrap(primaryHost, state, topSymbol) {
    if (!on || !primaryHost) return primaryHost;
    return el('div', { className: 'dual-charts' }, [el('div', { className: 'dual-top' }, [primaryHost]), bottom(state, topSymbol)]);
  }

  SD.dualChart = { isOn: () => on, toggle, toggleButton, setSecondary, wrap, secondary: () => secondary };
})();
