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
const toggles = require('../strategies/strategy-toggles');

const STATE_VERSION = 3; // v2 adds settings; v3 adds savedSetups (optional: older files load with none)

// Editable settings: default and accepted values for each key. Execution modes
// default to 'paper', and a missing/invalid saved mode falls back to 'paper', so
// nothing can switch to live except an explicit, valid user update.
const MODES = ['paper', 'live'];
const SETTINGS_RULES = {
  bankroll: { type: 'number', default: 50000, min: 100, max: 100000000 }, // PAPER stocks / options bankroll
  cryptoBankroll: { type: 'number', default: 50000, min: 100, max: 100000000 }, // PAPER crypto bankroll (Phase 70)
  stockMode: { type: 'choice', default: 'paper', values: MODES }, // Alpaca: stocks + options
  cryptoMode: { type: 'choice', default: 'paper', values: MODES }, // crypto: OKX US -> Kraken Pro -> Coinbase
  paperStockBroker: { type: 'choice', default: 'alpaca', values: ['alpaca', 'internal'] }, // Phase 71: paper stocks / options at Alpaca Paper, or simulated
  riskProfile: { type: 'choice', default: DEFAULT_PROFILE, values: Object.keys(RISK_PROFILES) }, // % risked per new trade
  strictness: { type: 'choice', default: DEFAULT_STRICTNESS, values: Object.keys(STRICTNESS_LEVELS) }, // setup gates (risk/strictness.js)
  maxCapitalPct: { type: 'choice', default: DEFAULT_MAX_CAPITAL_PCT, values: [...CAPITAL_CHOICES] }, // Max Capital Per Trade (risk-engine.js)
  // Phase 60: System 5 refuses a spread whose projected exit slippage (0.15 x the
  // combined leg bid/ask x 100) is over this many dollars per contract, while on.
  optionExitSpreadOn: { type: 'choice', default: true, values: [true, false] },
  maxOptionExitSpread: { type: 'number', default: 8, min: 0, max: 500 },
  // Phase 77 (risk/portfolio-risk.js): the book's open-risk ceiling (share of the bankroll) and the most
  // bullish / bearish equity trades open or staged at once.
  maxOpenRiskPct: { type: 'number', default: 0.06, min: 0.005, max: 0.5 },
  maxEquityPerDirection: { type: 'number', default: 2, min: 1, max: 20, integer: true },
  // Phase 78: per-strategy on / off (strategies/strategy-toggles.js; Crypto Swing off by default). A full map is saved.
  strategiesEnabled: { type: 'toggles', default: toggles.DEFAULTS, keys: toggles.IDS },
  // Phase 81: entry shields (risk/entry-shields.js): macro blackout (stocks / options; crypto opt-in), sector cap, daily loss ($, 0 = off).
  macroShield: { type: 'choice', values: [true, false], default: true },
  macroShieldCrypto: { type: 'choice', values: [true, false], default: false },
  maxTradesPerSector: { type: 'number', default: 1, min: 1, max: 20, integer: true },
  maxOptionEntriesPerDay: { type: 'number', default: 2, min: 0, max: 50, integer: true }, // Phase 87: options entry pacing (0 = off)
  // Phase 83: one kill switch per book ($, 0 = off): paper losses never pause live entries, and the reverse.
  dailyLossLimitPaper: { type: 'number', default: 150, min: 0, max: 1000000 },
  dailyLossLimitLive: { type: 'number', default: 25, min: 0, max: 1000000 },
  aiProvider: { type: 'choice', default: 'auto', values: ['auto', 'openai', 'gemini'] }, // Phase 84: AI Trade Analyst (keys in the vault / .env)
  // Phase 89: optional daily PROFIT target per book ($): reached (realized today) -> no new automated entries that day. Off by default.
  dailyProfitTargetOn: { type: 'choice', values: [true, false], default: false },
  dailyProfitTarget: { type: 'number', default: 200, min: 1, max: 1000000 },
  // Phase 89: max automated positions open + staged per book (paper / live, every market; 0 = off). Combined options + crypto
  // open risk uses maxOpenRiskPct of the combined paper bankrolls (risk/exposure-limits.js).
  maxOpenPositions: { type: 'number', default: 0, min: 0, max: 100, integer: true },
  strategyPauseVersion: { type: 'number', default: toggles.PAUSE.version, min: 0, max: 1000, integer: true }, // the research pause applied
  quickFlipsAutoPaper: { type: 'choice', values: [true, false], default: true }, // Phase 89: qualified Quick Flips execute on paper without a click
};
const settings = Object.fromEntries(Object.entries(SETTINGS_RULES).map(([k, r]) => [k, r.type === 'toggles' ? { ...r.default } : r.default]));

