// Settings > Paper trading run (Phase 88): [Archive & Start New Paper Run]. A confirmation modal (optional run name), then
// POST /api/paper/reset-run { confirm: true, name }: the server archives the run (Journal > Paper run) and clears the paper book.
// A refusal (positions still open at Alpaca Paper, no price to close one at) is shown as is. Exposes window.SignalDesk.paperRun.
(() => {
  const SD = window.SignalDesk;
  const { $, el, money } = SD.ui;
  const MSG = 'This will archive your current trades to the Journal history and reset your cash balance, daily kill switch, and active positions to start fresh.';
  let runs = null;
  let overlay = null;

  function status(text, kind = '') { const s = $('settings-run-status'); if (s) { s.textContent = text; s.className = `settings-status${kind ? ` is-${kind}` : ''}`; } }
  function close() { if (overlay) { overlay.remove(); overlay = null; document.removeEventListener('keydown', onKey); } }
  function onKey(e) { if (e.key === 'Escape') close(); }

  async function submit(name, go) {
    go.disabled = true; go.textContent = 'Archiving…';
    let r;
    try {
      const res = await fetch('/api/paper/reset-run', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, name }) });
      r = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    } catch (err) { r = { ok: false, error: `Could not reach SignalDesk (${err.message})` }; }
    close();
    if (!r.ok) return status(`Not reset: ${r.error || 'no reply'}`, 'error');
    const a = r.archived;
    status(`Archived "${a.name}" (${a.tradeCount} trades, net ${money(a.finalNetPnl)}${a.closedAtReset.length ? `, ${a.closedAtReset.length} closed at the reset` : ''}). `
      + `Run ${r.current.number} started at ${money(r.current.initialBankroll)} stocks / options and ${money(r.current.initialCryptoBankroll)} crypto; the paper kill switch is cleared.`, 'ok');
    if (r.runs) { render(r.runs); SD.journalRuns.onRuns(r.runs); }
  }

  function open() {
    close();
    const n = runs ? runs.current.number : null;
    const name = el('input', { className: 'input', type: 'text', maxLength: 60, id: 'paper-run-name', placeholder: n ? `Run ${n} (dates added automatically)` : 'Optional name' });
    const cancel = el('button', { type: 'button', className: 'btn', textContent: 'Cancel' });
    const go = el('button', { type: 'button', className: 'btn btn-danger', textContent: 'Archive & Start New Run' });
    cancel.onclick = close;
    go.onclick = () => submit(name.value, go);
    const cur = runs && runs.current;
    const box = el('div', { className: 'ai-modal run-modal', role: 'dialog' }, [
      el('header', { className: 'ai-head' }, [el('strong', { textContent: 'Archive & Start New Paper Run' })]),
      el('div', { className: 'ai-body' }, [
        el('p', { textContent: MSG }),
        ...(cur ? [el('p', { className: 'settings-note', textContent: `Run ${cur.number}: ${cur.tradeCount} closed paper trades, net ${money(cur.finalNetPnl)}; ${cur.open} open paper position(s) `
          + 'will be closed at their current mark (Alpaca Paper positions must be closed first). LIVE trades, LIVE positions and settings are not touched; a backup of the ledger is saved.' })] : []),
        el('label', { className: 'field' }, [el('span', { className: 'field-label', textContent: 'Name for the archived run (optional)' }), name]),
        el('div', { className: 'run-modal-actions' }, [cancel, go]),
      ]),
    ]);
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Archive and start a new paper run');
    overlay = el('div', { className: 'ai-overlay' }, [box]);
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    cancel.focus();
  }

  function render(r) {
    if (r) runs = r;
    const box = $('settings-paper-run');
    if (!box) return;
    const cur = runs && runs.current;
    const b = el('button', { type: 'button', className: 'btn btn-danger', id: 'settings-run-reset', textContent: 'Archive & Start New Paper Run' });
    b.onclick = open;
    const keep = $('settings-run-status');
    box.replaceChildren(
      el('p', { className: 'settings-facts', textContent: cur
        ? `Run ${cur.number} since ${new Date(cur.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}: ${cur.tradeCount} closed paper trades, net ${money(cur.finalNetPnl)}, ${cur.open} open. `
          + `${runs.archived.length} archived run${runs.archived.length === 1 ? '' : 's'} (Journal > Paper run).`
        : 'Loading the paper run…' }),
      b, keep || el('span', { className: 'settings-status', id: 'settings-run-status', role: 'status' }));
  }

  SD.paperRun = { render, open, close };
})();
