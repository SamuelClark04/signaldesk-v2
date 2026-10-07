// Phase 94 Stage 1: starts the record-only event capture (the recorder's flush, the news poll, the earnings snapshot). The macro snapshot
// and option marks are taps inside macro-calendar.refresh / options-data.refreshQuotes. EVENTS_RECORDER=off starts nothing.
// Phase 95: RESEARCH_COLLECTOR=on in .env hands the news poll and the earnings snapshot to the separate research collector process
// (server/research/collector/main.js), so the two never poll twice; the server keeps its recorder, its stream tap and the taps.
const rec = require('./event-recorder');

const collectorPolls = () => String(process.env.RESEARCH_COLLECTOR || '').toLowerCase() === 'on';

function start() {
  if (String(process.env.EVENTS_RECORDER || '').toLowerCase() === 'off') return;
  rec.start();
  const news = require('./news-capture');
  news.useMarketOpen(() => require('../market/market-session').isEquityMarketOpen()); // the server's Alpaca clock, as before Phase 95
  if (collectorPolls()) { console.log('[event-capture] RESEARCH_COLLECTOR=on: the news poll and the earnings snapshot run in the research collector'); return; }
  news.start();
  require('./earnings-snapshot').start();
}
function stop() { rec.stop(); require('./news-capture').stop(); require('./earnings-snapshot').stop(); }

module.exports = { start, stop, collectorPolls };
