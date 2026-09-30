// Trade context (Phase 79): the same three lines on every staged setup card, the right-hand position panel and the
// Portfolio holding details:
//   Expected hold    the plan's window (o.expectedDuration; Moonshots: "30m – 3h (momentum burst — do not hold if
//                    volume dies)")
//   Entry vs live    Moonshots: the conviction score it was entered on (o.entrySnapshot, else o.convictionScore) vs
//                    the radar's score now (MOONSHOT_RADAR, which always scores held Moonshots), with what changed:
//                    volume, spread, buzz, momentum ("Thesis weakened: volume dropped to 0.8x (was 3.1x) ...")
//   Why we entered   o.entryReason (kept on the trade record), else the first sentences of its thesis
// Exposes window.SignalDesk.tradeContext.
(() => {
  const SD = window.SignalDesk;
  const { el } = SD.ui;
  const isMoon = (o) => o.strategyId === 'speculative-crypto' || !!o.speculative;
  const sentences = (t, n) => String(t || '').split(/(?<=\.)\s/).slice(0, n).join(' ');
  const radarRow = (asset) => { const r = SD.app && SD.app.state && SD.app.state.moonshotRadar; return (r && r.rows && r.rows.find((x) => x.symbol === asset)) || null; };

  // -> { entry, live, verdict, why: [] } | { entry, live: null } | null (not a Moonshot / no entry score).
  function scoreCompare(o, row = radarRow(o.asset)) {
    if (!isMoon(o)) return null;
    const snap = o.entrySnapshot || null;
    const entry = snap && Number.isFinite(snap.score) ? snap.score : Number.isFinite(o.convictionScore) ? o.convictionScore : null;
    if (entry === null) return null;
    if (!row) return { entry, live: null };
    const was = (v, f) => (v === null || v === undefined || !Number.isFinite(v) ? '' : ` (was ${f(v)})`);
    const why = [];
    if (Number.isFinite(row.relVol) && row.relVol < 1.5) why.push(`volume dropped to ${row.relVol}x${was(snap && snap.relVol, (v) => `${v}x`)}`);
    if (Number.isFinite(row.spreadPct) && row.spreadPct > 1) why.push(`spread widened to ${row.spreadPct}%${was(snap && Number.isFinite(snap.spreadPct) ? snap.spreadPct * 100 : null, (v) => `${v.toFixed(2)}%`)}`);
    if (row.parts && row.parts.buzz === 0) why.push(`buzz ${snap && snap.buzz > 0 ? `gone (0/30, was ${snap.buzz})` : '0/30'}`);
    if (row.parts && snap && snap.parts && row.parts.velocity <= snap.parts.velocity - 8) why.push(`momentum faded (velocity ${row.parts.velocity}/25, was ${snap.parts.velocity})`);
    const verdict = row.score >= entry - 5 ? 'Thesis intact' : entry - row.score >= 20 || row.score < 40 ? 'Thesis weakened' : 'Thesis fading';
    return { entry, live: row.score, verdict, why };
  }

  // opts: { hold, score, why } (each on by default). -> element | null
  function block(o, { hold = true, score = true, why = true } = {}) {
    if (!o) return null;
    const open = !!o.openedAt;
    const lines = [];
    if (hold && o.expectedDuration) lines.push(el('p', { className: 'tc-line' }, [el('strong', { textContent: 'Expected hold: ' }), o.expectedDuration]));
    const s = score ? scoreCompare(o) : null;
    if (s) {
      const head = `${open ? 'Entry score' : 'Score at setup'}: ${s.entry}/100 → Live score: `;
      lines.push(el('p', { className: `tc-line tc-score${s.verdict === 'Thesis weakened' ? ' is-weak' : s.verdict === 'Thesis intact' ? ' is-ok' : ''}`,
        textContent: s.live === null ? `${head}not on the radar right now` : `${head}${s.live}/100 · ${s.verdict}${s.why.length ? `: ${s.why.join(', ')}` : ''}` }));
    }
    // Phase 82: an option stop / target hit after the 3:45 PM cutoff is held and sold at 9:35 AM ET.
    if (o.deferredExit) lines.push(el('p', { className: 'tc-line tc-score is-weak', textContent: `${o.deferredExit.reason === 'STOP_LOSS' ? 'Stop' : 'Target'} hit ${new Date(o.deferredExit.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET after the 3:45 PM cutoff (option quotes too wide): sells at 9:35 AM ET` }));
    const reason = o.entryReason || sentences(o.thesis, 2);
    if (why && reason) lines.push(el('p', { className: 'tc-line tc-why' }, [el('strong', { textContent: open ? 'Why we entered: ' : 'Why this setup: ' }), reason]));
    return lines.length ? el('div', { className: 'tc' }, lines) : null;
  }

  SD.tradeContext = { block, scoreCompare };
})();
