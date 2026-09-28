// Settings > Accounts & Connections (Phase 73). WS messages:
//   GET_ACCOUNTS                     -> ACCOUNTS_STATUS (vault.status(): never a secret)
//   SAVE_ACCOUNT { provider, fields } TEST the candidate keys against the venue's own API (the keys in
//                                    use are not touched while testing), then save them to the encrypted
//                                    vault, apply them and HOT-RELOAD what caches them (Alpaca streams,
//                                    live capital / cash caches, the email transport): no restart
//   REMOVE_ACCOUNT { provider }      drop the vault copy (back to the .env keys, if any)
// Reply ACCOUNT_RESULT { provider, ok, detail, warning }; ACCOUNTS_STATUS is broadcast after a change.
const vault = require('./vault');

const money = (x) => `$${Number(x || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const safe = (fn) => { try { return fn(); } catch (err) { console.warn(`[accounts] reload step failed: ${err.message}`); return null; } };

async function alpacaAccount(base, key, secret) {
  const res = await fetch(`${base.replace(/\/+$/, '')}/v2/account`, { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'Alpaca refused these keys (check key / secret, and that they belong to this account type)' : `Alpaca HTTP ${res.status}: ${(j && j.message) || res.statusText}`);
  return j;
}

// Each test: { detail, warning? } or throws with a readable reason.
const TESTS = {
  async alpacaPaper(f) {
    const alp = require('../connectors/alpaca-api');
    const a = await alpacaAccount(process.env.ALPACA_PAPER_BASE_URL || alp.PAPER_BASE_URL, f.key, f.secret);
    return { detail: `Alpaca Paper account ${a.status || ''}: ${money(a.cash)} paper cash (paper trades are still sized from your Paper Bankroll in Settings)`.replace('  ', ' ') };
  },
  async alpacaLive(f) {
    if (/^PK/.test(f.key)) throw new Error('these are Alpaca PAPER keys (PK...): paste them under Alpaca Paper');
    const alp = require('../connectors/alpaca-api');
    const configured = process.env.ALPACA_TRADING_BASE_URL || alp.DEFAULT_BASE_URL;
    const a = await alpacaAccount(/paper-api/.test(configured) ? alp.DEFAULT_BASE_URL : configured, f.key, f.secret);
    const bp = Number(a.buying_power) || 0;
    return { detail: `Alpaca Live account ${a.status || ''}: ${money(a.equity)} equity, ${money(bp)} buying power`.replace('  ', ' '),
      warning: bp > 0 ? null : 'Unfunded ($0 buying power): the keys are saved and ready; LIVE stock / options orders are refused until the account is funded and Alpaca mode is LIVE' };
  },
  async coinbase(f) {
    const cb = require('../connectors/coinbase-api');
    let signingKey;
    try { signingKey = cb.loadSigningKey(f.privateKey); } catch (err) { throw new Error(`the private key is not a valid EC key (${err.message})`); }
    const r = await cb.cbFetch({ keyName: f.keyName, signingKey }, 'GET', '/api/v3/brokerage/accounts', { query: '?limit=250' });
    return { detail: `Coinbase Advanced: ${((r && r.accounts) || []).length} account wallet(s) readable` };
  },
  async kraken(f) {
    const r = await require('../connectors/kraken-api').call('Balance', {}, { key: f.key, secret: f.secret });
    if (!r.ok) throw new Error(r.error);
    return { detail: `Kraken Pro: ${Object.keys(r.result || {}).length} balance(s) readable` };
  },
  async okx(f) {
    const r = await require('../connectors/okx-api').call('GET', '/api/v5/account/balance', { creds: { apiKey: f.key, apiSecret: f.secret, passphrase: f.passphrase } });
    if (!r.ok) throw new Error(r.error);
    return { detail: 'OKX US: trading account readable' };
  },
  async gmail(f) {
    const port = Number(process.env.GMAIL_SMTP_PORT || 465);
    const t = require('nodemailer').createTransport({ host: process.env.GMAIL_SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465, auth: { user: f.email, pass: f.appPassword.replace(/\s+/g, '') },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
    try { await t.verify(); } catch (err) { throw new Error(/535|auth/i.test(err.message) ? 'Gmail refused the sign-in: use a 16-character App Password (not your Google password)' : err.message); } finally { t.close(); }
    return { detail: `Gmail: signed in as ${vault.mask(f.email)}; links go to ${vault.mask(f.alertTo || f.email)}` };
  },
};

// Everything that caches keys picks up the new ones (connectors read process.env on each call).
function reload(provider, broadcast) {
  if (/^alpaca/.test(provider)) {
    safe(() => require('../connectors/alpaca-stock-socket').restart());
    safe(() => require('../connectors/alpaca-news-socket').restart());
  }
  if (['coinbase', 'kraken', 'okx'].includes(provider)) safe(() => require('../execution/crypto-router').clearCash());
  if (provider === 'gmail') safe(() => require('../execution/notifier').resetTransport());
  safe(() => require('../risk/venue-capital').clearCache());
  Promise.resolve().then(() => require('../execution/broker-state').publishBrokerState(broadcast, { force: true })).catch(() => {});
  console.log(`[accounts] ${vault.PROVIDERS[provider].label}: keys applied (no restart needed)`);
}

let busy = false; // one test at a time
async function saveAccount(provider, fields, broadcast) {
  const clean = vault.clean(provider, fields); // throws on unknown / missing fields
  if (provider === 'gmail') clean.appPassword = clean.appPassword.replace(/\s+/g, '');
  const test = await TESTS[provider](clean);
  vault.save(provider, clean, { ok: true, at: Date.now(), detail: test.detail, warning: test.warning || null });
  reload(provider, broadcast);
  return test;
}

function handle(ws, msg, send, broadcast) {
  if (!msg || !['GET_ACCOUNTS', 'SAVE_ACCOUNT', 'REMOVE_ACCOUNT'].includes(msg.type)) return false;
  if (msg.type === 'GET_ACCOUNTS') { send(ws, 'ACCOUNTS_STATUS', vault.status()); return true; }
  const provider = String(msg.provider || '');
  const reply = (r) => send(ws, 'ACCOUNT_RESULT', { provider, ...r });
  if (!vault.PROVIDERS[provider]) { reply({ ok: false, detail: `unknown account "${provider}"` }); return true; }
  if (busy) { reply({ ok: false, detail: 'another account test is running; try again in a moment' }); return true; }
  busy = true;
  const job = msg.type === 'SAVE_ACCOUNT' ? saveAccount(provider, msg.fields, broadcast)
    : Promise.resolve().then(() => { vault.remove(provider); reload(provider, broadcast); return { detail: `${vault.PROVIDERS[provider].label}: removed from the vault${vault.status().providers[provider].configured ? ' (the .env keys are used again)' : ''}` }; });
  job.then((r) => reply({ ok: true, detail: r.detail, warning: r.warning || null }))
    .catch((err) => reply({ ok: false, detail: String(err.message || err).replace(/^Error: /, '') }))
    .finally(() => { busy = false; broadcast('ACCOUNTS_STATUS', vault.status()); });
  return true;
}

module.exports = { handle, saveAccount, reload, TESTS };
