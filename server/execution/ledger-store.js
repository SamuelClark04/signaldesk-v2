// Ledger storage: disk persistence + user-editable settings for paper-ledger.js.
// The ledger owns the trading lists and their mechanics; this module owns how
// they (and the settings) are written to and restored from
// server/data/ledger-state.json. Only paper-ledger.js should require this file.
const fs = require('fs');
const path = require('path');

const STATE_PATH = process.env.LEDGER_STATE_PATH || path.join(__dirname, '..', 'data', 'ledger-state.json');
const { RISK_PROFILES, DEFAULT_PROFILE, riskPctFor } = require('../risk/risk-profiles');
const { LEVELS: STRICTNESS_LEVELS, DEFAULT_LEVEL: DEFAULT_STRICTNESS } = require('../risk/strictness');
const { CAPITAL_CHOICES, DEFAULT_MAX_CAPITAL_PCT } = require('../risk/risk-engine');

const STATE_VERSION = 3; // v2 adds settings; v3 adds savedSetups (optional: older files load with none)

// Editable settings: default and accepted values for each key. Execution modes
// default to 'paper', and a missing/invalid saved mode falls back to 'paper', so
// nothing can switch to live except an explicit, valid user update.
const MODES = ['paper', 'live'];
const SETTINGS_RULES = {
  bankroll: { type: 'number', default: 50000, min: 100, max: 100000000 },
  stockMode: { type: 'choice', default: 'paper', values: MODES }, // Alpaca: stocks + options
  cryptoMode: { type: 'choice', default: 'paper', values: MODES }, // Coinbase: crypto
  riskProfile: { type: 'choice', default: DEFAULT_PROFILE, values: Object.keys(RISK_PROFILES) }, // % risked per new trade
  strictness: { type: 'choice', default: DEFAULT_STRICTNESS, values: Object.keys(STRICTNESS_LEVELS) }, // setup gates (risk/strictness.js)
  maxCapitalPct: { type: 'choice', default: DEFAULT_MAX_CAPITAL_PCT, values: [...CAPITAL_CHOICES] }, // Max Capital Per Trade (risk-engine.js)
  // Phase 60: System 5 refuses a spread whose projected exit slippage (0.15 x the
  // combined leg bid/ask x 100) is over this many dollars per contract, while on.
  optionExitSpreadOn: { type: 'choice', default: true, values: [true, false] },
  maxOptionExitSpread: { type: 'number', default: 8, min: 0, max: 500 },
};
const settings = Object.fromEntries(Object.entries(SETTINGS_RULES).map(([k, r]) => [k, r.default]));

let lists = null; // the ledger's { pendingOrders, activePositions, tradeJournal, discardedOrders }

function cleanValue(key, value, rule) {
  if (rule.type === 'choice') {
    if (!rule.values.includes(value)) throw new Error(`${key} must be one of: ${rule.values.join(', ')}`);
    return value;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < rule.min || n > rule.max) {
    throw new Error(`${key} must be a number between ${rule.min} and ${rule.max}`);
  }
  return n;
}

// Validate a partial settings object; returns only the known, valid keys.
function cleanSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('settings must be an object');
  const clean = {};
  for (const [key, value] of Object.entries(input)) {
    const rule = SETTINGS_RULES[key];
    if (!rule) throw new Error(`unknown setting "${key}"`);
    clean[key] = cleanValue(key, value, rule);
  }
  return clean;
}

// ---------- Persistence ----------
// Write to a temp file then rename, so a crash mid-write never leaves a torn file.
// A failed save is logged, not thrown: the in-memory ledger stays authoritative.
function save() {
  if (!lists) throw new Error('ledger-store: attach() the ledger lists before saving');
  const state = { version: STATE_VERSION, savedAt: new Date().toISOString(), settings, ...lists };
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  } catch (err) {
    console.error(`[ledger] FAILED to save state to ${STATE_PATH}: ${err.message}`);
  }
}

// Settings are restored key by key: a missing (v1 file) or invalid value keeps its
// default instead of discarding the whole ledger.
function restoreSettings(saved) {
  if (!saved) return;
  for (const [key, value] of Object.entries(saved)) {
    try {
      Object.assign(settings, cleanSettings({ [key]: value }));
    } catch (err) {
      console.warn(`[ledger] ignoring saved setting: ${err.message}; keeping ${settings[key] ?? 'default'}`);
    }
  }
}

// An unreadable file is moved aside (never silently overwritten) and the ledger starts empty.
function load() {
  if (!fs.existsSync(STATE_PATH)) return;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    // Core lists must be present; optional lists added later (savedSetups) may be
    // missing from older files, which then load with an empty list, never as corrupt.
    for (const key of Object.keys(lists)) {
      if (state[key] === undefined && OPTIONAL_LIST_KEYS.includes(key)) continue;
      if (!Array.isArray(state[key])) throw new Error(`"${key}" is missing or not an array`);
    }
    for (const [key, list] of Object.entries(lists)) if (Array.isArray(state[key])) list.push(...state[key]);
    restoreSettings(state.settings);
    const { pendingOrders, activePositions, tradeJournal, discardedOrders } = lists;
    console.log(`[ledger] restored ${pendingOrders.length} pending, ${activePositions.length} open, `
      + `${tradeJournal.length} closed, ${discardedOrders.length} rejected, bankroll $${settings.bankroll} from ${STATE_PATH}`);
  } catch (err) {
    const aside = `${STATE_PATH}.corrupt-${Date.now()}`;
    try { fs.renameSync(STATE_PATH, aside); } catch { /* leave it in place */ }
    console.error(`[ledger] could not load ${STATE_PATH} (${err.message}); moved to ${aside}, starting empty`);
  }
}

const LIST_KEYS = ['pendingOrders', 'activePositions', 'tradeJournal', 'discardedOrders'];
const OPTIONAL_LIST_KEYS = ['savedSetups', 'pilotActions'];

// Called once by the ledger at startup: remembers its lists and restores from disk.
// Checked BEFORE touching the file, so a wiring mistake can never cause a good
// state file to be treated as corrupt and moved aside.
function attach(ledgerLists) {
  if (lists) throw new Error('ledger-store: already attached');
  if (!ledgerLists || !LIST_KEYS.every((k) => Array.isArray(ledgerLists[k]))) {
    throw new Error(`ledger-store: attach() needs arrays for ${LIST_KEYS.join(', ')}`);
  }
  lists = ledgerLists;
  load();
}

// ---------- Settings ----------
// riskPct and the profile/strictness tables are derived (never stored), so the
// UI shows the server's numbers instead of keeping its own copy.
const getSettings = () => ({ ...settings, riskPct: riskPctFor(settings.riskProfile), riskProfiles: { ...RISK_PROFILES }, maxCapitalChoices: [...CAPITAL_CHOICES],
  strictnessLevels: Object.fromEntries(Object.entries(STRICTNESS_LEVELS).map(([k, v]) => [k, { ...v }])) });

// Validates, applies and persists. Throws (changing nothing) if any value is invalid.
function updateSettings(newSettings) {
  const clean = cleanSettings(newSettings);
  Object.assign(settings, clean);
  save();
  return getSettings();
}

// Copy of the current state file (before a destructive change such as a paper
// reset). Returns the backup path, or null when there is no file yet.
function backup(tag) {
  if (!fs.existsSync(STATE_PATH)) return null;
  const dest = `${STATE_PATH}.${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(STATE_PATH, dest);
  return dest;
}

module.exports = { attach, save, backup, getSettings, updateSettings };
