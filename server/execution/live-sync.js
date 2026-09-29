// Phase 79: the broker snapshot (Portfolio > Holdings, Live / External) follows SignalDesk's own LIVE trades.
// It used to change only at startup and on [Sync Broker], so a coin bought or sold after that stayed invisible
// (AVT / CRV bought after a 06:49 PM snapshot). Every WATCH_MS the LIVE positions' ids and sizes are compared
// with the last look; any change (a trade opened, closed, part-sold, voided or adopted) schedules a read-only
// broker sync SETTLE_MS later (fills have landed), coalesced, retried after broker-sync's 10 s gap when busy,
// then BROKER_HOLDINGS to every client and the external-holdings refresh. Balances GET only: never an order.
const brokerSync = require('../connectors/broker-sync');

const WATCH_MS = 5000;
const SETTLE_MS = 4000;
let last = null;
let pending = null;
let timer = null;
let broadcastRef = () => {};

const signature = (positions) => positions.filter((p) => p.execution === 'LIVE').map((p) => `${p.id}:${p.positionSize}`).sort().join('|');

async function run(why) {
  pending = null;
  let r;
  try { r = await brokerSync.syncPortfolio(); } catch (err) { console.error(`[broker-sync] refresh failed: ${err.message}`); return null; }
  if (!r.ok && r.busy) { pending = setTimeout(run, brokerSync.MIN_GAP_MS, why); pending.unref(); return null; }
  broadcastRef('BROKER_HOLDINGS', r.snapshot);
  console.log(`[broker-sync] holdings refreshed: ${why}`);
  await require('./external-api').brokerSynced().catch(() => {});
  return r;
}

function schedule(why) {
  if (pending) return false;
  pending = setTimeout(run, SETTLE_MS, why);
  pending.unref();
  return true;
}

// true when the LIVE book changed since the last look (the first look only records it).
function check(ledger) {
  const s = signature(ledger.getActivePositions());
  if (last === null || s === last) { last = s; return false; }
  const was = new Set(last.split('|').filter(Boolean).map((x) => x.split(':').slice(0, -1).join(':')));
  const now = new Set(s.split('|').filter(Boolean).map((x) => x.split(':').slice(0, -1).join(':')));
  const opened = [...now].filter((id) => !was.has(id)).length;
  const closed = [...was].filter((id) => !now.has(id)).length;
  last = s;
  schedule(`${opened ? `${opened} live trade(s) opened` : ''}${opened && closed ? ', ' : ''}${closed ? `${closed} closed` : ''}${!opened && !closed ? 'a live position changed size' : ''}`);
  return true;
}

function start(ledger, broadcast) {
  if (timer) return;
  broadcastRef = broadcast;
  check(ledger);
  timer = setInterval(() => { try { check(ledger); } catch (err) { console.error(`[broker-sync] live watch failed: ${err.message}`); } }, WATCH_MS);
  timer.unref();
}
const stop = () => { clearInterval(timer); timer = null; clearTimeout(pending); pending = null; last = null; };

module.exports = { start, stop, check, run, signature, WATCH_MS, SETTLE_MS };
