// Market Context: a simple, honest trend read built only from the live streams.
//   US equities: SPY's move from today's first 1m bar open to the latest close
//                (Alpaca IEX bars), plus breadth = streamed stocks up today.
//   Crypto:      BTC's 24h change from the Coinbase ticker, plus breadth across
//                the streamed coins.
// |move| < FLAT_PCT reads as flat. Missing data says so instead of guessing.
// Input: { stockBars: Map(symbol -> [1m bars]), cryptoTicks: { symbol: tick } }.
const FLAT_PCT = 0.001; // 0.10%
const STALE_BAR_MS = 15 * 60 * 1000; // no bar for 15 min: market closed / feed quiet

const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const trendOf = (chg) => (!Number.isFinite(chg) ? 'unknown' : Math.abs(chg) < FLAT_PCT ? 'flat' : chg > 0 ? 'up' : 'down');

// Change since the first bar of the most recent session date in the buffer.
function sessionChange(bars) {
  if (!bars || !bars.length) return null;
  const lastDay = etDate.format(new Date(bars[bars.length - 1].time));
  const today = bars.filter((b) => etDate.format(new Date(b.time)) === lastDay);
  const open = today[0].open;
  const last = today[today.length - 1];
  if (!(open > 0) || !(last.close > 0)) return null;
  return { change: last.close / open - 1, asOf: Date.parse(last.time) + 60000 };
}

function breadthText(changes, unit) {
  const known = changes.filter((c) => Number.isFinite(c));
  if (!known.length) return null;
  const up = known.filter((c) => c > 0).length;
  return `${up} of ${known.length} ${unit} up`;
}

function equities(stockBars, now) {
  const entries = [...(stockBars || new Map())].map(([s, bars]) => [s, sessionChange(bars)]).filter(([, v]) => v);
  if (!entries.length) {
    return { asset: 'US equities', trend: 'unknown', changePct: null, basis: 'SPY today', breadth: 'No bars yet: feed not streaming or market closed since start' };
  }
  const bySymbol = Object.fromEntries(entries);
  const lead = bySymbol.SPY ? ['SPY', bySymbol.SPY] : entries[0];
  const asOf = Math.max(...entries.map(([, v]) => v.asOf));
  const stale = now - asOf > STALE_BAR_MS;
  return {
    asset: 'US equities',
    trend: trendOf(lead[1].change),
    changePct: lead[1].change,
    basis: `${lead[0]} ${stale ? 'last session' : 'today'}`,
    breadth: breadthText(entries.map(([, v]) => v.change), 'stocks'),
    asOf,
    stale,
  };
}

function crypto(cryptoTicks) {
  const ticks = Object.values(cryptoTicks || {}).filter((t) => t && Number.isFinite(t.change24hPct));
  if (!ticks.length) {
    return { asset: 'Crypto', trend: 'unknown', changePct: null, basis: 'BTC 24h', breadth: 'No ticker data yet' };
  }
  const lead = ticks.find((t) => t.symbol === 'BTC-USD') || ticks[0];
  const change = lead.change24hPct / 100; // Coinbase reports percent
  return {
    asset: 'Crypto',
    trend: trendOf(change),
    changePct: change,
    basis: `${lead.symbol.replace('-USD', '')} 24h`,
    breadth: breadthText(ticks.map((t) => t.change24hPct), 'coins'),
    asOf: Date.parse(lead.time) || null,
    stale: false,
  };
}

function getMarketContext({ stockBars, cryptoTicks } = {}, now = Date.now()) {
  return [equities(stockBars, now), crypto(cryptoTicks)];
}

module.exports = { getMarketContext, FLAT_PCT };
