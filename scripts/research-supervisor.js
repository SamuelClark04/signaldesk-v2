// Desktop mode (Phase 95): keeps the RECORD-ONLY research collector running on this PC, independent of the trading server window.
//   node scripts/research-supervisor.js start    start in the background (no window) unless already running
//   node scripts/research-supervisor.js stop     stop the supervisor and its collector
//   node scripts/research-supervisor.js status   pids, uptime, last nightly report
// The supervisor restarts the collector when it exits (10 s, backing off to 5 min when it keeps crashing within a minute). Output:
// server/data/research-collector.log (rotated at 20 MB). Files: research-supervisor.pid / research-collector.pid / research-supervisor.stop.
// It never touches the trading server (Start-SignalDesk.bat starts both; Stop-SignalDesk.bat stops both).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.EVENTS_DIR || path.join(ROOT, 'server', 'data');
const F = { sup: path.join(DATA, 'research-supervisor.pid'), col: path.join(DATA, 'research-collector.pid'), stop: path.join(DATA, 'research-supervisor.stop'), log: path.join(DATA, 'research-collector.log') };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readPid = (f) => { try { const p = Number(fs.readFileSync(f, 'utf8').trim()); return p > 0 && alive(p) ? p : null; } catch { return null; } };
const logLine = (s) => { try { fs.appendFileSync(F.log, `[supervisor ${new Date().toISOString()}] ${s}\n`); } catch { /* no log */ } };

function start() {
  const p = readPid(F.sup); if (p) { console.log(`Research collector already running (supervisor pid ${p}).`); return; }
  fs.mkdirSync(DATA, { recursive: true }); try { fs.unlinkSync(F.stop); } catch { /* none */ }
  const child = spawn(process.execPath, [__filename, 'run'], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref(); console.log(`Research collector started in the background (supervisor pid ${child.pid}); log: ${path.relative(ROOT, F.log)}`);
}

function runLoop() {
  fs.writeFileSync(F.sup, String(process.pid));
  let fastFails = 0; let current = null;
  const launch = () => {
    if (fs.existsSync(F.stop)) return finish();
    try { if (fs.statSync(F.log).size > 20e6) fs.renameSync(F.log, `${F.log}.1`); } catch { /* no log yet */ }
    const out = fs.openSync(F.log, 'a'); const t0 = Date.now();
    current = spawn(process.execPath, [path.join(ROOT, 'server', 'research', 'collector', 'main.js')], { cwd: ROOT, stdio: ['ignore', out, out], windowsHide: true });
    fs.writeFileSync(F.col, String(current.pid)); logLine(`collector started (pid ${current.pid})`);
    current.on('exit', (code, sig) => {
      try { fs.closeSync(out); } catch { /* closed */ }
      current = null; logLine(`collector exited (code ${code}, signal ${sig})`);
      if (fs.existsSync(F.stop)) return finish();
      fastFails = Date.now() - t0 < 60000 ? fastFails + 1 : 0;
      const wait = Math.min(300000, 10000 * 2 ** Math.min(5, fastFails));
      logLine(`restarting in ${Math.round(wait / 1000)} s`); setTimeout(launch, wait);
    });
  };
  const finish = () => { for (const f of [F.sup, F.col, F.stop]) { try { fs.unlinkSync(f); } catch { /* gone */ } } logLine('supervisor stopped'); process.exit(0); };
  // the stop flag is checked every 2 s (a signal does not reach a windowless process on Windows): the collector sees the same flag and
  // shuts down cleanly (flushing its queue); it is killed only if still running 10 s later
  let stopSeen = 0;
  setInterval(() => {
    if (!fs.existsSync(F.stop)) return; if (!current) return finish();
    if (!stopSeen) stopSeen = Date.now(); else if (Date.now() - stopSeen > 10000) { try { current.kill(); } catch { finish(); } }
  }, 2000);
  launch();
}

function stop() {
  const p = readPid(F.sup); const c = readPid(F.col);
  if (!p && !c) { console.log('Research collector is not running.'); return; }
  fs.writeFileSync(F.stop, String(Date.now()));
  const t0 = Date.now();
  const wait = () => {
    if (!readPid(F.sup) && !readPid(F.col)) { console.log('Research collector stopped.'); return; }
    if (Date.now() - t0 > 15000) { for (const x of [c, p]) if (x) { try { process.kill(x); } catch { /* gone */ } } console.log('Research collector stopped (forced).'); return; }
    setTimeout(wait, 500);
  };
  wait();
}

function status() {
  const p = readPid(F.sup); const c = readPid(F.col);
  let n = {}; try { n = JSON.parse(fs.readFileSync(path.join(DATA, 'research-nightly.json'), 'utf8')); } catch { n = {}; }
  console.log(`supervisor: ${p ? `running (pid ${p})` : 'not running'}; collector: ${c ? `running (pid ${c})` : 'not running'}`);
  console.log(`last research report: ${n.lastOkDay ? `session ${n.lastOkDay}, reports/shadow-${n.lastOkDay}.html` : 'none yet'}${n.lastExit && n.lastExit !== 0 ? ` (last run FAILED: see ${path.relative(ROOT, path.join(DATA, 'research-nightly.log'))})` : ''}`);
}

const cmd = process.argv[2];
if (cmd === 'start') start(); else if (cmd === 'run') runLoop(); else if (cmd === 'stop') stop(); else if (cmd === 'status') status();
else { console.log('usage: node scripts/research-supervisor.js start|stop|status'); process.exitCode = 2; }
