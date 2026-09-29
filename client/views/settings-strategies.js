// Settings > Risk Management > Strategies (Phase 78, server/strategies/strategy-toggles.js): an On / Off switch per
// scanner strategy. Off = never scanned, no new setups; open trades and setups already in Approvals are unaffected.
// Each switch saves at once (UPDATE_SETTINGS with the full map, through settings.js). A strategy that is off by
// default shows why, and a strategy with a replay result shows it (settings.strategyNotes, on or off). Exposes window.SignalDesk.strategySettings.
(() => {
  const SD = window.SignalDesk;
  const { $, el } = SD.ui;
  let saved = null;

  function render(settings) {
    if (settings) saved = settings;
    const box = $('settings-strategies');
    if (!saved || !saved.strategiesEnabled) { box.replaceChildren(el('span', { className: 'settings-status', textContent: 'Waiting for the server…' })); return; }
    const map = saved.strategiesEnabled;
    const labels = saved.strategyLabels || {};
    const notes = saved.strategyNotes || {};
    box.replaceChildren(...Object.keys(labels).map((id) => {
      const on = map[id] !== false;
      const t = el('button', { type: 'button', className: `settings-toggle${on ? ' is-on' : ''}`, textContent: on ? 'On' : 'Off',
        title: on ? 'Scanning: new setups can be proposed' : 'Off: not scanned, no new setups (open trades keep their stops / targets)' });
      t.setAttribute('role', 'switch');
      t.setAttribute('aria-checked', String(on));
      t.setAttribute('aria-label', labels[id]);
      t.onclick = () => SD.settings.request({ strategiesEnabled: { ...map, [id]: !on } });
      return el('div', { className: `settings-strategy${on ? '' : ' is-off'}` }, [t, el('div', {}, [el('strong', { textContent: labels[id] }),
        ...(notes[id] ? [el('span', { className: 'settings-note', textContent: notes[id] })] : [])])]);
    }));
  }

  SD.strategySettings = { render };
})();
