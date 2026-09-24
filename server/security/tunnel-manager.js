// Cloudflare quick tunnel: started by the server itself so it can LEARN the
// random https://<name>.trycloudflare.com address it gets each run, then:
//   - allow that origin (access-policy.addAllowedOrigin): the zero-trust sign-in
//     still applies to every request through it, the origin rule just lets the
//     tunnel page open the WebSocket;
//   - print it in a box on this console (easy to copy) with cloudflared's own
//     startup lines prefixed [tunnel];
//   - make it the app's public address in memory: APP_PUBLIC_URL (restored when
//     the tunnel ends) and TUNNEL_PUBLIC_URL, which the alert emails' "Open
//     Approvals" link uses (notifier.js); no restart, no .env edit.
// cloudflared.exe is found via CLOUDFLARED_EXE (Start-SignalDesk.bat sets it),
// then the project root, scripts/, the installer's Program Files / Common Files
// folders, winget (Links, Packages), the user's Downloads (cloudflared*.exe, the
// newest), then PATH. TUNNEL=off in .env disables it.
// If cloudflared exits it is restarted (at most MAX_RESTARTS, backing off); the
// child is killed when the server stops.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const policy = require('./access-policy');

const ROOT = path.join(__dirname, '..', '..');
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const MAX_RESTARTS = 5;
const QUIET = /Thank you for trying|would like to|requires a login|terms of service|Cannot determine default configuration|config\.yml|Version|GOOS|Settings:|Generated Connector ID|Initial protocol|ICMP proxy|Starting metrics|metrics server/i;

let child = null;
let stopping = false;
let restarts = 0;
let publicUrl = null;
let savedAppUrl; // APP_PUBLIC_URL from .env, restored when the tunnel ends

// Files in `dir` matching `re`, newest first (missing folders: none).
function listMatching(dir, re) {
  try {
    return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch { return []; }
}

// Every place a Windows install of cloudflared commonly ends up, in search order.
function candidates(env = process.env) {
  const list = [env.CLOUDFLARED_EXE, path.join(ROOT, 'cloudflared.exe'), path.join(ROOT, 'scripts', 'cloudflared.exe')];
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.CommonProgramFiles, env['CommonProgramFiles(x86)']]) {
    if (base) list.push(path.join(base, 'cloudflared', 'cloudflared.exe'));
  }
  if (env.LOCALAPPDATA) {
    const winget = path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet');
    list.push(path.join(winget, 'Links', 'cloudflared.exe'));
    for (const dir of listMatching(path.join(winget, 'Packages'), /^Cloudflare\.cloudflared/i)) list.push(path.join(dir, 'cloudflared.exe'));
  }
  if (env.USERPROFILE) list.push(...listMatching(path.join(env.USERPROFILE, 'Downloads'), /^cloudflared.*\.exe$/i));
  return list.filter(Boolean);
}

function findExe() {
  return candidates().find((p) => fs.existsSync(p)) || 'cloudflared'; // PATH (spawn reports ENOENT if it is not there)
}

function box(url) {
  const rows = ['PUBLIC TUNNEL READY (Cloudflare)', url, 'Sign in there with your access token (LAN_ACCESS_TOKEN).', 'This address changes every time SignalDesk starts.'];
  const w = Math.max(...rows.map((r) => r.length)) + 2;
  console.log(`\n#${'='.repeat(w)}#\n${rows.map((r) => `# ${r.padEnd(w - 1)}#`).join('\n')}\n#${'='.repeat(w)}#\n`);
}

function onLine(line) {
  const text = line.replace(/^\S+Z\s+/, '').trim(); // drop cloudflared's own timestamp
  if (!text) return;
  const m = URL_RE.exec(text);
  if (m && m[0] !== publicUrl) {
    publicUrl = m[0];
    policy.addAllowedOrigin(publicUrl);
    if (savedAppUrl === undefined) savedAppUrl = process.env.APP_PUBLIC_URL || null;
    process.env.TUNNEL_PUBLIC_URL = publicUrl;
    process.env.APP_PUBLIC_URL = publicUrl;
    box(publicUrl);
    return;
  }
  if (/\b(ERR|WRN)\b/.test(text) || !QUIET.test(text)) console.log(`[tunnel] ${text.slice(0, 200)}`);
}

function launch(port) {
  const exe = findExe();
  const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
  console.log(`[tunnel] starting ${exe === 'cloudflared' ? 'cloudflared (PATH)' : exe} ${args.join(' ')}`);
  child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const read = (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(onLine);
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  child.on('error', (err) => {
    console.warn(err.code === 'ENOENT'
      ? '[tunnel] cloudflared not found (project folder, scripts/, Program Files, winget, Downloads or PATH): no public tunnel. Install it or set TUNNEL=off.'
      : `[tunnel] could not start cloudflared: ${err.message}`);
    stopping = true;
  });
  child.on('exit', (code) => {
    child = null;
    if (publicUrl) policy.removeAllowedOrigin(publicUrl);
    publicUrl = null;
    delete process.env.TUNNEL_PUBLIC_URL;
    if (savedAppUrl) process.env.APP_PUBLIC_URL = savedAppUrl; else delete process.env.APP_PUBLIC_URL;
    savedAppUrl = undefined;
    if (stopping) return;
    if (restarts >= MAX_RESTARTS) { console.warn(`[tunnel] cloudflared exited (code ${code}); giving up after ${MAX_RESTARTS} restarts`); return; }
    restarts += 1;
    const wait = Math.min(60, 5 * restarts);
    console.warn(`[tunnel] cloudflared exited (code ${code}); restarting in ${wait}s (${restarts}/${MAX_RESTARTS})`);
    setTimeout(() => { if (!stopping) launch(port); }, wait * 1000);
  });
}

function start(port) {
  if (String(process.env.TUNNEL || '').toLowerCase() === 'off') { console.log('[tunnel] TUNNEL=off: no public tunnel'); return; }
  if (policy.TOKEN_GENERATED) console.warn('[tunnel] no access token in .env: this run uses a generated token (printed above); set LAN_ACCESS_TOKEN to keep one across restarts');
  launch(port);
}

function stop() {
  stopping = true;
  if (child) { try { child.kill(); } catch { /* already gone */ } }
}

module.exports = { start, stop, url: () => publicUrl, candidates, findExe };
