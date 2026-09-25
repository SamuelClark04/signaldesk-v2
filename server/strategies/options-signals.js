// System 5 signals (Phase 57): the four CALL / PUT archetypes, on real daily bars,
// real 1-hour bars and today's 1-minute session (VWAP, opening range). Pure:
// bars in, signals out. 5-options-system.js turns a signal into a spread.
//   1 TREND (call)       close > 200-day SMA and a pullback to / reclaim of the
//                        rising 20- or 50-day SMA (daily RSI 45-68); or, on 1h, a
//                        reclaim of EMA21 / session VWAP with a rising 1h RSI 45-68
//   2 BREAKDOWN (put)    a rejection under a falling 20- / 50-day SMA or the 200-day,
//                        a break of the 10-day support floor, or on 1h a break
//                        under EMA21 / the opening-range low on >= 1.3x volume
//   3 SQUEEZE (call/put) Bollinger (20, 2 sd) inside Keltner (20, 1.5 ATR) on 1D or
//                        1h, then a break of the range high (call) / low (put) with
//                        an expanding bar
//   4 RELATIVE (call/put) the session move vs SPY >= +1.2% with 1h EMA9 > EMA21
//                        (leader: call), <= -1.2% with EMA9 < EMA21 (laggard: put)
// Each signal: { archetype, direction 'call'|'put', timeframe '1D'|'1h', horizon
// 'swing' (21-45 DTE) | 'intraday' (10-24 DTE), stop (underlying invalidation), text }.
const CONFIG = {
  touchPct: 0.01, reclaimDays: 3, nearPct: 0.03, slopeDays: 5, rsiBand: [45, 68], putRsiMax: 55, floorDays: 10, floorBreak: 0.002,
  bb: 20, bbSd: 2, kcAtr: 1.5, squeezeLookback: 5, rangeDays: 10, expand: 0.3, stopAtr: 0.25, squeezeStopAtr: 0.75,
  h: { ema: 21, fast: 9, minBars: 60, relVol: 1.3, volBars: 20, reclaimBars: 3, squeezeBars: 8, squeezeMin: 3, expand: 1.2, stopAtr: 0.5 },
  rs: { min: 0.012, stopAtr: 0.6 }, orMinutes: 30,
};

const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const sma = (xs, n) => (xs.length >= n ? avg(xs.slice(-n)) : null);
const ema = (xs, n) => xs.reduce((e, v, i) => (i === 0 ? v : v * (2 / (n + 1)) + e * (1 - 2 / (n + 1))), 0);
const cents = (x) => Math.round(x * 100) / 100;
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
function rsi(closes, n = 14) { // Wilder
  if (closes.length < n + 1) return null;
  let g = 0; let l = 0;
  for (let i = 1; i <= n; i += 1) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i += 1) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
const tr = (b, prev) => Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
const atr = (bars, n = 14) => (bars.length > n ? avg(bars.slice(-n).map((b, i, w) => tr(b, i ? w[i - 1].close : bars[bars.length - n - 1].close))) : null);

// Squeeze at bar i: Bollinger (p, sd) inside Keltner (p, kc x ATRp). { mean, sd, atr, on }.
function squeezeAt(bars, i, p = CONFIG.bb) {
  const w = bars.slice(i - p + 1, i + 1);
  const mean = avg(w.map((b) => b.close));
  const sd = Math.sqrt(avg(w.map((b) => (b.close - mean) ** 2)));
  const a = avg(w.map((b, k) => tr(b, bars[i - p + k].close)));
  return { mean, sd, atr: a, on: CONFIG.bbSd * sd < CONFIG.kcAtr * a };
}

// Daily squeeze state (proximity + signals): { mean, atr, rangeHigh, rangeLow, squeezeDays } or null.
function dailySqueeze(bars) {
  const n = bars.length;
  if (n < CONFIG.bb + CONFIG.squeezeLookback + 1) return null;
  let squeezeDays = 0;
  for (let i = n - CONFIG.squeezeLookback; i < n; i += 1) if (squeezeAt(bars, i).on) squeezeDays += 1;
  if (!squeezeDays) return null;
  const now = squeezeAt(bars, n - 1);
  const box = bars.slice(-CONFIG.rangeDays);
  return { mean: now.mean, atr: now.atr, rangeHigh: Math.max(...box.map((b) => b.high)), rangeLow: Math.min(...box.map((b) => b.low)), squeezeDays };
}

