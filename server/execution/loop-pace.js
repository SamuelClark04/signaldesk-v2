// Cooperative scheduling for low-vCPU hosts (Phase 72). Node runs the scanner, the live WebSocket
// ticks and the HTTP chart requests on ONE thread, and an `await` on data that is already cached
// resumes as a microtask, which never lets socket / timer / HTTP callbacks in. A pass over ~180
// symbols could therefore hold the thread for seconds on a 0.25 vCPU VM (frozen charts and prices,
// "[stock-poller] timed out after 8s", WebSocket 1006 disconnects, "previous pass still running").
//   pace()             awaited once per symbol by every scan loop: after SLICE_MS of uninterrupted
//                      work it yields (setImmediate: queued I/O and timers run first; or a PAUSE_MS
//                      pause when set). Near free when there is nothing to yield for.
//   during(name, fn)   run fn with `name` as the current stage (named in the stall warning)
//   watch()            a 250 ms heartbeat: a stall of STALL_WARN_MS or more logs
//                      "[loop] event loop blocked 1.8 s (during equity-day)"
// Env: SCAN_SLICE_MS (default 10), SCAN_PAUSE_MS (default 0; e.g. 5 on an e2-micro),
// LOOP_STALL_WARN_MS (default 1000).
const { performance } = require('perf_hooks');

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
const SLICE_MS = num(process.env.SCAN_SLICE_MS, 10);
const PAUSE_MS = num(process.env.SCAN_PAUSE_MS, 0);
const STALL_WARN_MS = num(process.env.LOOP_STALL_WARN_MS, 1000);
const TICK_MS = 250;

let sliceStart = performance.now();
let current = 'idle';
let timer = null;
const counts = { yields: 0, stalls: 0, worstMs: 0, worstStage: null };

const breathe = () => new Promise((r) => { if (PAUSE_MS > 0) setTimeout(r, PAUSE_MS); else setImmediate(r); });

async function pace() {
  checkAlive(); // Phase 73: an abandoned pass stops here
  if (performance.now() - sliceStart < SLICE_MS) return;
  counts.yields += 1;
  await breathe();
  sliceStart = performance.now();
}

// Every stage that ran since the last heartbeat: a stall is only seen AFTER the blocking code
// returned, so the stage current at that moment may already be the next one (or 'idle').
let seen = new Set();
async function during(name, fn) {
  checkAlive();
  const prev = current;
  current = name;
  seen.add(name);
  try { return await fn(); } finally { current = prev; }
}

function watch() {
  if (timer) return;
  let last = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    const lag = now - last - TICK_MS;
    last = now;
    const stages = [...seen].join(', ') || current;
    seen = new Set(current === 'idle' ? [] : [current]);
    if (lag < STALL_WARN_MS) return;
    counts.stalls += 1;
    if (lag > counts.worstMs) Object.assign(counts, { worstMs: Math.round(lag), worstStage: stages });
    console.warn(`[loop] event loop blocked ${(lag / 1000).toFixed(1)} s (during ${stages}); on a low-vCPU VM set SCAN_PAUSE_MS=5 in .env if this repeats`);
  }, TICK_MS);
  timer.unref();
}

const stats = () => ({ ...counts, sliceMs: SLICE_MS, pauseMs: PAUSE_MS });

// ---------- Pass watchdog (Phase 73) ----------
// A pipeline pass runs inside inPass() (its own async context). watchdog() gives it PASS_WATCHDOG_MS: past
// that the lock is released (the next tick runs a NEW pass) and the stalled one is abandoned: its next
// pace() / during() throws PASS_ABANDONED, so it never stages a setup or runs exits next to the new pass.
const { AsyncLocalStorage } = require('async_hooks');
const PASS_WATCHDOG_MS = num(process.env.PASS_WATCHDOG_MS, 45000);
const passCtx = new AsyncLocalStorage();
let currentPass = 0;
const inPass = (fn) => { const gen = ++currentPass; return passCtx.run({ gen }, fn); };
// Only a pass the watchdog RELEASED is abandoned (Phase 75): a strategy still finishing a finished pass's work in the
// background (strategy-runner's budget) keeps running when the next pass starts.
const dead = new Set();
const abandoned = () => { const s = passCtx.getStore(); return !!s && dead.has(s.gen); };
function checkAlive() { if (abandoned()) throw Object.assign(new Error('PASS_ABANDONED: the watchdog released this pass'), { code: 'PASS_ABANDONED' }); }
async function watchdog(pass, ms = PASS_WATCHDOG_MS) {
  let timer;
  const late = new Promise((r) => { timer = setTimeout(() => r(TIMED_OUT), ms); });
  pass.catch(() => {}); // an abandoned pass's PASS_ABANDONED is expected
  try {
    const r = await Promise.race([pass, late]);
    if (r !== TIMED_OUT) return r;
    dead.add(currentPass); // the stalled pass stops at its next pace()
    if (dead.size > 100) dead.delete(dead.values().next().value);
    console.warn(`[pipeline] pass exceeded ${ms >= 10000 ? Math.round(ms / 1000) : (ms / 1000).toFixed(1)} s (during ${[...seen].join(', ') || current}); lock released, the stalled pass is abandoned at its next step`);
    return { timedOut: true };
  } finally { clearTimeout(timer); }
}
const TIMED_OUT = Symbol('timed out');

module.exports = { pace, during, watch, stats, inPass, watchdog, checkAlive, abandoned, SLICE_MS, PAUSE_MS, PASS_WATCHDOG_MS };
