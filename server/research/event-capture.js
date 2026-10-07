// Phase 94 Stage 1: starts the record-only event capture (the recorder's flush, the news poll, the earnings snapshot). The macro snapshot
// and option marks are taps inside macro-calendar.refresh / options-data.refreshQuotes. EVENTS_RECORDER=off starts nothing.
const rec = require('./event-recorder');

function start() {
  if (String(process.env.EVENTS_RECORDER || '').toLowerCase() === 'off') return;
  rec.start();
  require('./news-capture').start();
  require('./earnings-snapshot').start();
}
function stop() { rec.stop(); require('./news-capture').stop(); require('./earnings-snapshot').stop(); }

module.exports = { start, stop };
