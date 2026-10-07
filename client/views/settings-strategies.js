// Settings > Risk Management > Strategies (Phase 78, server/strategies/strategy-toggles.js): an On / Off switch per
// scanner strategy. Off = never scanned, no new setups; open trades and setups already in Approvals are unaffected.
// Each switch saves at once (UPDATE_SETTINGS with the full map, through settings.js). A strategy that is off by
// default shows why, and a strategy with a replay result shows it (settings.strategyNotes, on or off). Exposes window.SignalDesk.strategySettings.
(() => {
  const SD = window.SignalDesk;
  const { $, el } = SD.ui;
  let saved = null;
  let recorder = null; let recorderAt = 0; // Phase 93: the decision recorder's status (GET /api/version, at most every 30 s)

  function render(settings) {
    if (settings) saved = settings;
    const box = $('settings-strategies');
    if (!saved || !saved.strategiesEnabled) { box.replaceChildren(el('span', { className: 'settings-status', textContent: 'Waiting for the server…' })); return; }
    const map = saved.strategiesEnabled;
    const labels = saved.strategyLabels || {};
    const notes = saved.strategyNotes || {};
    const manual = new Set(saved.strategyManualOnly || []); // Phase 91: crypto scanners never run
    const records = saved.strategyEvidence || {};
    box.replaceChildren(...Object.keys(labels).map((id) => {
      const locked = manual.has(id);
      const on = !locked && map[id] !== false;
      const t = el('button', { type: 'button', className: `settings-toggle${on ? ' is-on' : ''}${locked ? ' is-locked' : ''}`, textContent: locked ? 'Manual-only' : on ? 'On' : 'Off', disabled: locked,
        title: locked ? 'Crypto is manual-only: charts + the Manual Trade Ticket (crypto research is a separate project)' : on ? 'Scanning: setups wait in Approvals for your click (paper only)' : 'Off: not scanned, no new setups (open trades keep their stops / targets)' });
      t.setAttribute('role', 'switch');
      t.setAttribute('aria-checked', String(on));
      t.setAttribute('aria-label', labels[id]);
      if (!locked) t.onclick = () => SD.settings.request({ strategiesEnabled: { ...map, [id]: !on } });
      return el('div', { className: `settings-strategy${on ? '' : ' is-off'}` }, [t, el('div', {}, [el('strong', { textContent: labels[id] }),
        ...[SD.evidenceBadge.badge(records[id])].filter(Boolean),
        ...(notes[id] ? [el('span', { className: 'settings-note', textContent: notes[id] })] : [])])]);
    }), recorderLine());
    if (Date.now() - recorderAt > 30000) {
      recorderAt = Date.now();
      fetch('/api/version', { credentials: 'same-origin', cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((v) => { recorder = v && v.decisionRecorder; render(); }).catch(() => {});
    }
  }

  // "Decision recorder: 214 today · 0 dropped · last write 14:05" (amber: drops, write / serialization errors, or decisions without their inputs).
  function recorderLine() {
    const r = recorder;
    if (!r) return el('p', { className: 'settings-recorder', textContent: 'Decision recorder: status not loaded yet' });
    if (r.error || r.enabled === false) return el('p', { className: 'settings-recorder is-warn', textContent: `Decision recorder: ${r.error ? `unavailable (${r.error})` : 'OFF (DECISIONS_RECORDER=off)'}` });
    const bad = (r.dropped || 0) + (r.writeErrors || 0) + (r.serializeErrors || 0) + (r.recordErrors || 0);
    const when = r.lastWriteAt ? new Date(r.lastWriteAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'none yet';
    const text = `Decision recorder: ${r.recordedToday || 0} today · ${r.dropped || 0} dropped · ${(r.writeErrors || 0) + (r.serializeErrors || 0)} write errors`
      + `${r.missingContext ? ` · ${r.missingContext} without inputs` : ''} · last write ${when}${r.lastError ? ` · last error: ${r.lastError}` : ''}`;
    return el('p', { className: `settings-recorder${bad || r.missingContext ? ' is-warn' : ''}`, textContent: text });
  }

  SD.strategySettings = { render };
})();
