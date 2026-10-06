// Decision Review loader (Phase 93): one decision per setup from an extracted vm-audit archive folder.
// Evidence, best first: RECORDED (decisions-*.jsonl: the live recorder) > LEDGER (journal / positions / discarded setups: the app's
// own fills and outcomes) > RECONSTRUCTED (log lines: id + reason only). Every field a source lacks is listed in `missing`.
const fs = require('fs');
const path = require('path');

function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])); }
const json = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const OPENED = new Set(['OPENED', 'FILLED']);
const REJECTS = { STRATEGY_BLOCK: 'Strategy block', PIPELINE_REJECT: 'Pipeline rejection', APPROVAL_REJECT: 'Refused at approval', USER_REJECT: 'Rejected by you',
  EXPIRED: 'Expired before approval', VOIDED: 'Entry never filled', ROUTE_FAILED: 'Execution refused' };
// The root setup of a journal record (T1 partials / trims are "<id>:part:..." / "<id>:trim:...").
const rootOf = (t) => t.parentId || String(t.id).replace(/:(part|trim):\d+(:\d+)?$/, '');
const dirOf = (d) => (d === 'short' ? -1 : 1);
// Phase 94 C1: only these paths ARE the decision; a later lifecycle event (approval, fill, close, ...) never stands in for it.
const DECISION_PATHS = ['STRATEGY_BLOCK', 'PIPELINE_REJECT', 'STAGED'];
const MISSING_T0 = 'MISSING (no decision time recorded; approval / entry / close times are kept separately and never substituted)';
const msOf = (x) => (Number.isFinite(x) ? x : typeof x === 'string' && Number.isFinite(Date.parse(x)) ? Date.parse(x) : null);
// Phase 94 S0-3 / C1: the decision, approval, entry and close times stay separate. t0 is the DECISION time (stagedAt) or MISSING.
function timesOf(r, parts = [r]) {
  const closes = parts.map((p) => msOf(p.closedAt)).filter(Number.isFinite);
  const times = { decision: msOf(r.stagedAt), approved: msOf(r.approvedAt), entry: msOf(r.openedAt), close: closes.length ? Math.max(...closes) : null };
  return times.decision ? { times, t0: times.decision, source: 'LEDGER stagedAt' } : { times, t0: null, source: MISSING_T0 };
}

function levelsOf(s) {
  if (!s) return null;
  const entry = s.entryPrice || (s.entryZone && s.entryZone.max) || null;
  const stop = s.initialStop || s.invalidation || null;
  const t = Array.isArray(s.targets) ? s.targets : [];
  if (!(entry > 0 && stop > 0 && t[0] && t[0].price > 0)) return null;
  return { entry, entryZone: s.entryZone || null, stop, t1: t[0].price, t1Share: t[0].allocation ?? 1, t2: t[1] ? t[1].price : null };
}

function base(id, s, source) {
  return { id, source, strategyId: (s && s.strategyId) || 'manual', symbol: s && s.asset, market: s && s.market, d: dirOf(s && s.direction), direction: (s && s.direction) || 'long',
    setupType: s && s.setupType, timeframe: s && s.timeframe, expectedDuration: s && s.expectedDuration, thesis: s && s.thesis, levels: levelsOf(s),
    option: s && s.optionsData ? s.optionsData : null, t0: null, t0Source: MISSING_T0, times: { decision: null, approved: null, entry: null, close: null }, p0: null, events: [], outcome: null,
    realized: null, context: null, missing: [], evidence: s && s.evidence };
}

