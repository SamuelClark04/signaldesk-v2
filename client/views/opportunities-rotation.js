// Chart rotation for the Setups workspace (the command center), Phase 68 (out of
// opportunities.js). Every ROTATE_MS the chart moves to the next queued setup / Market Watch
// symbol (the rail's current list, in its order). Pause / Play in the toolbar (kept per
// browser). It never switches while the pointer is over the rail, the risk & execution
// panel or the trade HUD, while the symbol picker is open or a Trade Amount is being typed,
// or while the caller's ready() says no (another tab, an action in flight, ...); any click in
// the workspace restarts the countdown (reset()).
// Exposes window.SignalDesk.oppRotation.create({ ready, list, isCurrent, go, rerender }).
(() => {
  const SD = window.SignalDesk;
  const { el } = SD.ui;
  const ROTATE_MS = 12000;

  function create({ ready, list, isCurrent, go, rerender }) {
    const inUse = () => !!document.querySelector('.opp-rail:hover, .opp-right:hover, .trade-hud:hover')
      || !!(document.activeElement && (document.activeElement.id === 'opp-symbol-select' || document.activeElement.classList.contains('ta-input')));
    const cycler = SD.autoCycle({
      periodMs: ROTATE_MS, key: 'signaldesk.chartRotation',
      canRun: () => ready() && list().length > 1 && !inUse(),
      advance: () => {
        const items = list();
        const i = items.findIndex(isCurrent);
        go(items[(i + 1) % items.length]);
      },
    });
    function button() {
      const on = cycler.playing();
      const b = el('button', { type: 'button', className: `btn opp-rotate${on ? ' is-on' : ''}`, textContent: on ? '⏸ Pause rotation' : '▶ Play rotation',
        title: on ? `Auto-rotating the chart every ${ROTATE_MS / 1000}s through the queue and Market Watch` : 'Chart rotation paused' });
      b.setAttribute('aria-pressed', String(on));
      b.onclick = () => { cycler.setPlaying(!on); rerender(); };
      return b;
    }
    return { reset: cycler.reset, button };
  }

  SD.oppRotation = { create, ROTATE_MS };
})();
