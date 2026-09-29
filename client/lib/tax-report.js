// Taxes & Accounting math (Phase 80). Pure; loads in the browser (window.SignalDesk.taxReport) and in Node
// (require) so the tests check the exact code the Journal runs.
//   lots()   one row per closed journal record (a T1 partial and its runner are two sales, as on a 1099):
//            description, dates, proceeds, cost basis WITH fees, gain = the ledger's net P/L to the cent, term, venue
//              long:  basis = paid + the buy fee;         proceeds = basis + net P/L (= received - the sell fee)
//              short: proceeds = short-sale price - fee;  basis = the cover + its fee; (b) = the cover date (8949 rule)
//              option spreads: the package debit x 100 x contracts (the ledger's own cost), one line per spread
//            the fees split between buy and sell: the venue's reported buy fee, else pro rata to each side's notional
//            (options: half each, the per-contract commission is the same both ways)
//   csv()    Form 8949-style CSV (ASCII, US dates, New York trade dates)
//   tts()    Trader Tax Status readiness on LIVE trades: trades / week, holding period, dollar volume, active days
//   mtmDeadlines()  the Section 475(f) election due dates (April 15, rolled past a weekend)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SignalDesk = root.SignalDesk || {}; root.SignalDesk.taxReport = api; }
}(typeof window !== 'undefined' ? window : this, () => {
  const DAY = 864e5;
  const FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const memo = new Map();
  // -> { y, m, d, us: 'MM/DD/YYYY', iso: 'YYYY-MM-DD', weekend } in New York time (memoized per day).
  function day(ms) {
    const k = Math.floor(ms / 36e5); // the hour bucket: a New York date never changes inside a UTC hour
    if (memo.has(k)) return memo.get(k);
    const p = Object.fromEntries(FMT.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const out = { y: +p.year, m: +p.month, d: +p.day, us: `${p.month}/${p.day}/${p.year}`, iso: `${p.year}-${p.month}-${p.day}`, weekend: p.weekday === 'Sat' || p.weekday === 'Sun' };
    if (memo.size > 5000) memo.clear();
    memo.set(k, out);
    return out;
  }
  const cents = (x) => Math.round(x * 100) / 100;
  const qty = (x) => String(Number(x.toFixed(8)));
  const ascii = (s) => String(s).replace(/[·•]/g, '-').replace(/[–—]/g, '-').replace(/→/g, '->').replace(/[^\x20-\x7E]/g, '');
  const baseId = (t) => t.parentId || String(t.id).replace(/:trim:\d+$/, '');
  const isLive = (t) => t.execution === 'LIVE';

  function venueOf(t) {
    if (isLive(t)) return { Coinbase: 'Coinbase', Kraken: 'Kraken', OKX: 'OKX', Alpaca: 'Alpaca Live' }[t.broker] || t.broker || (t.market === 'crypto' ? 'Crypto (live)' : 'Alpaca Live');
    return t.paperBroker === 'alpaca' ? 'Alpaca Paper' : 'SignalDesk Paper (simulated)';
  }

  function describe(t, strategy) {
    const od = t.market === 'options' && t.optionsData;
    if (od) {
      const legs = (od.legs || []).map((l) => l.contract).filter(Boolean).join(' / ');
      const exp = od.expiration ? day(Date.parse(`${od.expiration}T12:00:00Z`)).us : '';
      return `${t.positionSize} x ${od.label || `${t.asset} option spread`}${legs ? ` (${legs})` : ''}${exp ? ` exp ${exp}` : ''} - ${strategy}`;
    }
    const what = t.market === 'crypto' ? `${qty(t.positionSize)} ${String(t.asset).split('-')[0]} (${t.asset})` : `${qty(t.positionSize)} sh ${t.asset}`;
    return `${what}${t.direction === 'short' ? ' short sale' : ''} - ${strategy}`;
  }

  function note(t, short) {
    const out = [];
    if (!isLive(t)) out.push('PAPER: simulated, not a taxable sale - do not report');
    if (t.exitReason === 'CLOSED_EXTERNALLY') out.push('sold outside SignalDesk: take the price from the venue\'s records');
    else if (isLive(t) && t.market === 'crypto' && t.pnlSource !== 'broker-fills') out.push('fill priced by SignalDesk: reconcile to the venue\'s 1099-DA / history');
    if (short) out.push(`short sale opened ${t.openedAt ? day(t.openedAt).us : 'n/a'}; (b) is the cover date`);
    if (t.market === 'options') out.push('spread reported as one line (both legs)');
    return out.join('; ');
  }

  // One journal record -> a Form 8949 line. nameOf: strategy id -> label.
  function lot(t, nameOf = (id) => id) {
    const od = t.market === 'options' && t.optionsData;
    const short = !od && t.direction === 'short';
    const size = Math.abs(t.positionSize || 0);
    const open = od ? (Number.isFinite(od.debit) ? od.debit * (od.multiplier || 100) * size : t.notional || 0) : (t.fillPrice || t.entryPrice || 0) * size;
    const gross = Number.isFinite(t.grossPnl) ? t.grossPnl : t.netPnl + (t.fees || 0);
    const close = short ? open - gross : open + gross; // long: what the sale brought; short: what the cover cost
    const fees = Number.isFinite(t.fees) ? t.fees : gross - t.netPnl;
    const entryFee = Number.isFinite(t.entryFeeActual) ? Math.min(fees, t.entryFeeActual) : od || !(open + close > 0) ? fees / 2 : (fees * open) / (open + close); // options: the same per-contract commission each side
    const basis = cents(short ? close + (fees - entryFee) : open + entryFee);
    const gain = cents(t.netPnl);
    const opened = t.openedAt ? day(t.openedAt) : null;
    const sold = day(t.closedAt);
    const acquired = short ? sold : opened;
    const longTerm = !short && !!opened && `${opened.y + 1}${opened.iso.slice(4)}` < sold.iso; // held MORE than one year
    const strategy = nameOf(t.strategyId);
    return {
      id: t.id, description: describe(t, strategy), acquired: acquired ? acquired.us : 'VARIOUS', sold: sold.us, year: sold.y,
      proceeds: cents(basis + gain), basis, gain, fees: cents(fees), term: longTerm ? 'Long-term' : 'Short-term',
      venue: venueOf(t), account: isLive(t) ? 'Live' : 'Paper', strategy, market: t.market, notes: note(t, short), closedAt: t.closedAt,
      volume: Math.abs(open) + Math.abs(close),
    };
  }

  // scope: 'live' (taxable, default) | 'all'. year: the tax year of the sale (New York date).
  function lots(journal, { year, scope = 'live', nameOf } = {}) {
    return (journal || []).filter((t) => Number.isFinite(t.netPnl) && t.closedAt && (scope === 'all' || isLive(t)))
      .map((t) => lot(t, nameOf)).filter((r) => !year || r.year === year).sort((a, b) => a.closedAt - b.closedAt);
  }

  const COLUMNS = [['description', 'Description of Property (8949 a)'], ['acquired', 'Date Acquired (b)'], ['sold', 'Date Sold (c)'], ['proceeds', 'Proceeds (d)'],
    ['basis', 'Cost Basis incl. fees (e)'], ['gain', 'Gain or Loss (h)'], ['term', 'Holding Period'], ['venue', 'Venue'], ['account', 'Account'],
    ['strategy', 'Strategy'], ['fees', 'Fees and Commissions'], ['notes', 'Notes'], ['id', 'SignalDesk Trade ID']];
  const cellOf = (v) => { const s = ascii(typeof v === 'number' ? v.toFixed(2) : v === null || v === undefined ? '' : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = (rows) => [COLUMNS.map(([, h]) => cellOf(h)).join(','), ...rows.map((r) => COLUMNS.map(([k]) => cellOf(r[k])).join(','))].join('\r\n') + '\r\n';

  function summary(rows) {
    const sum = (list, k) => cents(list.reduce((s, r) => s + r[k], 0));
    const st = rows.filter((r) => r.term === 'Short-term');
    const lt = rows.filter((r) => r.term === 'Long-term');
    const venues = [...new Set(rows.map((r) => r.venue))].map((v) => ({ venue: v, count: rows.filter((r) => r.venue === v).length, gain: sum(rows.filter((r) => r.venue === v), 'gain') }));
    return { count: rows.length, proceeds: sum(rows, 'proceeds'), basis: sum(rows, 'basis'), gain: sum(rows, 'gain'), fees: sum(rows, 'fees'), shortTerm: sum(st, 'gain'), longTerm: sum(lt, 'gain'), venues };
  }

  // Weekdays (Mon-Fri, New York) from `from` to `to`, inclusive.
  function weekdays(from, to) {
    const a = day(from); const b = day(to);
    let n = 0;
    for (let t = Date.UTC(a.y, a.m - 1, a.d, 17); t <= Date.UTC(b.y, b.m - 1, b.d, 17); t += DAY) if (!day(t).weekend) n += 1; // 17:00 UTC: midday in New York
    return n;
  }

  // Practitioner benchmarks (there is no bright-line test in the Code; these follow court cases / trader-tax guides).
  const BENCH = { tradesPerWeek: 20, activeDaysPct: 0.75, avgHoldDays: 31 };
  const grade = (ok, near) => (ok ? 'meets' : near ? 'near' : 'short');

  // LIVE trades whose sale falls in `year` (default: all). The period runs from the first trade (TTS can start mid-year)
  // to the year's end or now. -> { trades, executions, weeks, perWeek, perMonth, perDay, avgHoldDays, volume, activeDays,
  //   tradingDays, activeDaysPct, checks: [{ key, status }], met, early (< 4 weeks of history: too soon to judge) } | { trades: 0 }
  function tts(journal, { year, now = Date.now(), nameOf } = {}) {
    const rows = (journal || []).filter((t) => isLive(t) && Number.isFinite(t.netPnl) && t.closedAt && (!year || day(t.closedAt).y === year));
    if (!rows.length) return { trades: 0 };
    const positions = new Map();
    for (const t of rows) {
      const k = baseId(t);
      const p = positions.get(k) || { opened: t.openedAt || t.closedAt, closed: 0 };
      p.opened = Math.min(p.opened, t.openedAt || t.closedAt);
      p.closed = Math.max(p.closed, t.closedAt);
      positions.set(k, p);
    }
    const list = [...positions.values()];
    const start = Math.min(...list.map((p) => p.opened));
    const yearEnd = year ? Date.parse(`${year + 1}-01-01T05:00:00Z`) - 1 : now;
    const end = Math.max(start, Math.min(now, yearEnd));
    const days = Math.max(1, (end - start) / DAY);
    const tradingDays = Math.max(1, weekdays(start, end));
    const active = new Set();
    for (const t of rows) for (const ts of [t.openedAt, t.closedAt]) if (ts && !day(ts).weekend) active.add(day(ts).iso);
    const trades = list.length;
    const perWeek = trades / Math.max(1, days / 7);
    const avgHoldDays = list.reduce((s, p) => s + (p.closed - p.opened), 0) / trades / DAY;
    const activeDaysPct = Math.min(1, active.size / tradingDays);
    const volume = cents(rows.reduce((s, t) => s + lot(t, nameOf).volume, 0));
    const checks = [
      { key: 'frequency', status: grade(perWeek >= BENCH.tradesPerWeek, perWeek >= BENCH.tradesPerWeek * 0.6) },
      { key: 'continuity', status: grade(activeDaysPct >= BENCH.activeDaysPct, activeDaysPct >= BENCH.activeDaysPct * 0.6) },
      { key: 'holding', status: grade(avgHoldDays <= BENCH.avgHoldDays, avgHoldDays <= BENCH.avgHoldDays * 2) },
    ];
    return { trades, executions: new Set(rows.map(baseId)).size + rows.length, start, end, days, early: days < 28, weeks: days / 7, perWeek, perMonth: trades / Math.max(1, days / 30.44),
      perDay: trades / tradingDays, avgHoldDays, volume, activeDays: active.size, tradingDays, activeDaysPct, checks, met: checks.filter((c) => c.status === 'meets').length };
  }

  // Section 475(f) for an existing individual: due with the PRIOR year's return, by its original due date (April 15;
  // a weekend rolls to Monday). -> [{ taxYear, due (ms), dueText, passed }] for this year and next.
  function mtmDeadlines(now = Date.now()) {
    const y = day(now).y;
    return [y, y + 1].map((taxYear) => {
      const d = new Date(Date.UTC(taxYear, 3, 15, 16));
      const wd = d.getUTCDay();
      if (wd === 6) d.setUTCDate(17); else if (wd === 0) d.setUTCDate(16);
      const due = d.getTime();
      return { taxYear, due, dueText: d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }), passed: now > due + 12 * 36e5 }; // past midnight, New York;
    });
  }

  return { lot, lots, csv, summary, tts, mtmDeadlines, venueOf, day, COLUMNS, BENCH };
}));
