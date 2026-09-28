// Encrypted credentials vault (Phase 73): broker / exchange / email keys entered in Settings >
// Accounts & Connections, stored in server/data/credentials.enc.json (CREDENTIALS_PATH overrides:
// tests and harnesses point it at scratch files) with AES-256-GCM, the key derived (scrypt, per-file
// salt) from the access token (LAN_ACCESS_TOKEN / ACCESS_TOKEN). A per-run GENERATED token cannot
// unlock it next time, so the vault is read-only-closed without a token of >= 24 chars in .env.
// Keys live in the vault, else in .env: apply() copies each saved provider into process.env (every
// connector reads its keys from process.env on each call), and a removed one falls back to the
// value .env gave at boot. The browser only ever gets status(): configured / source / a masked
// preview ("PKIY…7Z9"), never a secret.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIN_TOKEN = 24;
const AAD = Buffer.from('signaldesk-vault-v1');
const file = () => process.env.CREDENTIALS_PATH || path.join(__dirname, '..', 'data', 'credentials.enc.json');

// provider -> label, fields (form name -> env var), extra env set with them, what the preview masks.
const PROVIDERS = {
  alpacaPaper: { label: 'Alpaca Paper', hint: 'PK... keys from app.alpaca.markets (Paper account)', fields: { key: 'ALPACA_PAPER_API_KEY', secret: 'ALPACA_PAPER_API_SECRET' }, preview: 'key' },
  alpacaLive: { label: 'Alpaca Live', hint: 'AK... keys from the Live account (a $0 account can be connected now)', fields: { key: 'ALPACA_API_KEY', secret: 'ALPACA_API_SECRET' }, preview: 'key' },
  coinbase: { label: 'Coinbase Advanced', hint: 'CDP API key name (organizations/.../apiKeys/...) + its EC private key', fields: { keyName: 'COINBASE_API_KEY', privateKey: 'COINBASE_API_SECRET' }, preview: 'keyName' },
  kraken: { label: 'Kraken Pro', hint: 'API key + private key (Query Funds, Orders & Trades permissions)', fields: { key: 'KRAKEN_API_KEY', secret: 'KRAKEN_API_SECRET' }, preview: 'key' },
  okx: { label: 'OKX US', hint: 'API key, secret key and passphrase (Read + Trade)', fields: { key: 'OKX_API_KEY', secret: 'OKX_API_SECRET', passphrase: 'OKX_API_PASSPHRASE' }, preview: 'key' },
  gmail: { label: 'Gmail link emailer', hint: 'Gmail address + a 16-character App Password (Google Account > Security > App passwords)', fields: { email: 'SMTP_USER', appPassword: 'SMTP_PASS', alertTo: 'ALERT_EMAIL_TO' },
    optional: ['alertTo'], extra: (f) => ({ SMTP_HOST: process.env.GMAIL_SMTP_HOST || 'smtp.gmail.com', SMTP_PORT: process.env.GMAIL_SMTP_PORT || '465', SMTP_FROM: f.email, ALERT_EMAIL_TO: f.alertTo || f.email }), preview: 'email' },
};
const ENV_KEYS = [...new Set(Object.values(PROVIDERS).flatMap((p) => [...Object.values(p.fields), ...(p.extra ? Object.keys(p.extra({})) : [])]))];

let baseline = null; // env values from .env / the shell at boot (the fallback)
let entries = {}; // provider -> { fields, savedAt, test }
let state = { ready: false, locked: false, reason: null };

const token = () => { const t = process.env.LAN_ACCESS_TOKEN || process.env.ACCESS_TOKEN || ''; return t.length >= MIN_TOKEN ? t : null; };
const keyFor = (salt) => crypto.scryptSync(token(), salt, 32, { N: 16384, r: 8, p: 1 });

function encrypt(obj, salt) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFor(salt), iv);
  c.setAAD(AAD);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decrypt(box) {
  const d = crypto.createDecipheriv('aes-256-gcm', keyFor(Buffer.from(box.salt, 'base64')), Buffer.from(box.iv, 'base64'));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
}

// Read the vault (boot). Never throws: a missing file is an empty vault; a wrong token or a damaged
// file leaves the vault LOCKED (nothing applied, .env keys still work) and says why.
function load() {
  if (!baseline) baseline = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  entries = {};
  if (!token()) { state = { ready: false, locked: true, reason: 'no access token of 24+ characters in .env (LAN_ACCESS_TOKEN): keys can only come from .env' }; return state; }
  let raw = null;
  try { raw = fs.readFileSync(file(), 'utf8'); } catch { state = { ready: true, locked: false, reason: null }; return state; }
  try {
    const box = JSON.parse(raw);
    entries = decrypt(box).entries || {};
    state = { ready: true, locked: false, reason: null };
  } catch {
    state = { ready: false, locked: true, reason: 'the credentials vault cannot be opened with this access token (it was saved with another one): re-enter the keys, or restore the old LAN_ACCESS_TOKEN' };
    console.warn(`[vault] ${state.reason}; using .env keys`);
  }
  return state;
}

