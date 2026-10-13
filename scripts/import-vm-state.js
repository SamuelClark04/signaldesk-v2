// Desktop move (Phase 95): bring the VM's trading state onto this PC, from a vm-audit archive (sd-audit-*.tgz) or a folder holding
// ledger-state.json / ledger-snapshot.json. Run it ONCE, with SignalDesk stopped:
//   node scripts/import-vm-state.js C:\Users\you\Downloads\sd-audit-20261007T140816Z.tgz
// - refuses while the SignalDesk server is listening on its port (it would overwrite the file under a running server);
// - backs up this PC's server\data\{ledger-state,paper-runs,external-holdings}.json to server\data\backups\pre-vm-import-<time>\ first;
// - copies the VM files over (ledger-snapshot.json -> ledger-state.json); nothing else is touched (never the credentials vault).
// The imported ledger is only as fresh as the archive: positions opened / closed on the VM after it are not in it. Brokers keep their
// own truth (resting stops stay at the venue); the reconciler compares on the first pass.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.SD_IMPORT_DATA_DIR || path.join(ROOT, 'server', 'data'); // the override is for tests only
const src = process.argv[2];
const port = (() => { try { const m = /^\s*PORT\s*=\s*(\d+)/m.exec(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')); return m ? Number(m[1]) : 3000; } catch { return 3000; } })();

function listening(p) {
  return new Promise((resolve) => { const s = net.connect(p, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); setTimeout(() => { s.destroy(); resolve(false); }, 1500); });
}

(async () => {
  if (!src || !fs.existsSync(src)) { console.log('usage: node scripts/import-vm-state.js <sd-audit-*.tgz | folder>'); process.exitCode = 2; return; }
  if (await listening(port)) { console.log(`SignalDesk is running on port ${port}: stop it first (Stop-SignalDesk.bat), then run this again.`); process.exitCode = 1; return; }
  let dir = src;
  if (fs.statSync(src).isFile()) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-vm-import-'));
    // Windows' own tar (bsdtar) understands C:\ paths; GNU tar (Git Bash) would read "C:" as a remote host
    const winTar = process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32', 'tar.exe');
    execFileSync(winTar && fs.existsSync(winTar) ? winTar : 'tar', ['-xzf', src, '-C', dir]);
    const sub = fs.readdirSync(dir).find((n) => fs.statSync(path.join(dir, n)).isDirectory()); if (sub) dir = path.join(dir, sub);
  }
  const ledger = ['ledger-state.json', 'ledger-snapshot.json'].map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));
  if (!ledger) { console.log(`No ledger-state.json / ledger-snapshot.json in ${dir}.`); process.exitCode = 1; return; }
  JSON.parse(fs.readFileSync(ledger, 'utf8')); // refuse a truncated / corrupt file
  const backup = path.join(DATA, 'backups', `pre-vm-import-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(backup, { recursive: true });
  const plan = [[ledger, 'ledger-state.json'], [path.join(dir, 'paper-runs.json'), 'paper-runs.json'], [path.join(dir, 'external-holdings.json'), 'external-holdings.json']];
  for (const [, name] of plan) if (fs.existsSync(path.join(DATA, name))) fs.copyFileSync(path.join(DATA, name), path.join(backup, name));
  for (const [from, name] of plan) {
    if (!fs.existsSync(from)) { console.log(`  ${name}: not in the archive (kept this PC's copy)`); continue; }
    JSON.parse(fs.readFileSync(from, 'utf8'));
    fs.copyFileSync(from, path.join(DATA, name)); console.log(`  ${name}: imported from ${path.basename(from)} (${fs.statSync(from).mtime.toISOString()})`);
  }
  console.log(`Done. This PC's previous files are in ${path.relative(ROOT, backup)}. Start SignalDesk and check Portfolio against your broker accounts.`);
})().catch((e) => { console.error(`import failed: ${e.message}`); process.exitCode = 1; });