// Daily context + the 1D signals. bars: completed sessions; live: the price now (or the last close).
function daily(bars, live) {
  const n = bars.length;
  if (n < 60) return { ctx: null, signals: [], why: `only ${n} daily sessions` };
  const closes = bars.map((b) => b.close);
  const s20 = sma(closes, 20); const s50 = sma(closes, 50); const s200 = sma(closes, 200);
  const prev20 = sma(closes.slice(0, -CONFIG.slopeDays), 20); const prev50 = sma(closes.slice(0, -CONFIG.slopeDays), 50);
  const a = atr(bars, 14);
  const r = rsi([...closes, live]);
  const recent = bars.slice(-CONFIG.reclaimDays);
  const ctx = { s20, s50, s200, atr: a, rsi: r, high30: Math.max(...bars.slice(-30).map((b) => b.high)), high100: Math.max(...bars.slice(-100).map((b) => b.high)),
    low30: Math.min(...bars.slice(-30).map((b) => b.low)), low100: Math.min(...bars.slice(-100).map((b) => b.low)) };
  const out = [];
  const lowStop = Math.min(...recent.map((b) => b.low)) - CONFIG.stopAtr * a;
  const highStop = Math.max(...recent.map((b) => b.high)) + CONFIG.stopAtr * a;
  if (s200 && live > s200 && r >= CONFIG.rsiBand[0] && r <= CONFIG.rsiBand[1]) {
    for (const [name, m, rising] of [['20-day', s20, s20 > prev20], ['50-day', s50, s50 > prev50]]) {
      const reclaim = recent.some((b) => b.close < m) && live > m;
      const pullback = rising && recent.some((b) => b.low <= m * (1 + CONFIG.touchPct)) && live > m && live <= m * (1 + CONFIG.nearPct);
      if (!reclaim && !pullback) continue;
      out.push({ archetype: 'TREND', direction: 'call', timeframe: '1D', horizon: 'swing', stop: lowStop,
        text: `${reclaim ? 'Reclaimed' : 'Pulled back to'} the ${rising ? 'rising' : ''} ${name} SMA ${cents(m)} above the 200-day ${cents(s200)} (daily RSI ${r.toFixed(0)})` });
      break;
    }
  }
  for (const [name, m, falling] of [['20-day', s20, s20 < prev20], ['50-day', s50, s50 < prev50], ['200-day', s200, true]]) {
    if (!m || !falling || !(r <= CONFIG.putRsiMax)) continue;
    if (recent.some((b) => b.high >= m * 0.995) && live < m && live >= m * (1 - CONFIG.nearPct * 1.5)) {
      out.push({ archetype: 'BREAKDOWN', direction: 'put', timeframe: '1D', horizon: 'swing', stop: highStop,
        text: `Rejected under the ${name === '200-day' ? '' : 'falling '}${name} SMA ${cents(m)} (daily RSI ${r.toFixed(0)})` });
      break;
    }
  }
  const floor = Math.min(...bars.slice(-CONFIG.floorDays - 1, -1).map((b) => b.low));
  if (live < floor * (1 - CONFIG.floorBreak) && bars[n - 1].close >= floor * (1 - CONFIG.floorBreak)) {
    out.push({ archetype: 'BREAKDOWN', direction: 'put', timeframe: '1D', horizon: 'swing', stop: floor + 0.5 * a, text: `Broke the ${CONFIG.floorDays}-day support floor ${cents(floor)}` });
  }
  const sq = dailySqueeze(bars);
  const expanding = Math.abs(live - bars[n - 1].close) >= CONFIG.expand * a || bars[n - 1].high - bars[n - 1].low >= a;
  if (sq && expanding && live > sq.rangeHigh && live > sq.mean) {
    out.push({ archetype: 'SQUEEZE', direction: 'call', timeframe: '1D', horizon: 'swing', stop: sq.rangeHigh - CONFIG.squeezeStopAtr * sq.atr,
      text: `Daily squeeze (${sq.squeezeDays}/${CONFIG.squeezeLookback} days) breaking above the ${CONFIG.rangeDays}-day high ${cents(sq.rangeHigh)}` });
  } else if (sq && expanding && live < sq.rangeLow && live < sq.mean) {
    out.push({ archetype: 'SQUEEZE', direction: 'put', timeframe: '1D', horizon: 'swing', stop: sq.rangeLow + CONFIG.squeezeStopAtr * sq.atr,
      text: `Daily squeeze (${sq.squeezeDays}/${CONFIG.squeezeLookback} days) breaking below the ${CONFIG.rangeDays}-day low ${cents(sq.rangeLow)}` });
  }
  return { ctx, signals: out, why: null };
}

