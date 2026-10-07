// Phase 95 Task 1.1: the collector's own Alpaca request limiter (plan 5.2 / 9.5). Alpaca allows 200 data requests a minute PER
// ACCOUNT, shared with the trading server and the PC job, so the collector holds itself to a ceiling (default 40 / min, set from the
// measured server usage) and stands back for 2 minutes after any HTTP 429, so the trading server keeps priority.
//   acquire()      resolves when one request may go out (a sliding 60 s window; never throws)
//   report(status) after each response: a 429 starts the pause
//   stats()        { perMin, usedLastMin, total, r429, pausedUntil }
function createLimiter({ perMin = 40, pauseMs = 120000, now = () => Date.now(), sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }) } = {}) {
  const sent = []; // times of the requests in the last 60 s, oldest first
  let total = 0; let r429 = 0; let pausedUntil = 0;
  const trim = () => { while (sent.length && now() - sent[0] >= 60000) sent.shift(); };

  async function acquire() {
    for (;;) {
      trim();
      if (now() < pausedUntil) { await sleep(pausedUntil - now()); continue; }
      if (sent.length < perMin) { sent.push(now()); total += 1; return true; }
      await sleep(Math.max(1, 60000 - (now() - sent[0])));
    }
  }
  function report(status) { if (status === 429) { r429 += 1; pausedUntil = now() + pauseMs; } }
  const stats = () => { trim(); return { perMin, usedLastMin: sent.length, total, r429, pausedUntil: pausedUntil > now() ? pausedUntil : null }; };
  return { acquire, report, stats };
}

module.exports = { createLimiter };