// process.env <- the vault (saved providers) over the boot baseline (the others).
function apply() {
  if (!baseline) load();
  for (const k of ENV_KEYS) { if (baseline[k] === undefined) delete process.env[k]; else process.env[k] = baseline[k]; }
  // The .env PK... keys doubled as the paper broker (Phase 71): keep them there when a LIVE Alpaca key replaces them.
  const pk = String(baseline.ALPACA_API_KEY || '').startsWith('PK');
  if (entries.alpacaLive && pk && !baseline.ALPACA_PAPER_API_KEY && !entries.alpacaPaper) Object.assign(process.env, { ALPACA_PAPER_API_KEY: baseline.ALPACA_API_KEY, ALPACA_PAPER_API_SECRET: baseline.ALPACA_API_SECRET });
  for (const [id, e] of Object.entries(entries)) {
    const p = PROVIDERS[id];
    if (!p) continue;
    for (const [f, env] of Object.entries(p.fields)) if (e.fields[f]) process.env[env] = e.fields[f];
    if (p.extra) Object.assign(process.env, p.extra(e.fields));
  }
}

function persist() {
  const f = file();
  let salt = null;
  try { salt = Buffer.from(JSON.parse(fs.readFileSync(f, 'utf8')).salt, 'base64'); } catch { salt = crypto.randomBytes(16); }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(encrypt({ entries }, salt)), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

// Clean the submitted fields: every required one present, trimmed, no other names.
function clean(provider, fields) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown account "${provider}"`);
  const out = {};
  for (const f of Object.keys(p.fields)) {
    const v = String((fields || {})[f] ?? '').replace(/\r/g, '').trim();
    if (!v && !(p.optional || []).includes(f)) throw new Error(`${p.label}: "${f}" is required`);
    if (v.length > 4096) throw new Error(`${p.label}: "${f}" is too long`);
    if (v) out[f] = v;
  }
  return out;
}

function writable() {
  if (!token()) throw new Error('VAULT_LOCKED: set LAN_ACCESS_TOKEN (24+ random characters) in .env first: the vault is encrypted with it');
  if (state.locked) throw new Error(`VAULT_LOCKED: ${state.reason}`);
}
function save(provider, fields, test = null) {
  writable();
  entries[provider] = { fields: clean(provider, fields), savedAt: Date.now(), test };
  persist();
  apply();
}
function remove(provider) {
  writable();
  delete entries[provider];
  persist();
  apply();
}

const mask = (v) => { const s = String(v || ''); if (s.includes('@')) return `${s[0]}…@${s.split('@')[1]}`; return s.length >= 10 ? `${s.slice(0, 4)}…${s.slice(-3)}` : '••••'; };
// Is a provider set up from .env (not the vault)?
function fromEnv(id) {
  const p = PROVIDERS[id];
  const v = (env) => String(process.env[env] || '').trim();
  if (id === 'alpacaPaper') { const c = require('../connectors/alpaca-api').credentials(require('../connectors/alpaca-api').PAPER); return c.key && c.secret ? c.key : null; }
  if (id === 'alpacaLive') return v('ALPACA_API_KEY') && v('ALPACA_API_SECRET') && !v('ALPACA_API_KEY').startsWith('PK') ? v('ALPACA_API_KEY') : null;
  if (id === 'gmail') return ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'ALERT_EMAIL_TO'].every((k) => v(k)) ? v('SMTP_USER') : null;
  return Object.values(p.fields).every((env) => v(env)) ? v(p.fields[p.preview]) : null;
}

// For the browser: never a secret.
function status() {
  const providers = Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => {
    const e = entries[id];
    const env = e ? null : fromEnv(id);
    return [id, { label: p.label, hint: p.hint, fields: Object.keys(p.fields), optional: p.optional || [], configured: !!(e || env), source: e ? 'vault' : env ? 'env' : null,
      preview: e ? mask(e.fields[p.preview]) : env ? mask(env) : null, savedAt: e ? e.savedAt : null, test: e ? e.test : null }];
  }));
  return { vault: { ...state, tokenSet: !!token() }, providers, anyBroker: ['alpacaPaper', 'alpacaLive', 'coinbase', 'kraken', 'okx'].some((id) => providers[id].configured) };
}

const _reset = () => { baseline = null; entries = {}; state = { ready: false, locked: false, reason: null }; }; // test hook

module.exports = { load, apply, save, remove, status, clean, mask, PROVIDERS, ENV_KEYS, file, _reset };