let lists = null; // the ledger's { pendingOrders, activePositions, tradeJournal, discardedOrders }

function cleanValue(key, value, rule) {
  if (rule.type === 'toggles') { // { id: true|false } for known ids; missing ids keep their defaults
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be an object of on / off switches`);
    for (const [k, v] of Object.entries(value)) {
      if (!rule.keys.includes(k)) throw new Error(`${key}: unknown strategy "${k}"`);
      if (typeof v !== 'boolean') throw new Error(`${key}.${k} must be true or false`);
    }
    return { ...rule.default, ...value };
  }
  if (rule.type === 'choice') {
    if (!rule.values.includes(value)) throw new Error(`${key} must be one of: ${rule.values.join(', ')}`);
    return value;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < rule.min || n > rule.max || (rule.integer && !Number.isInteger(n))) {
    throw new Error(`${key} must be a${rule.integer ? ' whole' : ''} number between ${rule.min} and ${rule.max}`);
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
// Phase 68 (P1-4): antivirus / file-sync tools briefly lock files on Windows (EPERM / EBUSY /
// EACCES on the rename): retry up to RETRY_MS.length times, pausing 25-100 ms (synchronous: a
// save is one call). Still failing: logged, and one background re-save is scheduled.
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_MS = [25, 50, 75, 100, 100];
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function renameRetry(from, to) {
  for (let i = 0; ; i += 1) {
    try { return fs.renameSync(from, to); } catch (err) {
      if (!RETRY_CODES.has(err.code) || i >= RETRY_MS.length) throw err;
      pause(RETRY_MS[i]);
    }
  }
}
let retryTimer = null;
const health = { ok: true, error: null, at: null };

// Write to a temp file then rename, so a crash mid-write never leaves a torn file.
// A failed save is logged, not thrown: the in-memory ledger stays authoritative.
function save() {
  if (!lists) throw new Error('ledger-store: attach() the ledger lists before saving');
  const state = { version: STATE_VERSION, savedAt: new Date().toISOString(), settings, ...lists };
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameRetry(tmp, STATE_PATH);
    Object.assign(health, { ok: true, error: null, at: Date.now() });
  } catch (err) {
    Object.assign(health, { ok: false, error: err.message, at: Date.now() });
    console.error(`[ledger] FAILED to save state to ${STATE_PATH}: ${err.message}${retryTimer ? '' : ' (retrying in 2 s)'}`);
    if (!retryTimer) { retryTimer = setTimeout(() => { retryTimer = null; save(); }, 2000); retryTimer.unref(); }
  }
}

// Settings are restored key by key: a missing (v1 file) or invalid value keeps its
// default instead of discarding the whole ledger.
function restoreSettings(saved) {
  if (!saved) return;
  // Phase 83: Phase 81's single dailyLossLimit becomes the PAPER book's limit (it was set against the paper losses).
  if (saved.dailyLossLimit !== undefined && saved.dailyLossLimitPaper === undefined) saved = { ...saved, dailyLossLimitPaper: saved.dailyLossLimit };
  const { dailyLossLimit, ...rest } = saved; // eslint-disable-line no-unused-vars
  for (const [key, value] of Object.entries(rest)) {
    try {
      Object.assign(settings, cleanSettings({ [key]: value }));
    } catch (err) {
      console.warn(`[ledger] ignoring saved setting: ${err.message}; keeping ${settings[key] ?? 'default'}`);
    }
  }
  // Phase 70: a ledger from before the crypto paper bankroll existed starts it at the (then shared) bankroll.
  if (saved.cryptoBankroll === undefined) settings.cryptoBankroll = settings.bankroll;
  // Phase 89: the one-time research pause (strategy-toggles.PAUSE); the user may switch them back on afterwards.
  const paused = toggles.applyPause(saved.strategyPauseVersion, settings.strategiesEnabled);
  if (paused) {
    settings.strategiesEnabled = paused;
    console.warn(`[ledger] Phase 89 research pause: ${toggles.PAUSES.filter((x) => !(Number(saved.strategyPauseVersion) >= x.version)).flatMap((x) => x.ids).join(', ')} switched off (open trades and exits unaffected)`);
  }
  settings.strategyPauseVersion = toggles.PAUSE.version;
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
const getSettings = () => ({ ...settings, strategiesEnabled: { ...settings.strategiesEnabled }, strategyLabels: { ...toggles.LABELS }, strategyNotes: { ...toggles.REASONS }, riskPct: riskPctFor(settings.riskProfile), riskProfiles: { ...RISK_PROFILES }, maxCapitalChoices: [...CAPITAL_CHOICES],
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

module.exports = {
  saveHealth: () => ({ ...health }), RETRY_MS, attach, save, backup, getSettings, updateSettings };