// Recorded lines -> { decisions: Map(id -> decision), series: Map(key -> series), recorder: { firstAt, lastAt, files } }.
function readRecorded(files) {
  const series = new Map(); const out = new Map(); const repeats = new Map();
  let firstAt = null; let lastAt = null; let bad = 0; let lastStatus = null;
  for (const f of files.sort()) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let x; try { x = JSON.parse(line); } catch { bad += 1; continue; }
      if (x.type === 'series') { series.set(x.key, x); continue; }
      if (x.type === 'repeats') { repeats.set(`${x.id}|${x.path}`, x); continue; }
      if (x.type === 'status') { if (!lastStatus || x.at > lastStatus.at) lastStatus = x; continue; }
      if (x.type !== 'decision') continue;
      firstAt = firstAt === null ? x.at : Math.min(firstAt, x.at); lastAt = Math.max(lastAt || 0, x.at);
      let d = out.get(x.id);
      if (!d) { d = base(x.id, x.setup, 'RECORDED'); out.set(x.id, d); } // t0: the first DECISION event, set below (C1)
      if (!d.levels && x.setup) d.levels = levelsOf(x.setup);
      if (!d.option && x.setup && x.setup.optionsData) d.option = x.setup.optionsData;
      if (x.context && !d.context) d.context = { capturedAt: x.context.capturedAt, values: x.context.values, refs: x.context.series || [] };
      d.events.push({ path: x.path, at: x.at, reason: x.reason, reasonBucket: x.reasonBucket, setup: x.setup, extra: x.extra, guard: x.guard || null, price: x.price ? x.price.last : null });
    }
  }
  for (const d of out.values()) {
    d.events.sort((a, b) => a.at - b.at);
    const decision = d.events.find((e) => DECISION_PATHS.includes(e.path));
    const staged = d.events.map((e) => msOf(e.setup && e.setup.stagedAt)).find(Number.isFinite);
    if (decision) { d.t0 = decision.at; d.p0 = decision.price; d.t0Source = 'RECORDED (first decision record)'; }
    else if (staged) { d.t0 = staged; d.t0Source = 'RECORDED setup stagedAt (the decision record itself was not captured)'; }
    else { d.t0 = null; d.t0Source = MISSING_T0; }
    const firstAt = (paths) => { const e = d.events.find((x) => paths.includes(x.path)); return e ? e.at : null; };
    const closed = [...d.events].reverse().find((x) => x.path === 'CLOSED');
    d.times = { decision: d.t0, approved: firstAt(['APPROVED']), entry: firstAt(['OPENED', 'FILLED']), close: closed ? closed.at : null };
    for (const [k, r] of repeats) if (k.startsWith(`${d.id}|`)) { const e = d.events.find((ev) => ev.path === r.path); if (e) e.repeats = r.count; }
    if (d.context) {
      d.context.series = d.context.refs.map((r) => ({ ...r, data: series.get(r.key) || null, legacyKey: /^[br]:/.test(r.key || '') }));
      d.context.legacyKeys = d.context.series.some((s) => s.legacyKey);
      if (d.context.series.some((s) => /^b:/.test(s.key || ''))) d.missing.push('decision chart stored under an endpoint-only key (b:, before Phase 94): another bar series with the same first / last bar may have been stored in its place');
      if (d.context.series.some((s) => /^r:/.test(s.key || ''))) d.missing.push('decision inputs stored under a 32-bit content hash (r:, before Phase 94): a hash collision is unlikely but not excluded');
    }
    if (!d.context) d.missing.push('decision inputs (chart / signal values): not captured');
  }
  return { decisions: out, series, recorder: { firstAt, lastAt, files: files.length, unreadableLines: bad, lastStatus } };
}

// The final path a setup took: ACCEPTED (a position opened) or the first rejection / expiry that ended it.
function finish(d) {
  const ev = d.events;
  if (ev.some((e) => OPENED.has(e.path)) || d.realized) { d.outcome = { group: 'ACCEPTED', path: 'OPENED', label: 'Accepted (position opened)' }; return d; }
  const end = [...ev].reverse().find((e) => REJECTS[e.path]);
  if (end) d.outcome = { group: 'REJECTED', path: end.path, label: REJECTS[end.path], reason: end.reason, reasonBucket: end.reasonBucket };
  else if (ev.some((e) => e.path === 'STAGED')) d.outcome = { group: 'PENDING', path: 'STAGED', label: 'Staged, no later event recorded' };
  else d.outcome = { group: 'UNKNOWN', path: null, label: 'No outcome recorded' };
  return d;
}

