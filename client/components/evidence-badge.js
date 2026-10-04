// Evidence badge (Phase 91 radar mode): a strategy's test record on every alert, card, Scanner row and position ("PF 0.86 · Failed").
// Data: the setup's own evidence (copied at staging from server/strategies/strategy-evidence.js) or settings.strategyEvidence[id].
// A manual / adopted trade has none and shows nothing. Exposes window.SignalDesk.evidenceBadge: text(ev) (pure), badge(ev).
(() => {
  const SD = window.SignalDesk;
  const KIND = { FAILED: 'is-failed', NOT_A_STRATEGY: 'is-neutral', UNTESTED: 'is-neutral' };
  function text(ev) {
    if (!ev || !ev.label) return null;
    return { label: ev.label, title: [ev.detail, ev.source].filter(Boolean).join(' · '), kind: KIND[ev.verdict] || 'is-neutral' };
  }
  function badge(ev) {
    const t = text(ev);
    return t ? SD.ui.el('span', { className: `ev-badge ${t.kind}`, textContent: t.label, title: t.title }) : null;
  }
  SD.evidenceBadge = { text, badge };
})();
