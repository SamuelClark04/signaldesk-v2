// Journal > Taxes & Accounting (Phase 80; the math is lib/tax-report.js):
//   [Export for CPA / TurboTax]  a Form 8949-style CSV of the selected tax year's sales: LIVE trades (the taxable ones) by
//                                default, or live + paper (paper rows are marked "do not report"); built in the browser
//                                from the journal it already holds, nothing leaves the device but the file
//   TTS readiness                trades / week, holding period, dollar volume, active trading days (LIVE trades only)
//   Roadmap                      views/journal-tax-guide.js (475(f), deductible expenses, S-Corp notes), its own box, built
//                                once (a journal update never collapses what the user opened)
// Exposes window.SignalDesk.journalTaxes.
(() => {
  const SD = window.SignalDesk;
  const { $, el, money, signed, pnlClass } = SD.ui;
  const TX = SD.taxReport;
  const SCOPES = [['live', 'Live (taxable)'], ['all', 'Live + paper']];
  let journal = [];
  let year = null;
  let scope = 'live';

  const nameOf = (id) => SD.scorecard.nameOf(id);
  const years = () => {
    const ys = new Set(journal.filter((t) => t.closedAt && Number.isFinite(t.netPnl)).map((t) => TX.day(t.closedAt).y));
    ys.add(TX.day(Date.now()).y);
    return [...ys].sort((a, b) => b - a);
  };

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = el('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function controls(rows) {
    const pick = el('select', { className: 'input', id: 'tax-year' }, years().map((y) => el('option', { value: String(y), textContent: String(y), selected: y === year })));
    pick.onchange = () => { year = Number(pick.value); render(); };
    const seg = el('div', { className: 'pf-venues-toggle', role: 'group' }, SCOPES.map(([k, label]) => {
      const b = el('button', { type: 'button', className: `pf-venue-seg${k === scope ? ' is-active' : ''}`, textContent: label });
      b.setAttribute('aria-pressed', String(k === scope));
      b.onclick = () => { scope = k; render(); };
      return b;
    }));
    const go = el('button', { type: 'button', className: 'btn btn-primary', textContent: 'Export for CPA / TurboTax (CSV)', disabled: !rows.length,
      title: rows.length ? 'Form 8949 columns: description, dates acquired / sold, proceeds, cost basis with fees, gain or loss, term, venue' : 'No closed trades in this year / scope' });
    go.onclick = () => download(`signaldesk-8949-${year}-${scope === 'live' ? 'live' : 'live-and-paper'}.csv`, TX.csv(rows));
    return el('div', { className: 'bt-controls tax-controls' }, [
      el('label', { className: 'field' }, [el('span', { className: 'field-label', textContent: 'Tax year (by sale date)' }), pick]),
      el('div', { className: 'field' }, [el('span', { className: 'field-label', textContent: 'Trades' }), seg]), go]);
  }

  function summaryBox(rows) {
    if (!rows.length) return el('p', { className: 'bt-line', textContent: `No closed ${scope === 'live' ? 'live ' : ''}trades sold in ${year}.` });
    const s = TX.summary(rows);
    const kpi = (label, v, cls = '') => el('div', { className: 'bt-kpi' }, [el('span', { className: 'bt-kpi-label', textContent: label }), el('strong', { className: cls, textContent: v })]);
    return el('div', {}, [
      el('div', { className: 'bt-kpis' }, [kpi('Sales (8949 lines)', String(s.count)), kpi('Proceeds', money(s.proceeds)), kpi('Cost basis incl. fees', money(s.basis)),
        kpi('Net gain / loss', signed(s.gain, money), pnlClass(s.gain)), kpi('Short-term', signed(s.shortTerm, money), pnlClass(s.shortTerm)),
        kpi('Long-term', signed(s.longTerm, money), pnlClass(s.longTerm)), kpi('Fees paid', money(s.fees))]),
      el('p', { className: 'bt-line', textContent: `By venue: ${s.venues.map((v) => `${v.venue} ${v.count} (${signed(v.gain, money)})`).join(' · ')}` }),
    ]);
  }

  const STATUS = { meets: ['Meets', 'is-ok'], near: ['Getting close', 'is-near'], short: ['Below', 'is-short'] };
  function ttsBox() {
    const m = TX.tts(journal, { year, nameOf });
    const head = el('h3', { className: 'tax-h', textContent: `Trader Tax Status readiness · ${year} · live trades` });
    if (!m.trades) return el('div', { className: 'tax-tts' }, [head, el('p', { className: 'bt-line', textContent: `No closed live trades in ${year}: paper trading never counts toward TTS.` })]);
    const st = (key) => STATUS[(m.checks.find((c) => c.key === key) || {}).status] || null;
    const tile = (label, value, bench, s) => el('div', { className: `bt-kpi tax-tile${s ? ` ${s[1]}` : ''}` }, [el('span', { className: 'bt-kpi-label', textContent: label }),
      el('strong', { textContent: value }), el('span', { className: 'tax-bench', textContent: bench }), ...(s ? [el('span', { className: 'tax-chip', textContent: s[0] })] : [])]);
    const hold = m.avgHoldDays < 1 ? `${(m.avgHoldDays * 24).toFixed(1)} hours` : `${m.avgHoldDays.toFixed(1)} days`;
    return el('div', { className: 'tax-tts' }, [head,
      el('div', { className: 'bt-kpis' }, [
        tile('Trades per week', m.perWeek.toFixed(1), `${m.perMonth.toFixed(0)} / month · ${m.perDay.toFixed(1)} per trading day · benchmark 20+ / week (~4 a day)`, st('frequency')),
        tile('Average holding period', hold, 'benchmark: under 31 days (short-term swings, not investing)', st('holding')),
        tile('Dollar volume traded', money(m.volume), 'buys + sells; courts weigh substantial volume (no fixed figure)', null),
        tile('Active trading days', `${Math.round(m.activeDaysPct * 100)}%`, `${m.activeDays} of ${m.tradingDays} weekdays · benchmark 75%+ (continuity)`, st('continuity')),
      ]),
      el('p', { className: `bt-line${m.early ? ' tax-warn' : ''}`, textContent: `${m.trades} live trades over ${Math.max(1, Math.round(m.days))} days since the first one (TTS can start mid-year). ${m.met} of 3 benchmarks met.`
        + `${m.early ? ' Under 4 weeks of history: too soon to judge.' : m.met === 3 ? ' The pattern looks like a trading business; confirm with a CPA before claiming it.' : ' On this pattern TTS is unlikely: expenses stay non-deductible and losses stay capital.'}` }),
      el('p', { className: 'settings-note', textContent: 'The tax code has no bright-line TTS test: the IRS and courts look for substantial, frequent, regular and continuous trading to profit from short-term moves. These benchmarks follow court cases and trader-tax guidance; they are not an IRS rule. Paper trades never count.' }),
    ]);
  }

  function render(trades) {
    if (trades) journal = trades;
    const box = $('tax-hub');
    if (!box) return;
    if (year === null || !years().includes(year)) year = years()[0];
    const rows = TX.lots(journal, { year, scope, nameOf });
    box.replaceChildren(controls(rows), summaryBox(rows),
      el('p', { className: 'settings-note', textContent: 'Each sale is one line (a T1 partial and its runner are two sales, as on a 1099). Cost basis includes the buy fee; proceeds are net of the sell fee, so the gain matches the Journal\'s net P/L to the cent. '
        + 'Dates are New York trade dates. Wash sales (column g) are not adjusted: your broker\'s 1099-B / 1099-DA is the official record; use this file to reconcile it.' }),
      ttsBox());
  }

  SD.journalTaxes = { render };
})();
