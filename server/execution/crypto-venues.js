// Crypto execution venues (Phase 69A; OKX live in 69B), cheapest first: OKX US -> Kraken Pro -> Coinbase.
// Each venue exposes the SAME connector surface, so the reconciler, [Close], re-arm, the profit
// ratchet and order recovery act on a position through its venue alone:
//   api()     getOrderStatus / getOrder / cancelOrder / getAvailable / getAccount
//   orders()  submitOrder / placeBracket / sellMarket / findOrderByClientId / listOrders / clientIdOf
// A position's venue: pos.venue ('coinbase' | 'kraken' | 'okx'), else its broker ('Kraken' / 'OKX');
// anything older is Coinbase. The connectors are returned as their module objects, so tests
// that stub a connector function are honoured wherever it is called.
//   okx       configured when OKX_API_KEY + OKX_API_SECRET + OKX_API_PASSPHRASE are set (Phase 69B);
//             lists its live USD / USDC / USDT spot instruments
//   kraken    configured when KRAKEN_API_KEY + KRAKEN_API_SECRET are set; lists its USD / USDC pairs
//   coinbase  always available (the fallback, micro-cap Moonshots, existing positions)
// restsTarget: the venue holds the T1 limit too (Coinbase's bracket). OKX / Kraken rest only the
// stop; SignalDesk sells at T1 itself (ratchet.watch).
const cost = require('../risk/cost-authority');

const VENUES = {
  okx: {
    id: 'okx', label: 'OKX US', broker: 'OKX', restsTarget: false,
    configured: () => require('../connectors/okx-api').configured(),
    lists: (symbol) => require('../connectors/okx-pairs').lists(symbol),
    api: () => require('../connectors/okx-api'),
    orders: () => require('../connectors/okx-orders'),
  },
  kraken: {
    id: 'kraken', label: 'Kraken Pro', broker: 'Kraken', restsTarget: false,
    configured: () => require('../connectors/kraken-api').configured(),
    lists: (symbol) => require('../connectors/kraken-pairs').lists(symbol),
    api: () => require('../connectors/kraken-api'),
    orders: () => require('../connectors/kraken-orders'),
  },
  coinbase: {
    id: 'coinbase', label: 'Coinbase', broker: 'Coinbase', restsTarget: true,
    configured: () => true,
    lists: (symbol) => /^[A-Z0-9]{1,10}-USDC?$/.test(String(symbol)),
    api: () => require('../connectors/coinbase-api'),
    orders: () => require('../connectors/coinbase-orders'),
  },
};
const ORDER = ['okx', 'kraken', 'coinbase'];
const BROKERS = new Set(['Coinbase', 'Kraken', 'OKX']); // live crypto brokers SignalDesk trades at

const idOf = (p) => (p && VENUES[p.venue] ? p.venue : p && p.broker === 'Kraken' ? 'kraken' : p && p.broker === 'OKX' ? 'okx' : 'coinbase');
const of = (p) => VENUES[idOf(p)];
const api = (p) => of(p).api();
const orders = (p) => of(p).orders();
const byBroker = (broker) => Object.values(VENUES).find((v) => v.broker === broker) || null;
// A LIVE crypto position SignalDesk trades at a broker (not a watch-only adopted holding's broker check).
const isLiveCrypto = (p) => !!p && p.execution === 'LIVE' && p.market === 'crypto' && BROKERS.has(p.broker);
const fees = (id) => cost.venueFees(id);
const pct = (x) => `${(x * 100).toFixed(2)}%`;
const feeText = (id) => { const f = fees(id); return `${pct(f.maker)}/${pct(f.taker)}`; };

module.exports = { VENUES, ORDER, idOf, of, api, orders, byBroker, isLiveCrypto, fees, feeText };
