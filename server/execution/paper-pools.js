// Paper bankrolls (Phase 70): two independent PAPER accounts, so paper crypto never spends the
// stocks / options paper money and vice versa.
//   stocks  stocks + options, Settings "Paper bankroll: stocks / options" (settings.bankroll)
//   crypto  crypto, Settings "Paper bankroll: crypto" (settings.cryptoBankroll)
// A pool's cash = its bankroll + the realized net P&L of its closed PAPER trades - the cost of its
// open PAPER positions (options: debit x multiplier per contract). The risk engine sizes a paper
// setup against its pool's bankroll and never above its pool's cash (venue-capital.js).
// LIVE, adopted, broker and external records are real money: never in a paper pool.
const POOLS = {
  stocks: { key: 'bankroll', label: 'Stocks / Options', markets: ['stocks', 'options'] },
  crypto: { key: 'cryptoBankroll', label: 'Crypto', markets: ['crypto'] },
};
const poolOf = (market) => (market === 'crypto' ? 'crypto' : 'stocks');
const isPaper = (x) => !!x && x.execution !== 'LIVE' && x.execution !== 'BROKER' && x.execution !== 'EXTERNAL' && !x.adopted;
const costOf = (p) => (p.market === 'options' && p.optionsData && p.optionsData.debit > 0
  ? p.positionSize * p.optionsData.debit * (p.optionsData.multiplier || 100) : (p.positionSize || 0) * (p.fillPrice || p.entryPrice || 0));
const bankrollOf = (settings, pool) => Number(settings[POOLS[pool].key] ?? settings.bankroll) || 0; // crypto unset: the shared one

// { stocks: { label, bankroll, realized, committed, cash, open }, crypto: { ... } }
function summary(ledger = require('./paper-ledger'), settings = ledger.getSettings()) {
  const out = Object.fromEntries(Object.entries(POOLS).map(([k, p]) => [k, { label: p.label, bankroll: bankrollOf(settings, k), realized: 0, committed: 0, open: 0, cash: 0 }]));
  for (const t of ledger.getTradeJournal()) if (isPaper(t)) out[poolOf(t.market)].realized += t.netPnl || 0;
  for (const p of ledger.getActivePositions()) {
    if (!isPaper(p)) continue;
    out[poolOf(p.market)].committed += costOf(p);
    out[poolOf(p.market)].open += 1;
  }
  for (const s of Object.values(out)) s.cash = s.bankroll + s.realized - s.committed;
  return out;
}
const cashOf = (pool, ledger, settings) => summary(ledger, settings)[pool].cash;

module.exports = { POOLS, poolOf, isPaper, costOf, bankrollOf, summary, cashOf };
