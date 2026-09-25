// Chart symbol picker: a <select> in the Setups chart header listing the full
// monitored universe (UNIVERSE from the server: 42 crypto + 41 stocks), grouped
// by market, so any symbol can be charted, not only the ones heating up, plus
// every other tradable Coinbase spot coin (GEM_CATALOG, Phase 56, ~350 more).
// Picking one calls ctx.onPickSymbol(symbol): opportunities.js opens its queued
// setup if it has one, else Market Watch. While the user is working the picker
// the page holds its re-renders (a rebuild would snap the dropdown shut), but
// never for long: only while this window has focus, at most HOLD_MS after the
// last interaction, and a catch-up render is scheduled for when the hold ends.
// (Blur alone is not reliable: it does not fire when the window loses focus.)
// Exposes window.SignalDesk.symbolPicker.build(o, ctx).
(() => {
  const SD = window.SignalDesk;
  const { el } = SD.ui;
  const ID = 'opp-symbol-select';
  const HOLD_MS = 15000;
  let lastTouch = 0;
  let catchUp = null;

  // True while re-renders should wait; schedules `rerender` for when the hold expires.
  function holding(container, rerender) {
    const s = document.getElementById(ID);
    const left = HOLD_MS - (Date.now() - lastTouch);
    const hold = !!s && s === document.activeElement && container.contains(s) && document.hasFocus() && left > 0;
    if (hold && !catchUp) catchUp = setTimeout(() => { catchUp = null; rerender(); }, left + 50);
    return hold;
  }

  const label = (s) => `${s.includes('-') ? s.replace('-', '/') : s} · ${SD.scannerData.nameOf(s)}`;

  function build(o, ctx) {
    const u = ctx.state && ctx.state.universe;
    // Phase 59B: stocks past the 30-symbol stream get live REST prices every 60 s in the
    // session; after hours every stock is on its last close (no per-symbol label then).
    const polled = new Set((u && u.polledStocks) || []);
    const sc = ctx.state && ctx.state.scan;
    const open = !!(sc && sc.session && sc.session.open);
    const tag = (s) => (open && polled.has(s) ? ` (live · ${(u && u.pollSeconds) || 60} s poll)` : '');
    const inUniverse = new Set(u ? u.crypto : []);
    const gems = ((ctx.state && ctx.state.gemCatalog && ctx.state.gemCatalog.symbols) || []).filter((s) => !inUniverse.has(s));
    const groups = u ? [['Crypto', u.crypto], ['Stocks', u.stocks], ...(gems.length ? [['Coinbase spot', gems]] : [])] : [];
    const known = new Set(groups.flatMap(([, list]) => list));
    const select = el('select', { id: ID, className: 'opp-symbol-select', title: 'Chart any monitored symbol' }, [
      // A charted symbol outside the universe (e.g. an options underlying) stays selectable.
      ...(known.has(o.asset) ? [] : [el('option', { value: o.asset, textContent: label(o.asset) })]),
      ...groups.map(([name, list]) => el('optgroup', { label: `${name} (${list.length})` }, list.map((s) => el('option', {
        value: s, textContent: `${label(s)}${name === 'Stocks' ? tag(s) : ''}`,
      })))),
    ]);
    select.value = o.asset;
    select.setAttribute('aria-label', 'Chart symbol');
    select.onchange = () => {
      const symbol = select.value;
      lastTouch = 0; // release the render hold even if blur does not fire
      select.blur();
      ctx.onPickSymbol(symbol);
    };
    const touch = () => { lastTouch = Date.now(); };
    select.addEventListener('mousedown', touch);
    select.addEventListener('keydown', touch);
    select.addEventListener('focus', touch);
    select.onblur = () => { lastTouch = 0; if (ctx.onPickerClosed) ctx.onPickerClosed(); };
    return select;
  }

  SD.symbolPicker = { build, holding, ID };
})();
