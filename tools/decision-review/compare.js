// Decision Review change report (Phase 94 Stage 0): what changed between two report JSON files and which recorded notes go with each
// change. It describes differences; the notes (P0 / input source, t0 source, opposite rule, legacy evidence keys, origin) are the
// Stage 0 fixes that touched that setup, listed so a reviewer can check each change: not proof of why it changed.
// Run: node tools/decision-review/compare.js <old.json> <new.json> [--out <file.md>]
const fs = require('fs');

const endOf = (s) => ((s.horizons || []).find((h) => h.key === 'H') || {}).label || null;
const fmt = (x) => (x === null || x === undefined ? '-' : typeof x === 'number' ? x.toFixed(2) : String(x));
const tally = (list) => list.reduce((a, s) => { const k = (s.class && s.class.cls) || 'NONE'; a[k] = (a[k] || 0) + 1; return a; }, {});

function compare(oldJ, newJ) {
  const before = new Map(oldJ.setups.map((s) => [s.id, s]));
  const acct = newJ.setups.filter((s) => s.origin !== 'HARNESS'); const harness = newJ.setups.filter((s) => s.origin === 'HARNESS');
  const changes = [];
  for (const s of acct) {
    const o = before.get(s.id);
    if (!o) { changes.push({ id: s.id, origin: s.origin, fields: { added: 'new in this report' }, notes: s.notes || {} }); continue; }
    const f = {};
    const pair = (k, a, b) => { if (fmt(a) !== fmt(b)) f[k] = `${fmt(a)} -> ${fmt(b)}`; };
    pair('class', o.class && o.class.cls, s.class && s.class.cls); pair('end', endOf(o), endOf(s));
    pair('money', o.money && o.money.rNet, s.money && s.money.rNet); pair('opposite', o.opposite && o.opposite.label, s.opposite && s.opposite.label);
    pair('rule', o.rule && o.rule.verdict, s.rule && s.rule.verdict); pair('t0', o.t0, s.t0);
    if (Object.keys(f).length) changes.push({ id: s.id, origin: s.origin, fields: f, notes: s.notes || {} });
  }
  const ids = new Set(newJ.setups.map((s) => s.id));
  const removed = oldJ.setups.filter((s) => !ids.has(s.id)).map((s) => s.id);
  const movedToHarness = harness.map((s) => s.id).filter((id) => before.has(id));
  return { counts: { before: tally(oldJ.setups), after: tally(acct), afterHarness: harness.length }, changes, movedToHarness, removed };
}

function toMarkdown(c) {
  const classes = [...new Set([...Object.keys(c.counts.before), ...Object.keys(c.counts.after)])].sort();
  const notes = (n) => Object.entries(n || {}).filter(([, v]) => v !== undefined && v !== null && v !== false).map(([k, v]) => `${k}: ${v}`).join('; ');
  return ['## Class counts', '', 'Before = every setup in the Phase 93 report (harness included); After = account setups only.', '',
    '| Class | Before | After |', '|---|---|---|',
    ...classes.map((k) => `| ${k} | ${c.counts.before[k] || 0} | ${c.counts.after[k] || 0} |`), '',
    `Harness examples now listed separately: ${c.counts.afterHarness} (previously counted in the totals: ${c.movedToHarness.length}).`,
    `Setups in the old report but not the new one: ${c.removed.length}${c.removed.length ? ` (${c.removed.join(', ')})` : ''}.`, '',
    '## Setups whose result changed', '', '| Setup | Changed | Stage 0 notes on this setup |', '|---|---|---|',
    ...c.changes.map((x) => `| ${x.id} | ${Object.entries(x.fields).map(([k, v]) => `${k}: ${v}`).join('; ')} | ${notes(x.notes)} |`)].join('\n');
}

if (require.main === module) {
  const files = process.argv.slice(2).filter((x, i, all) => !x.startsWith('--') && all[i - 1] !== '--out');
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
  const md = toMarkdown(compare(JSON.parse(fs.readFileSync(files[0], 'utf8')), JSON.parse(fs.readFileSync(files[1], 'utf8'))));
  if (out) fs.writeFileSync(out, `${md}\n`); else console.log(md);
}

module.exports = { compare, toMarkdown };
