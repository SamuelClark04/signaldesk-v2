// Phase 70D: a crypto strategy's stop FLOOR is costed on the venue the setup would route to now
// (crypto-router.preRoute: listing + the last known cash when crypto is LIVE): OKX US 0.08% /
// 0.10% and Kraken Pro 0.25% / 0.40% need a far smaller stop than Coinbase's tier to keep fees
// under the fee-drag budget. The stop itself still comes from the chart structure; the floor only
// widens a stop that would be too tight for the venue's fees. The pipeline routes the candidate
// the same way (same pass, same caches), so the setup is costed on the venue its floor assumed.
// No router / ledger (unit tests, first pass after a restart): Coinbase's key, the conservative one.
function floorKey(asset) {
  try {
    const live = require('../execution/paper-ledger').getSettings().cryptoMode === 'live';
    const v = require('../execution/crypto-router').preRoute(asset, { live }).venue;
    return v === 'coinbase' ? 'crypto' : `crypto:${v}`;
  } catch { return 'crypto'; }
}

module.exports = { floorKey };
