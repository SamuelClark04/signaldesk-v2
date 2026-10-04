// Options Quick Flips: failure alerts for positions that are still open past their deadline (Phase 89c). A re-priced limit order
// does NOT guarantee a same-day close (the paper broker may reject it, never fill it, or the market may close first), so every
// Quick Flip still open after its deadline stays monitored and is REPORTED, never silently carried:
//   warn      still open DEADLINE_ALERT_MS (5 min) after its 3:40 PM deadline (with the closing order's state and the last error)
//   critical  still open after the session closed / on a later New York day (held overnight: it is closed at the next session)
// Shown in the entry-shield banner (entry-shields.status -> client shield-banner), logged once a minute, and emailed once per
// position per level (notifier.sendOperationalAlert; console when SMTP is not set). Pure state + notify; no orders here.
const et = require('../services/et-time');

const DEADLINE_ALERT_MS = 5 * 60 * 1000;
const failures = new Map(); // position id -> { at, error, attempts }
const notified = new Map(); // position id -> 'warn' | 'critical'
const logged = new Map(); // position id -> last console line (ms)
let current = [];

// The epoch ms of a position's deadline: deadlineMin (3:40 PM) on the New York day it was opened (or staged).
function deadlineAt(p) {
  const q = (p.optionsData && p.optionsData.quickFlip) || {};
  const min = q.deadlineMin || 940;
  return et.toEpoch(et.ymd(p.openedAt || p.stagedAt || Date.now()), Math.floor(min / 60), min % 60);
}

function recordFailure(id, error, now = Date.now()) {
  const f = failures.get(id) || { attempts: 0 };
  failures.set(id, { at: now, error: String(error).slice(0, 240), attempts: f.attempts + 1 });
}
const clearFailure = (id) => failures.delete(id);

// Re-measure the alerts. positions: open positions; marketOpen: the US session now. -> the alert list (also kept for status()).
function refresh(positions, { now = Date.now(), marketOpen = true, notify = null } = {}) {
  const isQf = (p) => p && p.strategyId === 'options-quickflips' && p.market === 'options' && p.execution !== 'LIVE';
  const open = positions.filter(isQf);
  const out = [];
  for (const p of open) {
    const dl = deadlineAt(p);
    const overnight = et.ymd(now) !== et.ymd(dl) || (!marketOpen && now >= dl);
    const level = overnight ? 'critical' : now >= dl + DEADLINE_ALERT_MS ? 'warn' : null;
    if (!level) continue;
    const w = p.exitWork || {}; const f = failures.get(p.id);
    const state = p.fillEstimated ? 'entry order still working (cancel pending)' : p.paperExitOrderId && w.kind === 'exit'
      ? `closing limit ${w.limit} working since ${et.clock(w.placedAt || now)}${w.urgent ? ` (re-priced ${Math.round(w.urgent * 100)}% under the bid)` : ''}` : 'no closing order working';
    const a = { id: p.id, asset: p.asset, contract: p.optionsData && p.optionsData.contract, level, deadline: dl, deadlineClock: et.clock(dl), state,
      lastError: f ? f.error : null, attempts: f ? f.attempts : 0, since: now,
      text: level === 'critical'
        ? `QUICK FLIP HELD OVERNIGHT: ${p.asset} ${p.optionsData && p.optionsData.label} was not closed by its ${et.clock(dl)} deadline (${state}${f ? `; last error: ${f.error}` : ''}). It stays monitored and is closed at the next session.`
        : `QUICK FLIP NOT CLOSED: ${p.asset} ${p.optionsData && p.optionsData.label} is still open past its ${et.clock(dl)} deadline (${state}${f ? `; last error: ${f.error}` : ''}). ${p.paperExitOrderId && w.kind === 'exit' ? 'The close keeps being re-priced.' : 'The close is retried every 20 s.'}` };
    out.push(a);
    if (now - (logged.get(p.id) || 0) >= 60000) { console.error(`[quickflips] ALERT ${a.text}`); logged.set(p.id, now); }
    const rank = { warn: 1, critical: 2 };
    if (notify && (rank[notified.get(p.id)] || 0) < rank[level]) {
      notified.set(p.id, level);
      Promise.resolve().then(() => notify({ subject: `[SignalDesk] ${level === 'critical' ? 'Quick Flip held overnight' : 'Quick Flip not closed by its deadline'}: ${p.asset}`, text: a.text })).catch(() => {});
    }
  }
  for (const id of [...notified.keys()]) if (!open.some((p) => p.id === id)) { notified.delete(id); failures.delete(id); logged.delete(id); }
  current = out;
  return out;
}

const alerts = () => current.map((a) => ({ ...a }));
const reset = () => { failures.clear(); notified.clear(); logged.clear(); current = []; sent = '[]'; };

// The banner: ENTRY_SHIELDS re-broadcast whenever the alert list changes (display only; called by exit-pass after each Quick Flips run,
// so no exit module references the entry shields: Phase 81's rule). statusOf(settings) defaults to the entry shields' status.
let sent = '[]';
function publish(broadcast, settings, statusOf = (s) => require('../risk/entry-shields').status(s)) {
  const list = JSON.stringify(current.map((a) => [a.id, a.level, a.state, a.lastError]));
  if (list === sent) return false;
  sent = list;
  try { broadcast('ENTRY_SHIELDS', statusOf(settings)); } catch { /* next pass */ }
  return true;
}

module.exports = { refresh, alerts, publish, recordFailure, clearFailure, deadlineAt, reset, DEADLINE_ALERT_MS };
