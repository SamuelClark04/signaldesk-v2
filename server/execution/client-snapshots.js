// Snapshots a newly connected client receives for the feeds added since Phase 55
// (server.js sends them in one line): the Moonshot Radar + the Coinbase gem
// catalog, and the after-hours options plans.
const radar = require('../intelligence/moonshot-radar');
const afterHours = require('./after-hours-plans');

const snapshots = () => [...radar.snapshots(), ['OPTIONS_PLANS', afterHours.snapshot()]];

module.exports = { snapshots };
