// Is the US equity market in its regular session right now? (Phase 59B)
// A missing live price is NOT evidence the market is closed: a stock past the
// 30-symbol stream cap, or a quiet feed, has none mid-session. So "MARKET CLOSED"
// (after-hours options plans, their banner, the scan status) reads this instead.
//   Authority  Alpaca's /v2/clock (holidays, 1 pm early closes), refreshed every
//              CLOCK_MS once start() runs, and rolled forward between refreshes
//              with its own next_open / next_close
//   Fallback   no clock (no keys, offline, unit tests): Mon-Fri 09:30-16:00
//              America/New_York
const CLOCK_MS = 5 * 60 * 1000;
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

let clock = null; // { at, isOpen, nextOpen, nextClose }
let timer = null;
let lastError = null;

const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const etDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
function et(now) {
  const p = Object.fromEntries(etFmt.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, minute: Number(p.hour) * 60 + Number(p.minute) };
}

// Mon-Fri 09:30-16:00 ET (no holiday calendar: that is the clock's job).
function byHours(now = Date.now()) {
  const t = et(now);
  return t.weekday !== 'Sat' && t.weekday !== 'Sun' && t.minute >= OPEN_MIN && t.minute < CLOSE_MIN;
}

// The clock's answer at `now`, or null when there is no clock reading near `now`.
function byClock(now) {
  if (!clock || Math.abs(now - clock.at) > 3 * CLOCK_MS) return null;
  if (clock.isOpen) return !(clock.nextClose && now >= clock.nextClose);
  return !!(clock.nextOpen && now >= clock.nextOpen && (!clock.nextClose || now < clock.nextClose));
}

function isEquityMarketOpen(now = Date.now()) {
  const c = byClock(now);
  return c === null ? byHours(now) : c;
}

// Today's 09:30 ET in ms (the session's first bar).
function sessionOpenMs(now = Date.now()) {
  const d = etDay.format(new Date(now));
  for (const off of [4, 5]) {
    const t = Date.parse(`${d}T${String(9 + off).padStart(2, '0')}:30:00Z`);
    if (et(t).minute === OPEN_MIN) return t;
  }
  return now;
}

async function refresh() {
  const r = await require('../connectors/alpaca-api').getClock();
  if (!r.ok) {
    if (r.error !== lastError) console.warn(`[session] market clock unavailable (using ET hours): ${r.error}`);
    lastError = r.error;
    return;
  }
  lastError = null;
  const was = clock && clock.isOpen;
  clock = { at: Date.now(), isOpen: r.isOpen, nextOpen: r.nextOpen, nextClose: r.nextClose };
  if (was !== r.isOpen) console.log(`[session] US equities ${r.isOpen ? 'OPEN' : 'CLOSED'} (Alpaca clock; next ${r.isOpen ? 'close' : 'open'} ${new Date(r.isOpen ? r.nextClose : r.nextOpen).toISOString()})`);
}

function start() {
  if (timer) return;
  refresh().catch(() => {});
  timer = setInterval(() => refresh().catch(() => {}), CLOCK_MS);
  timer.unref();
}
function stop() { clearInterval(timer); timer = null; }

// For SCAN_STATUS (clients label "market closed" from this, never from a missing price).
function status(now = Date.now()) {
  const c = byClock(now);
  return { open: c === null ? byHours(now) : c, source: c === null ? 'ET hours' : 'Alpaca clock', nextOpen: clock ? clock.nextOpen : null, nextClose: clock ? clock.nextClose : null };
}

// Tests: pin (or clear) the clock reading.
const setClock = (c) => { clock = c ? { at: Date.now(), ...c } : null; };

module.exports = { isEquityMarketOpen, byHours, sessionOpenMs, status, start, stop, refresh, setClock, CLOCK_MS };