function load(dir) {
  const files = walk(dir);
  const find = (name) => files.find((f) => path.basename(f) === name);
  const rec = readRecorded(files.filter((f) => /^decisions-\d{4}-\d{2}-\d{2}\.jsonl$/.test(path.basename(f))));
  const decisions = rec.decisions;
  const ledger = json(find('ledger-snapshot.json')) || {};
  const runs = json(find('paper-runs.json')) || {};
  const journal = [...(ledger.tradeJournal || []), ...((runs.archived || []).flatMap((r) => (r.tradeJournal || []).map((t) => ({ ...t, run: r.name || `Run ${r.number}` }))))];
  const add = (id, s, source) => { if (!decisions.has(id)) { const d = base(id, s, source); d.missing.push('decision inputs (chart / signal values): not recorded (before the recorder)', 'limits / shield state at the decision: not recorded'); decisions.set(id, d); } return decisions.get(id); };
  const missingRecords = [];
  const afterRecorder = (t) => rec.recorder.firstAt !== null && t >= rec.recorder.firstAt;
  // Accepted trades: realized result from the ledger, grouped by the root setup (T1 partial + runner = one trade).
  const groups = new Map();
  for (const t of journal) { const r = rootOf(t); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); }
  for (const [rootId, parts] of groups) {
    const first = parts.reduce((a, b) => ((a.openedAt || 0) <= (b.openedAt || 0) ? a : b));
    const d = add(rootId, first, 'LEDGER');
    const tmj = timesOf(first, parts);
    if (d.source !== 'RECORDED') { d.times = tmj.times; d.t0 = tmj.t0; d.t0Source = tmj.source; d.levels = d.levels || levelsOf(first); }
    else if (d.t0 === null && tmj.t0) { d.t0 = tmj.t0; d.times.decision = tmj.t0; d.t0Source = 'LEDGER stagedAt (the decision record itself was not captured)'; } // C1: recovered
    if (d.source !== 'RECORDED' && afterRecorder(d.t0)) missingRecords.push({ id: rootId, kind: 'closed trade' });
    const net = parts.reduce((s, p) => s + (p.netPnl || 0), 0); const risk = parts.reduce((s, p) => s + (p.dollarRisk || 0), 0);
    d.realized = { status: 'closed', source: 'LEDGER', fillPrice: first.fillPrice, openedAt: first.openedAt, approvedAt: first.approvedAt, execution: first.execution, run: first.run || null,
      exits: parts.map((p) => ({ exitPrice: p.exitPrice, exitReason: p.exitReason, closedAt: p.closedAt, netPnl: p.netPnl, size: p.positionSize, optionsExitValue: p.optionsExitValue })),
      netPnl: net, rNet: risk > 0 ? net / risk : null, closedAt: Math.max(...parts.map((p) => p.closedAt || 0)), debit: first.optionsData ? first.optionsData.debit : null };
  }
  for (const p of ledger.activePositions || []) {
    const d = add(p.id, p, 'LEDGER');
    const tmp = timesOf(p);
    if (d.source !== 'RECORDED') { d.times = tmp.times; d.t0 = tmp.t0; d.t0Source = tmp.source; d.levels = d.levels || levelsOf(p); }
    else if (d.t0 === null && tmp.t0) { d.t0 = tmp.t0; d.times.decision = tmp.t0; d.t0Source = 'LEDGER stagedAt (the decision record itself was not captured)'; }
    d.realized = d.realized || { status: 'open', source: 'LEDGER', fillPrice: p.fillPrice, openedAt: p.openedAt, execution: p.execution, netPnl: null, rNet: null, debit: p.optionsData ? p.optionsData.debit : null };
  }
  for (const o of ledger.discardedOrders || []) {
    const d = add(o.id, o, 'LEDGER');
    if (d.source !== 'RECORDED') {
      const tmo = timesOf(o); d.times = tmo.times; d.t0 = tmo.t0; d.t0Source = tmo.source; d.levels = d.levels || levelsOf(o);
      d.events.push({ path: o.status === 'void' ? 'VOIDED' : 'DISCARDED', at: o.discardedAt || o.voidedAt, reason: o.voidReason || null });
      if (!o.voidReason) d.missing.push('why it was discarded (expired / rejected by you / refused at approval): not stored on discarded setups');
      if (afterRecorder(d.t0)) missingRecords.push({ id: o.id, kind: 'discarded setup' });
    }
  }
  // Log lines: "[pipeline] rejected <id>: <reason>" (no time beyond the id's date, no levels).
  const log = find('pm2-logs.txt');
  if (log) for (const m of fs.readFileSync(log, 'utf8').matchAll(/\[pipeline\] rejected (\S+): (.+)$/gm)) {
    const id = m[1];
    if (decisions.has(id)) continue;
    const parts = id.split(':');
    const d = base(id, { strategyId: parts[0], asset: parts.find((x) => /^[A-Z][A-Z0-9.-]{0,14}$/.test(x) && !['ORB', 'PULLBACK', 'CALL', 'PUT', 'TREND', 'BREAKDOWN', 'SQUEEZE', 'RELATIVE', 'S1', 'S2', 'MOON', 'COIL'].includes(x)) }, 'RECONSTRUCTED');
    d.direction = parts.includes('PUT') ? 'short' : parts.includes('CALL') ? 'long' : null; d.d = d.direction ? dirOf(d.direction) : null;
    d.events.push({ path: 'PIPELINE_REJECT', at: null, reason: m[2] });
    d.missing.push('decision time (only the date in the id)', 'entry / stop / targets', 'decision inputs');
    decisions.set(id, d);
  }
  for (const d of decisions.values()) {
    finish(d);
    if (!d.levels) d.incomplete = true;
    if (d.events.some((e) => e.path === 'DISCARDED') && d.outcome.group === 'UNKNOWN') d.outcome = { group: 'REJECTED', path: 'DISCARDED', label: 'Discarded (reason not stored)' };
  }
  return { decisions: [...decisions.values()], recorder: { ...rec.recorder, missingRecords }, sources: { journal: journal.length, open: (ledger.activePositions || []).length,
    discarded: (ledger.discardedOrders || []).length, savedAt: ledger.savedAt || null } };
}

module.exports = { load, levelsOf, rootOf, readRecorded, timesOf, REJECTS, DECISION_PATHS };
