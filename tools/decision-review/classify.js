// Decision Review classes (Phase 93 spec 5.3 / 5.4), frozen with the proposal. On the UNDERLYING's path only [C2]; the trade's
// money result is a separate column (simulate.js), and a loss's explanation another (attribute.js) [C4].
// Precedence (the first rule that matches): UNCLEAR (coverage) > EARLY_ENTRY > REVERSAL_AFTER_ENTRY > LATE_ENTRY > WRONG_DIRECTION >
// CORRECT_DIRECTION > UNCLEAR (no decisive move). Setups without levels are INCOMPLETE (horizon labels only).
const CLASSES = ['CORRECT_DIRECTION', 'WRONG_DIRECTION', 'EARLY_ENTRY', 'LATE_ENTRY', 'REVERSAL_AFTER_ENTRY', 'UNCLEAR', 'INCOMPLETE', 'PENDING', 'NOT_MEASURABLE'];
const TEXT = {
  CORRECT_DIRECTION: 'Correct direction: T1 reached first, or ended at least +0.25 unit in the called direction',
  WRONG_DIRECTION: 'Wrong direction: stopped with little favourable move first (< 0.5 unit), or ended at least 0.25 unit against',
  EARLY_ENTRY: 'Early entry: stopped first, then T1 was reached later within the holding period',
  LATE_ENTRY: 'Late entry: it had already moved at least 1 unit the called way before the decision, then failed (< 0.5 unit further)',
  REVERSAL_AFTER_ENTRY: 'Reversal after entry: moved at least 0.5 unit the called way, then reversed to the stop / ended against, without T1',
  UNCLEAR: 'Unclear: the evidence cannot distinguish (missing data, or no decisive move)',
  INCOMPLETE: 'Incomplete setup: a direction but no executable entry / stop / target (horizon labels only)',
  PENDING: 'Pending: the planned holding period has not ended yet',
  NOT_MEASURABLE: 'Not measurable: the decision time, direction or price is not recorded',
};

// m: measure() output (or { error }). -> { cls, why }
function classify(d, m) {
  if (!m || m.error) return { cls: 'NOT_MEASURABLE', why: m ? m.error : 'no measurement' };
  if (!d.levels) return { cls: 'INCOMPLETE', why: TEXT.INCOMPLETE };
  if (!m.complete) return { cls: 'PENDING', why: `${TEXT.PENDING} (${m.H.label})` };
  if (m.pathCoverage < 0.9) return { cls: 'UNCLEAR', why: `Path coverage ${(m.pathCoverage * 100).toFixed(0)}% < 90%` };
  const end = m.horizons.find((h) => h.key === 'H');
  const mH = end ? end.m : null;
  const stopped = m.stopAt !== null;
  const t1First = m.t1At !== null && (!stopped || m.t1At < m.stopAt);
  if (stopped && !t1First && m.t1AfterStop !== null) return { cls: 'EARLY_ENTRY', why: TEXT.EARLY_ENTRY };
  if (!t1First && m.mfeBeforeStop >= 0.5 && (stopped || (mH !== null && mH <= -0.25))) return { cls: 'REVERSAL_AFTER_ENTRY', why: `${TEXT.REVERSAL_AFTER_ENTRY} (MFE ${m.mfeBeforeStop.toFixed(2)})` };
  const failed = (stopped && !t1First) || (!stopped && !t1First && mH !== null && mH <= -0.25);
  if (m.preMove !== null && m.preMove >= 1.0 && m.mfeBeforeStop < 0.5 && failed) return { cls: 'LATE_ENTRY', why: `${TEXT.LATE_ENTRY} (pre-move ${m.preMove.toFixed(2)} over ${m.preMoveWindow})` };
  if ((stopped && !t1First && m.mfeBeforeStop < 0.5) || (!stopped && !t1First && mH !== null && mH <= -0.25)) return { cls: 'WRONG_DIRECTION', why: TEXT.WRONG_DIRECTION };
  if (t1First || (mH !== null && mH >= 0.25)) return { cls: 'CORRECT_DIRECTION', why: t1First ? 'T1 reached first' : `Ended ${mH.toFixed(2)} unit in the called direction` };
  return { cls: 'UNCLEAR', why: 'No decisive move (|m(H)| < 0.25, neither stop nor T1)' };
}

// The opposite side's directional class on the same path [C3] (d reversed, the same unit; stop / T1 mirrored around P0).
function opposite(d, m) {
  if (!m || m.error || !m.complete) return null;
  const end = m.horizons.find((h) => h.key === 'H');
  return { label: end && end.label !== 'NO_DATA' && end.m !== null ? (end.m <= -0.25 ? 'CORRECT' : end.m >= 0.25 ? 'WRONG' : 'FLAT') : 'NO_DATA', m: end && end.m !== null ? -end.m : null };
}

module.exports = { classify, opposite, CLASSES, TEXT };
