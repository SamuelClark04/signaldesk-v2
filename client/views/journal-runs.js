// Journal > paper run selector (Phase 88). "Current run (active)" or an archived run (GET /api/paper/runs, /api/paper/runs/:id):
// an archived run swaps the Closed Trades table and the Strategy Scorecard to THAT run's own trades (read-only, never mixed with the
// active run), with its summary and a cumulative P/L chart. Taxes always read the current journal (they report LIVE trades;
// archived runs are paper). JOURNAL_UPDATED / PAPER_RUNS arrive through onJournal / onRuns (app.js).
// Exposes window.SignalDesk.journalRuns.
(() => {
  const SD = window.SignalDesk;
  const { $, el, money, signed } = SD.ui;
  let runs = null; // { current, archived: [...] }
  let selected = 'current';
  let live = []; // the current journal (all records)
  const archives = new Map(); // runId -> run (with tradeJournal)
  const day = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);

  async function getJson(url) {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || !j.ok) throw new Error((j && j.error) || `HTTP ${res.status}`);
    return j;
  }

  // Cumulative net P/L by close time: a small SVG line (theme colors; the end color says up or down).
  function chart(trades) {
    const list = [...trades].filter((t) => Number.isFinite(t.netPnl)).sort((a, b) => a.closedAt - b.closedAt);
    if (list.length < 2) return el('p', { className: 'settings-note', textContent: list.length ? 'One closed trade: no P/L curve yet.' : 'No closed trades in this run yet.' });
    let sum = 0;
    const pts = [0, ...list.map((t) => { sum += t.netPnl; return sum; })];
    const lo = Math.min(0, ...pts); const hi = Math.max(0, ...pts); const span = hi - lo || 1;
    const W = 600; const H = 90;
    const xy = pts.map((v, i) => `${((i / (pts.length - 1)) * W).toFixed(1)},${(H - ((v - lo) / span) * H).toFixed(1)}`).join(' ');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'jr-run-chart');
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `Cumulative net P/L over ${list.length} trades, ending ${signed(sum, money)}`);
    const zero = document.createElementNS(svg.namespaceURI, 'line');
    const zy = (H - ((0 - lo) / span) * H).toFixed(1);
    Object.entries({ x1: 0, x2: W, y1: zy, y2: zy, class: 'jr-run-zero' }).forEach(([k, v]) => zero.setAttribute(k, v));
    const line = document.createElementNS(svg.namespaceURI, 'polyline');
    line.setAttribute('points', xy); line.setAttribute('class', `jr-run-line ${sum >= 0 ? 'is-up' : 'is-down'}`);
    svg.append(zero, line);
    return svg;
  }

  function summaryLine(r) {
    const bank = `paper bankroll ${money(r.initialBankroll || 0)} stocks / options, ${money(r.initialCryptoBankroll || 0)} crypto`;
    const when = r.endedAt ? `${day(r.startedAt)} – ${day(r.endedAt)}` : `since ${day(r.startedAt)}`;
    return `${when} · ${bank} · ${r.tradeCount || 0} trades · win rate ${pct(r.winRate)} · net ${signed(r.finalNetPnl || 0, money)}`
      + `${r.closedAtReset && r.closedAtReset.length ? ` · ${r.closedAtReset.length} closed at the reset` : ''}`;
  }

  function renderBar(trades) {
    const box = $('journal-runs');
    if (!box) return;
    const pick = el('select', { className: 'mode-select', id: 'journal-run-select' }, [
      el('option', { value: 'current', textContent: runs ? `Current run (active) · Run ${runs.current.number}` : 'Current run (active)', selected: selected === 'current' }),
      ...((runs && runs.archived) || []).map((r) => el('option', { value: r.runId, selected: selected === r.runId, textContent: `${r.name} · ${signed(r.finalNetPnl || 0, money)}` })),
    ]);
    pick.setAttribute('aria-label', 'Paper run');
    pick.onchange = () => choose(pick.value);
    const r = selected === 'current' ? runs && runs.current : runs && runs.archived.find((x) => x.runId === selected);
    box.replaceChildren(
      el('div', { className: 'jr-run-head' }, [el('label', { className: 'field-label', htmlFor: 'journal-run-select', textContent: 'Paper run' }), pick,
        ...(selected !== 'current' ? [el('span', { className: 'jr-run-badge', textContent: 'Archived · read-only' })] : [])]),
      ...(r ? [el('p', { className: 'settings-note jr-run-sum', textContent: summaryLine(r) })] : []),
      chart((selected === 'current' ? live.filter((t) => t.execution !== 'LIVE') : trades) || []),
      ...(selected === 'current' ? [] : [el('p', { className: 'settings-note', textContent: 'This run\'s paper trades only. Taxes below still show the current journal (LIVE trades).' })]));
  }

  async function choose(id) {
    selected = id;
    if (id === 'current') return show();
    try {
      if (!archives.has(id)) archives.set(id, (await getJson(`/api/paper/runs/${encodeURIComponent(id)}`)).run);
      show();
    } catch (err) {
      selected = 'current'; show();
      const box = $('journal-runs'); if (box) box.append(el('p', { className: 'settings-status is-error', textContent: `Could not load that run: ${err.message}` }));
    }
  }

  function show() {
    const trades = selected === 'current' ? live : (archives.get(selected) || { tradeJournal: [] }).tradeJournal;
    SD.journal.render(trades);
    SD.journalScorecard.render(trades);
    renderBar(trades);
  }

  let soon = null;
  function onJournal(trades) {
    live = trades || [];
    clearTimeout(soon); soon = setTimeout(refresh, 1500); // the current run's summary follows the journal
    SD.journalTaxes.render(live); // always the current journal (LIVE trades)
    if (selected === 'current') show(); // an archived run on screen stays as it is
    else renderBar((archives.get(selected) || { tradeJournal: [] }).tradeJournal);
  }

  function onRuns(r) {
    if (!r) return;
    runs = r;
    if (selected !== 'current' && !r.archived.some((x) => x.runId === selected)) selected = 'current';
    if (SD.paperRun) SD.paperRun.render(r); // Settings > Paper trading run
    show();
  }

  const refresh = () => getJson('/api/paper/runs').then(onRuns).catch(() => { /* offline: the selector shows the current run */ });

  SD.journalRuns = { onJournal, onRuns, refresh, choose, chart };
})();
