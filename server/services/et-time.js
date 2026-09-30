// New York (ET) calendar helpers (Phase 81). Every comparison in the entry shields is done in epoch ms; ET is used
// only to name a calendar day and to turn a published "8:30 AM ET" into an instant (DST-correct, never the VM's zone).
const FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const memo = new Map();

// -> { ymd: 'YYYY-MM-DD', h, m } in New York for an instant (memoized per minute).
function parts(ms) {
  const k = Math.floor(ms / 60000);
  const hit = memo.get(k);
  if (hit) return hit;
  const p = Object.fromEntries(FMT.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const out = { ymd: `${p.year}-${p.month}-${p.day}`, h: Number(p.hour) % 24, m: Number(p.minute) };
  if (memo.size > 2000) memo.clear();
  memo.set(k, out);
  return out;
}

// 'YYYY-MM-DD' + an ET wall-clock time -> epoch ms (EDT is UTC-4, EST UTC-5: the offset whose result reads back right).
function toEpoch(ymd, h = 0, m = 0) {
  const [y, mo, d] = ymd.split('-').map(Number);
  for (const off of [4, 5]) {
    const t = Date.UTC(y, mo - 1, d, h + off, m);
    const p = parts(t);
    if (p.ymd === ymd && p.h === h && p.m === m) return t;
  }
  return Date.UTC(y, mo - 1, d, h + 5, m); // a DST-gap time (never used by releases): EST
}

const ymd = (ms) => parts(ms).ymd;
const dayStart = (ms) => toEpoch(ymd(ms), 0, 0);
const clock = (ms) => { const p = parts(ms); return `${p.h % 12 || 12}:${String(p.m).padStart(2, '0')} ${p.h < 12 ? 'AM' : 'PM'} ET`; };

module.exports = { parts, toEpoch, ymd, dayStart, clock };
