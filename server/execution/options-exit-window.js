// Options exit window (Phase 82): automated option stops / targets only trade while spreads are tight.
//   Window    9:35 AM - 3:45 PM ET on a trading day (epoch ms against New York time: services/et-time.js). Market makers
//             widen option quotes in the first minutes and the last 15 minutes: a stop sold into that paid -1.78R on GOOGL.
//   Deferral  a stop or target that triggers while the market is open but OUTSIDE the window (3:45-4:00 PM, 9:30-9:35 AM)
//             is saved on the position (p.deferredExit { reason, at }, persisted) and executed at the next 9:35 AM ET,
//             whatever the price then (the stop was hit: the plan is to be out). Signals while the market is closed are
//             ignored (overnight marks are models on extended-hours prints); the 9:35 check re-evaluates on real quotes.
//   Scope     every automated premium exit (exit-monitor.premiumExit: the internal paper ledger and Alpaca Paper).
//             Manual [Close] never passes through here: it works at any time.
const et = require('../services/et-time');
const session = require('../market/market-session');

const OPEN_MIN = 9 * 60 + 35;
const CUTOFF_MIN = 15 * 60 + 45;
const minutes = (now) => { const p = et.parts(now); return p.h * 60 + p.m; };

// Inside 9:35 AM - 3:45 PM ET on an open market day.
const inWindow = (now = Date.now()) => session.isEquityMarketOpen(now) && minutes(now) >= OPEN_MIN && minutes(now) < CUTOFF_MIN;

function defer(pos, reason, now) {
  const ledger = require('./paper-ledger');
  const n = ledger.updatePositions((p) => { if (p.id !== pos.id || p.deferredExit) return false; p.deferredExit = { reason, at: now }; return true; });
  if (n) console.warn(`[options-exit] ${pos.id}: ${reason} at ${et.clock(now)} is outside the 9:35 AM - 3:45 PM ET window (option quotes too wide); held, sold at 9:35 AM ET`);
}

// premiumExit's verdict (a reason or null) -> the reason to close NOW, or null.
function gate(pos, reason, now = Date.now()) {
  if (inWindow(now)) return (pos.deferredExit && pos.deferredExit.reason) || reason; // 9:35: the held exit goes first
  if (reason && !pos.deferredExit && session.isEquityMarketOpen(now)) defer(pos, reason, now);
  return null;
}

// "Stop hit 3:52 PM ET: sold at 9:35 AM ET" (UI / logs), or null.
const describe = (p) => (p && p.deferredExit ? `${p.deferredExit.reason === 'STOP_LOSS' ? 'Stop' : 'Target'} hit ${et.clock(p.deferredExit.at)} after the 3:45 PM cutoff: exits at 9:35 AM ET` : null);

module.exports = { inWindow, gate, describe, OPEN_MIN, CUTOFF_MIN };
