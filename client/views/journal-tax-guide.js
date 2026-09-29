// Journal > Taxes & Accounting > Entity & Deduction Roadmap (Phase 80): a collapsible reference card, built ONCE into
// #tax-guide (journal updates never collapse it). Section 475(f) mark-to-market checklist with this year's and next
// year's election deadlines (lib/tax-report.js mtmDeadlines), a deductible-expense checklist (ticks saved on this device,
// localStorage; safe when storage is blocked) and S-Corp salary vs distribution notes. Education, not tax advice.
// Exposes window.SignalDesk.taxGuide.
(() => {
  const SD = window.SignalDesk;
  const { $, el } = SD.ui;
  const KEY = 'signaldesk.taxChecklist.v1';

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } };
  const save = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage blocked: ticks last this session */ } };

  const EXPENSES = [
    ['vm', 'Google Cloud VM', 'the e2-micro running SignalDesk: download the billing report each January'],
    ['data', 'Market data & API subscriptions', 'data feeds, news, charting services'],
    ['software', 'Software & tools', 'trading / tax software, domains, tunnels'],
    ['hardware', 'Trading hardware', 'computer, monitors, UPS: expensed (Section 179 / de minimis) or depreciated'],
    ['office', 'Home office', 'a space used regularly and only for trading; simplified method $5 per sq ft, up to 300 sq ft'],
    ['internet', 'Internet & phone', 'the business-use share only'],
    ['education', 'Education & research', 'books, courses and newsletters about trading'],
    ['pro', 'Professional fees', 'CPA, tax preparer, attorney'],
    ['interest', 'Margin interest', 'a business expense with TTS; investment interest (Form 4952) without it'],
  ];

  const list = (items) => el('ul', { className: 'tax-list' }, items.map((t) => el('li', { textContent: t })));
  const section = (title, kids, open = false) => el('details', { className: 'tax-sec', open }, [el('summary', { textContent: title }), ...kids]);

  function mtm() {
    const [cur, next] = SD.taxReport.mtmDeadlines(Date.now());
    const due = (d) => el('li', { className: d.passed ? 'tax-passed' : 'tax-open' },
      [el('strong', { textContent: `Tax year ${d.taxYear}: ` }), `${d.passed ? 'deadline passed' : 'elect by'} ${d.dueText}${d.passed ? ' (for an existing individual)' : ''}`]);
    return section('Section 475(f) mark-to-market election', [
      el('p', { textContent: 'What it does: trading gains and losses become ordinary (Form 4797, Part II) instead of capital (Form 8949 / Schedule D). Losses are no longer capped at $3,000 a year against other income, the wash-sale rule stops applying to those securities, and positions still open on December 31 are treated as sold at their year-end value. It only applies if you qualify for Trader Tax Status; the election alone does not qualify you.' }),
      el('ul', { className: 'tax-list' }, [due(cur), due(next)]),
      list([
        'Confirm TTS with a CPA who works with traders (see the readiness figures above).',
        'By the deadline (the original due date of the PRIOR year\'s return, usually April 15; the next business day if it falls on a weekend or holiday): attach an election statement to that return or its extension request.',
        'File Form 3115 (automatic accounting-method change) with the election year\'s return, and send a copy to the IRS National Office.',
        'Keep long-term investments in a separate account, identified as investments the day you buy them, so they stay capital.',
        'A NEW entity (e.g. a new S-Corp or partnership) elects within 2 months and 15 days of the start of its first tax year, by a statement kept in its own books.',
        'Revoking also needs a statement by the same kind of deadline, and you generally cannot elect again for 5 years.',
        'Crypto: the IRS treats coins as property; whether 475(f) covers them is unsettled. Many CPAs keep crypto on Form 8949 even for a 475 trader.',
      ]),
    ], true);
  }

  function expenses() {
    const ticks = load();
    const rows = EXPENSES.map(([id, label, hint]) => {
      const box = el('input', { type: 'checkbox', checked: !!ticks[id] });
      box.setAttribute('aria-label', label);
      box.onchange = () => { const v = load(); v[id] = box.checked; save(v); };
      return el('label', { className: 'tax-check' }, [box, el('span', {}, [el('strong', { textContent: label }), ` · ${hint}`])]);
    });
    return section('Deductible business expenses (tracker)', [
      el('p', { textContent: 'With Trader Tax Status these are business expenses on Schedule C. Without it, an investor generally cannot deduct them (miscellaneous itemized deductions are not allowed). Tick each one once you have its receipts / statements for the year (saved on this device).' }),
      el('div', { className: 'tax-checks' }, rows),
    ]);
  }

  function scorp() {
    return section('S-Corp: salary vs distributions', [
      list([
        'Trading gains are not self-employment income, even with TTS, so an S-Corp does not cut self-employment tax on trading profits the way it does for a service business.',
        'Why traders still use one: a reasonable W-2 salary creates earned income to fund a retirement plan (e.g. a Solo 401(k)) and lets the corporation pay your health insurance (added to your W-2 wages, then deducted on your own return).',
        'Salary carries payroll taxes (FICA: 7.65% from the company + 7.65% from you, Social Security up to its wage base); distributions do not. Size the salary to the benefits it funds, keep it reasonable, and take the rest as distributions.',
        'The rest of the result flows to your return on Schedule K-1 (ordinary with a 475 election, capital without).',
        'The entity must qualify for TTS itself and trade in accounts in its own name. Timing: Form 2553 within 2 months and 15 days of the tax year it takes effect; the entity\'s own 475(f) election within 2 months and 15 days of its start.',
        'Costs: payroll service, Form 1120-S, state fees (some states charge an annual minimum, e.g. California $800). Often worth it only with consistent, sizeable trading income.',
      ]),
    ]);
  }

  function build() {
    return el('details', { className: 'tax-guide' }, [
      el('summary', {}, [el('strong', { textContent: 'Entity & Deduction Roadmap' }), el('span', { className: 'panel-hint', textContent: ' 475(f) election · deductible expenses · S-Corp notes' })]),
      mtm(), expenses(), scorp(),
      el('p', { className: 'settings-note', textContent: 'General education, not tax or legal advice. Rules and limits change every year: confirm each step with a CPA who works with active traders before you file.' }),
    ]);
  }

  function mount() { const box = $('tax-guide'); if (box && !box.firstChild) box.replaceChildren(build()); }

  SD.taxGuide = { build, mount };
})();
