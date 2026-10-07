// Phase 93 decision inputs in the strategies (required by tests/ph93unit.js): the capture is RECORD-ONLY, so the candidates are
// identical with it on and off; a fresh ORB breakout keeps its inputs; a filtered breakout is a STRATEGY_BLOCK with them.
module.exports = async ({ S, check, rec, dc, readLines, wipe, T }) => {
  T.reset(); T.setClock(null); wipe(); dc.clear();
  const et = require(S + 'services/et-time');
  const orb = require(S + 'strategies/1-equity-day');
  const DAY = '2026-10-02';
  const mk = (base, breakoutVol, lastClose) => {
    const out = [];
    for (let m = 570; m <= 589; m += 1) {
      const inOr = m < 585;
      const c = inOr ? base + ((m % 3) - 1) * 0.1 : base + 0.3 + (m - 585) * (lastClose - base - 0.3) / 4;
      out.push({ time: new Date(et.toEpoch(DAY, Math.floor(m / 60), m % 60)).toISOString(), open: c - 0.02, high: inOr ? Math.min(c + 0.15, base + 0.3) : c + 0.03, low: c - 0.15, close: c, volume: inOr ? 1000 : breakoutVol });
    }
    return out;
  };
  const gate = require(S + 'risk/reality-gate'); const realAtr = gate.dailyAtr;
  gate.dailyAtr = () => 5; // the cached daily ATR the T1 check reads (no daily bars in this test)
  const data = new Map([['AAPL', mk(100, 3000, 100.65)], ['LOWV', mk(50, 900, 50.4)], ['SPY', mk(600, 3000, 600.7)]]);
  const run = async () => (await orb.generateCandidates(data, {})).map((c) => ({ ...c, timestamp: null }));
  const withCapture = await run();
  const realCapture = dc.capture; const realBlock = dc.block;
  dc.capture = () => false; dc.block = () => false;
  const without = await run();
  dc.capture = realCapture; dc.block = realBlock; gate.dailyAtr = realAtr;
  check('ORB candidates are byte-identical with the decision-input capture on and off (record-only)', withCapture.length >= 1 && JSON.stringify(withCapture) === JSON.stringify(without),
    `${withCapture.map((c) => c.asset).join(',')} vs ${without.map((c) => c.asset).join(',')}`);
  const aapl = withCapture.find((c) => c.asset === 'AAPL');
  const ctx = aapl && dc.get(aapl.id);
  check('a fresh ORB breakout keeps ALL its inputs beside the candidate: session 1m bars, SPY bars, daily bars + the signal values', ctx && ctx.series.map((s) => s.name).join() === 'session1m,spySession1m,daily'
    && ctx.series[0].bars.length === 20 && ctx.values.orHigh > 0 && ctx.values.volumeRatio > 1.5 && ctx.values.entryMax === aapl.entryZone.max && !('decisionContext' in aapl), JSON.stringify(ctx && ctx.values));
  await rec.flush();
  const blk = readLines().find((x) => x.type === 'decision' && x.path === 'STRATEGY_BLOCK' && /LOWV/.test(x.id));
  check('a breakout dropped by a filter (volume too low) is a STRATEGY_BLOCK with its reason, direction and inputs (INCOMPLETE: no levels)', blk && /^ORB_FILTER: Breakout volume too low/.test(blk.reason)
    && blk.setup.direction === 'long' && blk.setup.invalidation === undefined && blk.context && blk.context.values.volumeRatio < 1.5, blk && `${blk.id} ${blk.reason}`);
  const scan = orb.takeScan();
  const scanText = JSON.stringify(scan);
  check('the Scanner log reasons are unchanged (the same skip text)', /Breakout volume too low/.test(scanText));
  const qf = require(S + 'strategies/7-options-quickflips');
  const pick = { contract: { symbol: 'SPY261009C00600000', strike: 600, expiration: '2026-10-09', dte: 5, iv: 0.18, delta: 0.52 }, quote: { bid: 4.9, ask: 5.0, quoteTime: Date.now() - 5000, delta: 0.52 }, mid: 4.95 };
  const sig = { setup: 'S1', dir: 'long', endMin: 590, trigger: 600.2, vwap: 599.4, relVol: 1.8, spot: 600.6, or: { high: 600.1, low: 599 } };
  const a = JSON.stringify({ ...qf.candidate('SPY', sig, pick, Date.parse('2026-10-02T14:51:00Z'), 'indicative'), timestamp: null });
  check('Quick Flips candidate() unchanged and carries no inputs (they live in the context store)', !a.includes('todaySlots') && !a.includes('priorSessions') && JSON.parse(a).optionsData.debit === 5);
  const src = ['1-equity-day', '3-equity-swing', '5-options-system', '7-options-quickflips'].map((f) => require('fs').readFileSync(`${S}strategies/${f}.js`, 'utf8'));
  check('every radar strategy hands its inputs to the context store (and none writes them onto a candidate)', src.every((t) => /dc\.(capture|block)\(/.test(t)) && src.every((t) => !/decisionContext\s*[:=]/.test(t)));
};
