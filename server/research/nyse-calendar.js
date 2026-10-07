// Phase 95: the NYSE session calendar for the research code (moved here from tools/event-research/inspect.js so the VM collector and
// the PC tools share one list). Full closures and 1 PM early closes from nyse.com/markets/hours-calendars (checked 2026-10-06).
// Extend yearly; a date outside CALENDAR_YEARS is reported by inspect.js.
const et = require('../services/et-time');

const NYSE_HOLIDAYS = new Set(['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24']);
const NYSE_EARLY_CLOSES = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);
const CALENDAR_YEARS = [2026, 2027];
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

const weekday = (ymd) => { const wd = new Date(`${ymd}T12:00:00Z`).getUTCDay(); return wd > 0 && wd < 6; };
const isSessionDay = (ymd) => weekday(ymd) && !NYSE_HOLIDAYS.has(ymd);
const closeMinOf = (ymd) => (NYSE_EARLY_CLOSES.has(ymd) ? 13 * 60 : CLOSE_MIN);
// Is the regular session open at `ms`? (calendar-based: no network, no broker clock)
function isOpen(ms = Date.now()) {
  const p = et.parts(ms); const m = p.h * 60 + p.m;
  return isSessionDay(p.ymd) && m >= OPEN_MIN && m < closeMinOf(p.ymd);
}

module.exports = { NYSE_HOLIDAYS, NYSE_EARLY_CLOSES, CALENDAR_YEARS, OPEN_MIN, CLOSE_MIN, isSessionDay, closeMinOf, isOpen };