// Today's regular session from 1-minute bars ({ time ISO, open, high, low, close, volume }):
// { vwap, orHigh, orLow, low, high, minutes } or null (no session: market closed / not streamed).
const etParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function session(bars1m, now = Date.now()) {
  const et = (t) => { const p = Object.fromEntries(etParts.formatToParts(new Date(t)).map((x) => [x.type, x.value])); return { d: `${p.year}-${p.month}-${p.day}`, m: Number(p.hour) * 60 + Number(p.minute) }; };
  const today = et(now).d;
  const rth = (bars1m || []).map((b) => ({ ...b, et: et(b.time) })).filter((b) => b.et.d === today && b.et.m >= 570 && b.et.m < 960);
  if (!rth.length) return null;
  // Running VWAP, bar by bar: did price close under it during the last hour?
  let pv = 0; let v = 0; let belowVwapRecently = false;
  rth.forEach((b, i) => {
    pv += ((b.high + b.low + b.close) / 3) * (b.volume || 0); v += b.volume || 0;
    if (i >= rth.length - 60 && v > 0 && b.close < pv / v) belowVwapRecently = true;
  });
  const or = rth.filter((b) => b.et.m < 570 + CONFIG.orMinutes);
  return { vwap: v > 0 ? pv / v : null, belowVwapRecently,
    orHigh: or.length ? Math.max(...or.map((b) => b.high)) : null, orLow: or.length ? Math.min(...or.map((b) => b.low)) : null,
    orDone: rth[rth.length - 1].et.m >= 570 + CONFIG.orMinutes, low: Math.min(...rth.map((b) => b.low)), high: Math.max(...rth.map((b) => b.high)), minutes: rth.length };
}

// 1h (+ session) signals. hb: completed 1h bars; dctx: daily context; sess: session() or null.
function hourly(hb, live, dctx, sess) {
  const H = CONFIG.h;
  if (!dctx || hb.length < H.minBars) return [];
  const n = hb.length;
  const closes = hb.map((b) => b.close);
  const e21 = ema(closes, H.ema); const e9 = ema(closes, H.fast);
  const rNow = rsi([...closes, live]); const rPrev = rsi(closes);
  const ha = atr(hb, 14);
  const relVol = hb[n - 1].volume / (avg(hb.slice(-H.volBars - 1, -1).map((b) => b.volume)) || 1);
  const out = [];
  const recent = hb.slice(-H.reclaimBars);
  if (dctx.s200 && live > dctx.s200 && rNow >= CONFIG.rsiBand[0] && rNow <= CONFIG.rsiBand[1] && rNow > rPrev) {
    const emaReclaim = recent.some((b) => b.close < e21) && live > e21;
    const vwapReclaim = sess && sess.vwap && sess.belowVwapRecently && live > sess.vwap;
    if (emaReclaim || vwapReclaim) {
      out.push({ archetype: 'TREND', direction: 'call', timeframe: '1h', horizon: 'intraday', stop: Math.min(...recent.map((b) => b.low)) - H.stopAtr * ha,
        text: `Reclaimed ${emaReclaim ? `the 1h EMA21 ${cents(e21)}` : `session VWAP ${cents(sess.vwap)}`} above the 200-day SMA, 1h RSI rising to ${rNow.toFixed(0)}` });
    }
  }
  const emaBreak = recent.some((b) => b.close > e21) && live < e21 * 0.999;
  const orBreak = sess && sess.orDone && sess.orLow && live < sess.orLow;
  if ((emaBreak || orBreak) && relVol >= H.relVol) {
    out.push({ archetype: 'BREAKDOWN', direction: 'put', timeframe: '1h', horizon: 'intraday', stop: Math.max(...recent.map((b) => b.high), orBreak ? sess.orHigh : 0) + H.stopAtr * ha,
      text: `Broke under ${orBreak ? `the opening-range low ${cents(sess.orLow)}` : `the 1h EMA21 ${cents(e21)}`} on ${relVol.toFixed(1)}x 1h volume` });
  }
  let on = 0;
  for (let i = n - H.squeezeBars; i < n; i += 1) if (i >= CONFIG.bb && squeezeAt(hb, i).on) on += 1;
  const box = hb.slice(-H.squeezeBars);
  const expanding = hb[n - 1].high - hb[n - 1].low >= H.expand * avg(hb.slice(-21, -1).map((b) => b.high - b.low));
  if (on >= H.squeezeMin && expanding) {
    const hi = Math.max(...box.map((b) => b.high)); const lo = Math.min(...box.map((b) => b.low));
    if (live > hi) out.push({ archetype: 'SQUEEZE', direction: 'call', timeframe: '1h', horizon: 'intraday', stop: lo, text: `1h squeeze (${on}/${H.squeezeBars} bars) breaking above ${cents(hi)}` });
    else if (live < lo) out.push({ archetype: 'SQUEEZE', direction: 'put', timeframe: '1h', horizon: 'intraday', stop: hi, text: `1h squeeze (${on}/${H.squeezeBars} bars) breaking below ${cents(lo)}` });
  }
  return out.map((s) => ({ ...s, e9, e21 }));
}

