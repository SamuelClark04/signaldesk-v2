// Phase 95 Task 4.2 / 4.3 (pilot versions, frozen 2026-10-13 BEFORE any outcome was examined; PENDING the user's one-time review,
// spec 3.2 / 6): `exposure-map@1-pilot` for the 24 pilot symbols and `evt-rules@1-lite`, a RULES-ONLY headline classifier.
// Map sources: SECTOR_ETF = the stock's GICS sector SPDR (semiconductors: SMH), from the issuers' published holdings (secondary, not
// ex-self: no weights); SEGMENT_PEER = CURATED from the companies' own segment descriptions (annual reports): GPUs (NVDA / AMD), cloud
// (MSFT / AMZN / GOOGL), digital advertising (META / GOOGL), devices / platforms (AAPL / MSFT / GOOGL). ETFs: benchmark SPY, no peers.
// EDGAR-based segments and supply chains come with exposure-map@2 (EDGAR deferred until a contact address is designated).
const MAP_VERSION = 'exposure-map@1-pilot (CURATED, pending review)';
const EVT_VERSION = 'evt-rules@1-lite (rules only, pending the 300-document review)';

const MAP = Object.freeze({
  AAPL: { sector: 'XLK', peers: ['MSFT', 'GOOGL'] },
  MSFT: { sector: 'XLK', peers: ['GOOGL', 'AMZN', 'AAPL'] },
  NVDA: { sector: 'SMH', peers: ['AMD'] },
  AMD: { sector: 'SMH', peers: ['NVDA'] },
  META: { sector: 'XLC', peers: ['GOOGL'] },
  GOOGL: { sector: 'XLC', peers: ['META', 'MSFT', 'AMZN'] },
  AMZN: { sector: 'XLY', peers: ['MSFT', 'GOOGL'] },
  TSLA: { sector: 'XLY', peers: [] },
});
const BENCH = 'SPY';
// The comparison series of a symbol for T4: its sector ETF (stocks), SPY (ETFs other than SPY), none (SPY).
const benchOf = (s) => (MAP[s] ? MAP[s].sector : s === BENCH ? null : BENCH);
const peersOf = (s) => (MAP[s] ? MAP[s].peers : []);

// evt-rules@1-lite: category + pre-declared direction from the headline (first match wins). UP / DOWN only where the category rule
// declares it; otherwise BOTH sides are evaluated (spec T6).
const RULES = [
  ['ANALYST', 'UPGRADE', /\bupgrade[sd]?\b|\braises? (?:price )?target\b|\bto (?:buy|outperform|overweight)\b/i, 'UP'],
  ['ANALYST', 'DOWNGRADE', /\bdowngrade[sd]?\b|\bcuts? (?:price )?target\b|\bto (?:sell|underperform|underweight)\b/i, 'DOWN'],
  ['GUIDANCE', 'RAISE', /\b(?:raises?|lifts?|boosts?) (?:its |full[- ]year |annual |fy\d* ?)?(?:guidance|outlook|forecast)\b/i, 'UP'],
  ['GUIDANCE', 'CUT', /\b(?:cuts?|lowers?|slashes?|trims?) (?:its |full[- ]year |annual |fy\d* ?)?(?:guidance|outlook|forecast)\b/i, 'DOWN'],
  ['EARNINGS', 'BEAT', /\b(?:beats?|tops?|exceeds?) (?:\w+ ){0,2}(?:estimates|expectations|forecasts|consensus)\b/i, 'UP'],
  ['EARNINGS', 'MISS', /\b(?:miss(?:es)?|falls? short of|below) (?:\w+ ){0,2}(?:estimates|expectations|forecasts|consensus)\b/i, 'DOWN'],
  ['EARNINGS', 'REPORT', /\b(?:earnings|quarterly results|q[1-4] results|revenue|eps)\b/i, 'BOTH'],
  ['LEGAL_REGULATORY', 'ACTION', /\b(?:lawsuit|sued|probe|investigation|antitrust|fine[sd]?|penalty|recall|subpoena|ban(?:s|ned)?)\b/i, 'DOWN'],
  ['M_AND_A', 'DEAL', /\b(?:acquire[sd]?|acquisition|merger|to buy|takeover|buyout)\b/i, 'BOTH'],
  ['MANAGEMENT', 'CHANGE', /\b(?:ceo|cfo|chief executive|resigns?|steps? down|appoints?|names? new)\b/i, 'BOTH'],
  ['PRODUCT', 'LAUNCH', /\b(?:launch(?:es|ed)?|unveils?|introduces?|announces? new|partnership|contract|deal with)\b/i, 'BOTH'],
];
function classify(headline) {
  for (const [category, subtype, re, dir] of RULES) if (re.test(headline || '')) return { category, subtype, dir };
  return { category: 'OTHER', subtype: null, dir: 'BOTH' };
}
// The relation of a document to `symbol`: SELF (it names the symbol), SEGMENT_PEER (it names a mapped peer), else NONE.
function relation(symbol, docSymbols) {
  const s = docSymbols || [];
  if (s.includes(symbol)) return 'SELF';
  if (peersOf(symbol).some((p) => s.includes(p))) return 'SEGMENT_PEER';
  return 'NONE';
}

module.exports = { MAP, MAP_VERSION, EVT_VERSION, benchOf, peersOf, classify, relation };
