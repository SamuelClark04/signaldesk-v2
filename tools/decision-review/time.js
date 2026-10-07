// New York session helpers for the Decision Review (Phase 93). Pure; reuses the app's DST-safe et-time.
const et = require('../../server/services/et-time');

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const MIN = 60 * 1000;
const DAY = 86400 * 1000;

const minuteOf = (ms) => { const p = et.parts(ms); return p.h * 60 + p.m; };
const ymd = (ms) => et.ymd(ms);
const at = (day, minute) => et.toEpoch(day, Math.floor(minute / 60), minute % 60); // a New York day + minute -> epoch ms
const inSession = (ms) => { const m = minuteOf(ms); const wd = new Date(at(ymd(ms), 12 * 60)).getUTCDay(); return wd > 0 && wd < 6 && m >= OPEN_MIN && m < CLOSE_MIN; };
const sessionClose = (day) => at(day, CLOSE_MIN);
const sessionOpen = (day) => at(day, OPEN_MIN);
// The calendar days after `day` (weekdays only; holidays are found from the data: a day without bars is skipped).
function nextWeekdays(day, n) {
  const out = []; let t = at(day, 12 * 60);
  while (out.length < n) { t += DAY; const wd = new Date(t).getUTCDay(); if (wd > 0 && wd < 6) out.push(ymd(t)); }
  return out;
}

module.exports = { et, OPEN_MIN, CLOSE_MIN, MIN, DAY, minuteOf, ymd, at, inSession, sessionClose, sessionOpen, nextWeekdays };