// Relative strength / weakness vs SPY on the session: change = live / prevClose - 1.
function relative(change, benchChange, hb, live, dctx) {
  if (!dctx || !Number.isFinite(change) || !Number.isFinite(benchChange) || hb.length < 30) return [];
  const closes = hb.map((b) => b.close);
  const e9 = ema(closes, CONFIG.h.fast); const e21 = ema(closes, CONFIG.h.ema);
  const diff = change - benchChange;
  if (diff >= CONFIG.rs.min && e9 > e21) {
    return [{ archetype: 'RELATIVE', direction: 'call', timeframe: '1h', horizon: 'intraday', stop: live - CONFIG.rs.stopAtr * dctx.atr,
      text: `Relative-strength leader: ${pct(change)} on the session vs SPY ${pct(benchChange)} (${pct(diff)}), 1h EMA9 > EMA21` }];
  }
  if (diff <= -CONFIG.rs.min && e9 < e21) {
    return [{ archetype: 'RELATIVE', direction: 'put', timeframe: '1h', horizon: 'intraday', stop: live + CONFIG.rs.stopAtr * dctx.atr,
      text: `Relative-weakness laggard: ${pct(change)} on the session vs SPY ${pct(benchChange)} (${pct(diff)}), 1h EMA9 < EMA21` }];
  }
  return [];
}

// Priority when several fire (daily structure first). A symbol with both call and
// put signals is conflicted: no trade.
const RANK = ['1D:SQUEEZE', '1D:TREND', '1D:BREAKDOWN', '1h:SQUEEZE', '1h:TREND', '1h:BREAKDOWN', '1h:RELATIVE'];
function rank(signals) {
  const dirs = new Set(signals.map((s) => s.direction));
  if (dirs.size > 1) return { conflict: true, list: [] };
  return { conflict: false, list: [...signals].sort((a, b) => RANK.indexOf(`${a.timeframe}:${a.archetype}`) - RANK.indexOf(`${b.timeframe}:${b.archetype}`)) };
}

// All signals for one symbol. input: { bars, live, hourly (1h bars), session1m, change, benchChange }.
function detect({ bars, live, hourlyBars, session1m, change, benchChange, now = Date.now() }) {
  const d = daily(bars, live);
  if (!d.ctx) return { ctx: null, signals: [], why: d.why };
  const sess = session(session1m, now);
  const signals = [...d.signals, ...hourly(hourlyBars || [], live, d.ctx, sess), ...relative(change, benchChange, hourlyBars || [], live, d.ctx)];
  return { ctx: { ...d.ctx, session: sess }, signals, why: signals.length ? null : 'No call or put archetype fired' };
}

module.exports = { detect, daily, hourly, relative, session, rank, dailySqueeze, squeezeAt, rsi, atr, ema, sma, CONFIG, RANK };
