// Which code is running (Phase 89c): the git commit of the checkout, read ONCE when the server starts (a later `git pull` without a
// restart does not change what is running). Logged at boot ("[version] running <commit>") and served, with the settings that decide
// what can trade, at GET /api/version (signed-in only: http-routes.installVersion). Never throws: no git -> 'unknown'.
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const git = (args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim(); } catch { return null; } };
const BOOT = Object.freeze({ commit: git(['rev-parse', '--short', 'HEAD']) || 'unknown', subject: git(['log', '-1', '--pretty=%s']) || '', dirty: !!git(['status', '--porcelain', '--untracked-files=no']),
  startedAt: new Date().toISOString(), node: process.version });

// What can trade right now (no secrets): the switches, the books' modes, the paper broker, the paper-only lock (paperOnly) and the radar migration applied (radarVersion).
function report(settings = {}) {
  return { ...BOOT, strategiesEnabled: { ...(settings.strategiesEnabled || {}) }, strategyPauseVersion: settings.strategyPauseVersion ?? null, radarVersion: settings.radarVersion ?? null, paperOnly: settings.paperOnly ?? null,
    stockMode: settings.stockMode, cryptoMode: settings.cryptoMode, paperStockBroker: settings.paperStockBroker,
    dailyProfitTargetOn: settings.dailyProfitTargetOn, maxOpenPositions: settings.maxOpenPositions,
    decisionRecorder: (() => { try { return require('./research/decision-recorder').status(); } catch (err) { return { error: err.message }; } })() }; // Phase 93
}

module.exports = { BOOT, report };
