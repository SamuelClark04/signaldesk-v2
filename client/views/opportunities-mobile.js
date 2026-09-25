// Opportunities on an iPhone (Phase 55, <= 768px): instead of a four-screen
// scroll (queue rail, chart, risk card, analysis), a sticky segmented switcher
//   [Queue & Radar] | [Chart] | [Order & Risk]
// shows one pane at a time. Tapping a setup jumps to Order & Risk, tapping a
// symbol / coin to Chart; a real setup gets a sticky bottom Approve / Track bar
// (the risk panel's own button, same gates: opportunity-detail.js actionBar).
// Desktop is untouched: every pane shows and the bar is not rendered.
// Panes are marked with data-pane on each section; mobile.css hides the others.
// Exposes window.SignalDesk.oppMobile.
(() => {
  const SD = window.SignalDesk;
  const { el } = SD.ui;

  const QUERY = window.matchMedia('(max-width: 768px)');
  const PANES = [['queue', 'Queue & Radar'], ['chart', 'Chart'], ['order', 'Order & Risk']];
  let current = 'queue';
  let hooked = false;

  const isMobile = () => QUERY.matches;
  const pane = () => current;
  function setPane(p) {
    if (!PANES.some(([k]) => k === p)) return;
    current = p;
    if (isMobile()) window.scrollTo({ top: 0 }); // a new pane starts at its top
  }
  // Marks a section with the pane it belongs to (null-safe).
  function tag(node, p) {
    if (node) node.dataset.pane = p;
    return node;
  }

  function switcher(rerender) {
    const group = el('div', { className: 'm-switch', role: 'tablist' }, PANES.map(([k, label]) => {
      const b = el('button', { type: 'button', className: `m-switch-btn${k === current ? ' is-active' : ''}`, textContent: label, role: 'tab' });
      b.setAttribute('aria-selected', String(k === current));
      b.onclick = () => { setPane(k); rerender(); };
      return b;
    }));
    return group;
  }

  // grid: the workspace (its sections tagged); bar: the Approve / Track actions or null.
  // Desktop: the grid alone. iPhone: switcher + grid (+ the sticky bar).
  function wrap(grid, { rerender, bar }) {
    if (!hooked) { // crossing the breakpoint (rotation, resize) re-renders once
      hooked = true;
      QUERY.addEventListener('change', () => rerender());
    }
    if (!isMobile()) return grid;
    grid.dataset.pane = current;
    return el('div', { className: 'm-opp' }, [switcher(rerender), grid,
      ...(bar && current !== 'queue' ? [el('div', { className: 'm-actionbar' }, bar)] : [])]);
  }

  SD.oppMobile = { isMobile, pane, setPane, tag, wrap, switcher, PANES };
})();
