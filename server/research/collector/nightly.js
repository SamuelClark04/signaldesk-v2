// Phase 95 (desktop mode): the collector starts the PC research job after each session. The job runs in a CHILD process
// (tools/research/shadow/nightly.js: bars, ingest, replay, report), so a crash or a long run never stops collection.
// Due: the last completed session (from 16:40 ET on a session day, else the previous session day) not yet analysed OK. Checked every
// 5 min and at start (catch-up after the PC was off). A failure is retried after 30 min. State: research-nightly.json next to the files.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cal = require('../nyse-calendar');
const et = require('../../services/et-time');

const ROOT = path.join(__dirname, '..', '..', '..');
const READY_MIN = 16 * 60 + 40; const EVERY_MS = 5 * 60 * 1000; const RETRY_MS = 30 * 60 * 1000;
let timer = null; let child = null; let clock = () => Date.now();
const dir = () => process.env.EVENTS_DIR || path.dirname(process.env.LEDGER_STATE_PATH || path.join(ROOT, 'server', 'data', 'ledger-state.json'));
const stateFile = () => path.join(dir(), 'research-nightly.json');
const read = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; } };
const write = (s) => { try { fs.writeFileSync(stateFile(), JSON.stringify(s, null, 1)); } catch { /* next check retries */ } };

// The last session whose data is complete at `ms` (YYYY-MM-DD).
function lastCompleted(ms) {
  const p = et.parts(ms); const day = p.ymd; const minutes = p.h * 60 + p.m;
  let d = day;
  if (!(cal.isSessionDay(day) && minutes >= Math.max(READY_MIN, cal.closeMinOf(day) + 40))) d = prev(day);
  while (!cal.isSessionDay(d)) d = prev(d);
  return d;
}
const prev = (ymd) => new Date(Date.parse(`${ymd}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);

function due(ms = clock()) {
  const s = read(); const target = lastCompleted(ms);
  if (s.lastOkDay && s.lastOkDay >= target) return null;
  if (s.lastFailAt && ms - s.lastFailAt < RETRY_MS && s.lastFailDay === target) return null;
  return target;
}

function run(day) {
  if (child) return false;
  const log = fs.openSync(path.join(dir(), 'research-nightly.log'), 'a');
  fs.writeSync(log, `\n=== ${new Date(clock()).toISOString()} nightly for ${day}\n`);
  child = spawn(process.execPath, [path.join(ROOT, 'tools', 'research', 'shadow', 'nightly.js'), '--through', day], { cwd: ROOT, stdio: ['ignore', log, log], windowsHide: true });
  const startedAt = clock();
  child.on('exit', (code) => {
    child = null; try { fs.closeSync(log); } catch { /* closed */ }
    const s = read(); s.lastRunAt = startedAt; s.lastExit = code; s.lastDurationS = Math.round((clock() - startedAt) / 1000);
    if (code === 0) { s.lastOkDay = day; delete s.lastFailAt; delete s.lastFailDay; } else { s.lastFailAt = clock(); s.lastFailDay = day; }
    write(s); console.log(`[research] nightly job for ${day} ${code === 0 ? 'done' : `FAILED (exit ${code}); see research-nightly.log`}`);
  });
  child.on('error', () => { child = null; const s = read(); s.lastFailAt = clock(); s.lastFailDay = day; write(s); });
  return true;
}

function check() { const d = due(); if (d) run(d); }
function start() { if (timer) return; timer = setInterval(check, EVERY_MS); if (timer.unref) timer.unref(); setTimeout(check, 60 * 1000).unref(); }
function stop() { if (timer) clearInterval(timer); timer = null; }
const stats = () => { const s = read(); return { lastOkDay: s.lastOkDay || null, lastRunAt: s.lastRunAt || null, lastExit: s.lastExit ?? null, running: !!child }; };

module.exports = { start, stop, check, due, lastCompleted, stats, _test: { setClock: (f) => { clock = f || (() => Date.now()); } } };
