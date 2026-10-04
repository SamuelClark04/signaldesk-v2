// Paper-only lock (Phase 91, spec docs/superpowers/specs/2026-10-04-radar-manual-approval-design.md): every NEW entry is paper, in
// every market, whatever a setting says, until a strategy passes a pre-registered test. A code constant on purpose: no setting, UI,
// .env or file can lift it; unlocking is a code change + deploy. Read at call time (lock.PAPER_ONLY), so a test that exercises the
// LIVE paths on mocks lifts it in-process before requiring any other server module. Used ONLY by the entry choke points
// (ledger-store mode validation, order-router, manual-trade): exits, reconcile and closes of existing LIVE positions are never gated.
const MESSAGE = 'PAPER_ONLY_LOCK: SignalDesk is locked to paper trading in every market; nothing was sent to a live broker';
const lock = {
  PAPER_ONLY: true,
  MESSAGE,
  // Settings: stockMode / cryptoMode 'live' is refused while locked (a saved live mode therefore loads as paper).
  checkMode(key, value) {
    if (lock.PAPER_ONLY && (key === 'stockMode' || key === 'cryptoMode') && value === 'live') throw new Error(`${MESSAGE} (${key} stays paper)`);
  },
  // Order router / Manual Trade Ticket: an ENTRY that would execute LIVE.
  assertPaperEntry(what) {
    if (lock.PAPER_ONLY) throw new Error(`${MESSAGE} (${what})`);
  },
};
module.exports = lock;
