// Keyword-dictionary headline sentiment. Deterministic and dependency-free.
// Each matched word adds its weight; a negator up to two words before a
// match ("not", "fails to") flips that word's sign.
// Phase 58: compound market phrases are scored FIRST and removed from the text,
// so their words are not counted again: "Treasury yields surge" is bearish for
// stocks (not a bullish "surge"), "get crushed" / "outflows" / "sell-off" are
// strongly bearish (weight -2). "Small Caps Get Crushed: IWM Sees $3.3B Outflow
// as Treasury Yields Surge" = -6: BEARISH (it used to score +1 on "surge").

const POSITIVE = [
  'beat', 'beats', 'tops', 'exceeds', 'surge', 'surges', 'soar', 'soars', 'jump', 'jumps',
  'rally', 'rallies', 'gain', 'gains', 'rise', 'rises', 'upgrade', 'upgraded', 'upgrades',
  'raise', 'raises', 'raised', 'record', 'strong', 'growth', 'profit', 'profitable',
  'bullish', 'outperform', 'buy', 'approve', 'approval', 'approved', 'approves', 'win', 'wins',
  'partnership', 'buyback', 'dividend', 'expands', 'expansion', 'breakthrough', 'boost',
  'inflow', 'inflows',
];

const NEGATIVE = [
  'miss', 'misses', 'missed', 'fall', 'falls', 'drop', 'drops', 'decline', 'declines', 'cut', 'cuts',
  'lawsuit', 'sues', 'probe', 'investigation', 'recall', 'weak', 'loss', 'losses', 'bearish', 'underperform', 'sell',
  'bankruptcy', 'fraud', 'layoffs', 'warns', 'warning', 'delay', 'delays', 'halted', 'halt',
];

// Strongly bearish single words (weight -2).
const STRONG_NEGATIVE = ['crushed', 'crush', 'crushes', 'outflow', 'outflows', 'selloff', 'selloffs', 'slump', 'slumps', 'plunge', 'plunges',
  'plunged', 'tumble', 'tumbles', 'tumbled', 'sink', 'sinks', 'sank', 'rout', 'routs', 'downgrade', 'downgrades', 'downgraded',
  'slash', 'slashes', 'slashed', 'crash', 'crashes', 'crashed', 'collapse', 'collapses', 'tank', 'tanks', 'tanked'];

// Compound phrases (matched on the lower-cased headline, then removed).
const PHRASES = [
  [/\bget(s)? crushed\b/g, -2], [/\bsell[- ]offs?\b/g, -2],
  [/\b(treasury |bond |10-year |long-term )?yields? (surge|surges|surged|spike|spikes|spiked|jump|jumps|jumped|soar|soars|soared|climb|climbs|rise|rises)\b/g, -2],
  [/\b(yields?|rates?) (fall|falls|drop|drops|ease|eases|cool|cools)\b/g, 1],
  [/\bprice targets? (cut|cuts|lowered|slashed)\b/g, -2], [/\bprice targets? (raised|lifted|boosted)\b/g, 2],
];

const NEGATORS = new Set(['not', 'no', 'never', 'without', 'fails', 'failed']);

const WEIGHTS = new Map([
  ...POSITIVE.map((w) => [w, 1]),
  ...NEGATIVE.map((w) => [w, -1]),
  ...STRONG_NEGATIVE.map((w) => [w, -2]),
]);

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z]+/g) || [];
}

function scoreHeadline(text) {
  let rest = String(text || '').toLowerCase();
  let score = 0;
  for (const [re, weight] of PHRASES) {
    rest = rest.replace(re, () => { score += weight; return ' '; });
  }
  const tokens = tokenize(rest);
  tokens.forEach((token, i) => {
    const weight = WEIGHTS.get(token);
    if (!weight) return;
    const negated = NEGATORS.has(tokens[i - 1]) || NEGATORS.has(tokens[i - 2]);
    score += negated ? -weight : weight;
  });

  let classification = 'NEUTRAL';
  if (score > 0) classification = 'POSITIVE';
  else if (score < 0) classification = 'NEGATIVE';
  return { score, classification };
}

module.exports = { scoreHeadline, PHRASES };
