// Keyword-dictionary headline sentiment. Deterministic and dependency-free.
// Each matched word adds its weight; a negator up to two words before a
// match ("not", "fails to") flips that word's sign.

const POSITIVE = [
  'beat', 'beats', 'tops', 'exceeds', 'surge', 'surges', 'soar', 'soars', 'jump', 'jumps',
  'rally', 'rallies', 'gain', 'gains', 'rise', 'rises', 'upgrade', 'upgraded', 'upgrades',
  'raise', 'raises', 'raised', 'record', 'strong', 'growth', 'profit', 'profitable',
  'bullish', 'outperform', 'buy', 'approve', 'approval', 'approved', 'approves', 'win', 'wins',
  'partnership', 'buyback', 'dividend', 'expands', 'expansion', 'breakthrough', 'boost',
];

const NEGATIVE = [
  'miss', 'misses', 'missed', 'plunge', 'plunges', 'fall', 'falls', 'drop', 'drops',
  'sink', 'sinks', 'tumble', 'tumbles', 'slump', 'slumps', 'decline', 'declines',
  'downgrade', 'downgraded', 'downgrades', 'cut', 'cuts', 'lawsuit', 'sues', 'probe',
  'investigation', 'recall', 'weak', 'loss', 'losses', 'bearish', 'underperform', 'sell',
  'bankruptcy', 'fraud', 'layoffs', 'warns', 'warning', 'delay', 'delays', 'halted', 'halt',
];

const NEGATORS = new Set(['not', 'no', 'never', 'without', 'fails', 'failed']);

const WEIGHTS = new Map([
  ...POSITIVE.map((w) => [w, 1]),
  ...NEGATIVE.map((w) => [w, -1]),
]);

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z]+/g) || [];
}

function scoreHeadline(text) {
  const tokens = tokenize(text);
  let score = 0;
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

module.exports = { scoreHeadline };
