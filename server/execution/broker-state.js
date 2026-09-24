// Broker state: what each execution venue currently has to trade with.
// A venue in 'paper' mode reports only its mode (the paper bankroll applies);
// a venue in 'live' mode is queried through its read-only account API.
// Results are cached briefly so page loads don't hammer the broker APIs.
const ledger = require('./paper-ledger');
const alpacaApi = require('../connectors/alpaca-api');
const coinbaseApi = require('../connectors/coinbase-api');

const CACHE_MS = 15000;

const VENUES = [
  { name: 'alpaca', modeKey: 'stockMode', label: 'Alpaca', markets: 'stocks / options', api: alpacaApi },
  { name: 'coinbase', modeKey: 'cryptoMode', label: 'Coinbase', markets: 'crypto', api: coinbaseApi },
];

const cache = new Map(); // venue name -> { at, value }
let publishSeq = 0;

async function venueState(venue, mode, force) {
  const base = { label: venue.label, markets: venue.markets, mode };
  if (mode !== 'live') return base;

  const hit = cache.get(venue.name);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return { ...base, ...hit.value };
  // getAccount() never throws by contract; the catch is a last line of defence.
  const account = await venue.api.getAccount().catch((err) => ({ ok: false, error: err.message }));
  const value = { ...account, fetchedAt: Date.now() };
  cache.set(venue.name, { at: value.fetchedAt, value });
  if (!account.ok) console.warn(`[broker] ${venue.label} account unavailable: ${account.error}`);
  return { ...base, ...value };
}

// Snapshot for the UI. Sizing still uses the paper bankroll for every venue:
// live balances are displayed, not yet used by the risk engine.
async function getBrokerState({ force = false } = {}) {
  const settings = ledger.getSettings();
  const venues = await Promise.all(VENUES.map((v) => venueState(v, settings[v.modeKey], force)));
  return {
    bankroll: settings.bankroll,
    sizingBasis: 'paper-bankroll',
    venues: Object.fromEntries(VENUES.map((v, i) => [v.name, venues[i]])),
  };
}

// Fetch and broadcast. If a newer publish starts while this one is awaiting a
// broker (e.g. live -> paper toggled quickly), the older result is dropped so a
// stale LIVE balance can never overwrite the current state on screen.
async function publishBrokerState(broadcast, options) {
  const seq = ++publishSeq;
  const state = await getBrokerState(options);
  if (seq !== publishSeq) return null;
  broadcast('BROKER_STATE', state);
  return state;
}

module.exports = { getBrokerState, publishBrokerState, CACHE_MS };
