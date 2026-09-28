// Manual Trade Ticket default stop for CRYPTO (Phase 70D). The old default, 1.5 x the 14-DAY ATR,
// put a Moonshot's stop -12.8% and its T1 +32% away (MORPHO): a daily range is the wrong ruler for
// a trade held hours to days. Now: 2 x the 1-HOUR ATR (14 bars), kept inside a band
//   standard crypto 3.0% - 5.0%      Moonshot 4.5% - 6.5%
// and never tighter than the routed venue's fee floor (+ FLOOR_ROOM, set by the caller): on
// Coinbase's tier that floor (~5-8%) wins; on OKX US / Kraken Pro the band does. T1 stays at the
// ticket's 2.5R, so +7.5% to +16%. The user can still type any stop / target before opening.
const { getHistory } = require('../connectors/history-bars');
const { atr } = require('../strategies/options-signals');

const HOURLY_ATR_MULT = 2;
const BANDS = { crypto: [0.03, 0.05], moonshot: [0.045, 0.065] };

// { pct (of the price), basis, atr1h } for a crypto ticket at `px`; floorPct: the venue's fee floor.
async function cryptoStop(asset, px, floorPct, moonshot = false) {
  const h = await getHistory(asset, '1h').catch(() => null);
  const bars = h && h.ok ? h.bars : [];
  const a = bars.length > 15 ? atr(bars, 14) : null;
  const [lo, hi] = moonshot ? BANDS.moonshot : BANDS.crypto;
  const raw = a && px > 0 ? (HOURLY_ATR_MULT * a) / px : null;
  let pct = raw === null ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, raw));
  let basis = raw === null ? `${moonshot ? 'Moonshot' : 'crypto'} default (no 1h history)` : raw < lo ? `${(lo * 100).toFixed(1)}% band minimum` : raw > hi ? `${(hi * 100).toFixed(1)}% band maximum` : '2 x 1h ATR';
  if (floorPct > pct) { pct = floorPct; basis = 'fee floor'; }
  return { pct, basis, atr1h: a };
}

module.exports = { cryptoStop, BANDS, HOURLY_ATR_MULT };
