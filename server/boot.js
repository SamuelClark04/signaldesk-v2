// Process setup, before any other module (Phase 73; server.js requires it first):
//   1. .env (dotenv never overrides a variable that is already set)
//   2. IPv4 first for DNS: on a cloud VM without a working IPv6 route, Node tried the AAAA address
//      first and every request to Alpaca / Coinbase / RSS waited out its timeout ("fetch failed",
//      "timed out after 8s", scanner passes of ~25 minutes)
//   3. the credentials vault (Settings > Accounts & Connections) over .env: security/vault.js
require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');

const vault = require('./security/vault');
const v = vault.load();
vault.apply();
const s = vault.status();
const saved = Object.values(s.providers).filter((p) => p.source === 'vault').map((p) => p.label);
if (saved.length) console.log(`[vault] keys from the credentials vault: ${saved.join(', ')}`);
if (v.locked && v.reason && !/no access token/.test(v.reason)) console.warn(`[vault] ${v.reason}`);
if (!s.anyBroker) console.log('[setup] no broker keys yet: open SignalDesk and go to Settings > Accounts & Connections to connect Alpaca / Coinbase / Kraken / OKX');
