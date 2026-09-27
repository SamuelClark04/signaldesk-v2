// Venue credentials read from the environment (.env, loaded by server.js through dotenv).
// Read on every call (never cached at require time), so tests and harnesses that point a venue
// at a local mock by setting process.env before the first call are always honoured.
// Values are never logged or sent anywhere except the venue's own auth headers.
//   OKX US (Phase 69B): OKX_API_KEY, OKX_API_SECRET, OKX_API_PASSPHRASE; OKX_BASE_URL (alias
//   OKX_API_BASE_URL) defaults to https://us.okx.com: OKX's v5 docs require US / AU accounts
//   (registered on app.okx.com) to call the us.okx.com domain (openapi / www.okx.com: global).
const trim = (x) => String(x || '').trim();

const okx = () => ({
  apiKey: trim(process.env.OKX_API_KEY),
  apiSecret: trim(process.env.OKX_API_SECRET),
  passphrase: trim(process.env.OKX_API_PASSPHRASE),
  baseUrl: (trim(process.env.OKX_BASE_URL) || trim(process.env.OKX_API_BASE_URL) || 'https://us.okx.com').replace(/\/+$/, ''),
});

module.exports = { okx };
