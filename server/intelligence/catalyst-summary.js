// "What SignalDesk is basing this move on" (Phase 62): a plain-English breakdown of
// every Moonshot leaderboard coin (and any symbol on Opportunities) in three parts:
//   technical  the exact 5m / 15m / 1h move, relative volume (vs the hour before /
//              its 6-hour average) and strength vs BTC, with the points each earned
//   social     CoinGecko trending rank, Reddit mentions + subreddits, cached news
//              sentiment, the 24h volume surge vs the prior 24h, watchlist reasons
//   verdict    what happened next: STAGED (awaiting approval) / HELD / FILTERED by a
//              downstream gate (the risk engine's or a strategy shield's own reason:
//              fee drag, R:R after fees, chart stop, live capital...) / COOLDOWN /
//              QUALIFIES (proposed on the next pass) / LOW_SCORE / WAITING (a score
//              without a live trigger is not a trade) / WATCHING
// Every figure is read from the same sources the decision used (the radar row,
// System 6's cooldown, rejection-stats.js, the ledger); nothing is estimated here.
// Read-only: it never changes a decision.
const ledger = require('../execution/paper-ledger');
const rejections = require('../execution/rejection-stats');
const spec = require('../strategies/6-speculative-crypto');
const social = require('../connectors/crypto-social');
const sentiment = require('../connectors/news-sentiment');

const SPEC_ID = spec.STRATEGY_ID;
const pct = (x, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}%` : '—'); // x already in %
const x1 = (x) => (Number.isFinite(x) ? `${x.toFixed(1)}x` : '—');
const etDay = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
const clock = (t) => `${etDay(t) === etDay(Date.now()) ? '' : `${etDay(t)}, `}${new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET`;
const display = (s) => s.replace('-', '/');
const RECENT_REJECTION_MS = 3 * 60 * 1000; // re-recorded every pass while it still applies

// Current ledger context, read once per radar pass (or per feed request).
function context() {
  return { pending: ledger.getPendingOrders(), positions: ledger.getActivePositions() };
}

function technical(r, btc) {
  const lines = r.kind === 'COIL'
    ? [`${pct(r.move1h)} in the last hour, breaking out of a tight 3-hour base (coil needs +1.5% to +5%)`,
      `Volume ${x1(r.volVs6h)} its prior 6-hour average (coil needs 2.8x)`]
    : [`${pct(r.move5)} on the 5m frame (last 15 min) · ${pct(r.move15)} on the 15m frame (last 30 min)${Number.isFinite(r.move1h) ? ` · ${pct(r.move1h)} in 1h` : ''}`,
      `Relative volume ${x1(r.relVol)} vs the hour before (ignition needs 2.2x)${Number.isFinite(r.volVs6h) ? ` · ${x1(r.volVs6h)} vs its 6-hour average` : ''}`];
  lines.push(`vs BTC ${pct(r.vsBtc)} relative strength${btc && Number.isFinite(btc.move5) ? ` (BTC ${pct(btc.move5)} over 15 min)` : ''}`
    + ` · bid/ask spread ${r.spreadPct === null || r.spreadPct === undefined ? 'n/a' : `${r.spreadPct}%`}`);
  const p = r.parts || {};
  return { key: 'technical', title: 'Technical & volume driver', lines,
    points: `${r.kind === 'COIL' ? 'coil pattern' : 'velocity'} ${p.velocity}/25 · volume ${p.volume}/25 · vs BTC ${p.rs}/12 · spread ${p.spread}/8` };
}

function socialDriver(r) {
  const b = r.buzzDetail || {};
  const posts = social.postsFor(r.symbol, 100);
  const subs = [...new Set(posts.map((p) => `r/${p.subreddit}`))];
  const lines = [];
  lines.push(b.trendingRank ? `CoinGecko trending #${b.trendingRank} right now (${b.trending}/15 pts)` : 'Not on CoinGecko\'s trending list');
  lines.push(b.mentions ? `Reddit: ${b.mentions} post${b.mentions === 1 ? ' mentions' : 's mention'} it (${b.recent || 0} in the last 6 h) in ${subs.join(', ') || 'the scanned subreddits'} (${b.reddit}/15 pts)`
    : 'Reddit: no mention in the cached posts of the 5 scanned subreddits');
  const news = sentiment.peek(r.symbol);
  if (news && news.ok && news.score !== null) lines.push(`News sentiment ${news.score}/100 ${news.label} (${b.news}/15 pts, ${news.source})`);
  if (Number.isFinite(r.volChange) && r.volChange >= 0.5) lines.push(`24h volume surge: ${pct(r.volChange * 100, 0)} vs the prior 24h`);
  if (Number.isFinite(r.change24h)) lines.push(`24h price ${pct(r.change24h, 1)}${r.volumeUsd ? ` on $${Math.round(r.volumeUsd).toLocaleString('en-US')} of 24h volume` : ''}`);
  if (b.volumeCatalyst) lines.push('Volume-catalyst credit: 3.5x+ relative volume counts as its own catalyst (12/30 without forum or news coverage)');
  if ((r.reasons || []).length) lines.push(`On the gem watchlist for: ${r.reasons.join(', ')}`);
  return { key: 'social', title: 'Social / trending driver', lines, points: `buzz ${r.parts ? r.parts.buzz : 0}/30` };
}

const rejectionText = (rej) => `${rej.reason}${rej.detail && rej.detail !== rej.reason ? ` (${rej.detail.replace(/^[A-Z_]+:\s*/, '').slice(0, 160)})` : ''}`;

// Staged / held come first: they are facts about the ledger, whatever the score says.
function ledgerVerdict(symbol, ctx) {
  const staged = ctx.pending.find((o) => o.asset === symbol);
  if (staged) return { status: 'STAGED', text: `Staged as ${staged.setupType || 'a setup'}${staged.stagedAt ? ` at ${clock(staged.stagedAt)}` : ''}: risk $${Number(staged.dollarRisk || 0).toFixed(2)} on ${staged.positionSize} units, awaiting your approval.` };
  const held = ctx.positions.find((p) => p.asset === symbol);
  if (held) return { status: 'HELD', text: `Position open (${held.execution || 'PAPER'} ${held.direction}, ${held.setupType || held.strategyId}) since ${clock(held.openedAt || Date.now())}.` };
  return null;
}

function verdict(r, ctx, now) {
  const fromLedger = ledgerVerdict(r.symbol, ctx);
  if (fromLedger) return fromLedger;
  const label = spec.LABEL[r.trigger] || spec.LABEL[r.kind] || 'Trigger';
  const rej = rejections.latestFor(r.symbol, { strategyId: SPEC_ID }, now);
  const cd = spec.cooldownOf(r.symbol, now);
  if (r.trigger && r.score >= spec.CONFIG.qualify) {
    if (cd && rej && rej.at >= cd.proposedAt - 1000) {
      return { status: 'FILTERED', text: `${label} live at ${r.score}/100: proposed at ${clock(cd.proposedAt)}, then filtered by a downstream gate: ${rejectionText(rej)}. `
        + `The 4-hour cooldown holds re-proposals until ${clock(cd.until)}.` };
    }
    if (cd) return { status: 'COOLDOWN', text: `${label} live at ${r.score}/100: proposed at ${clock(cd.proposedAt)} (approved, dismissed or expired since). 4-hour cooldown until ${clock(cd.until)}.` };
    if (rej && now - rej.at < RECENT_REJECTION_MS) return { status: 'FILTERED', text: `${label} live at ${r.score}/100, filtered by a downstream gate: ${rejectionText(rej)}.` };
    return { status: 'QUALIFIES', text: `${label} live at ${r.score}/100 (needs ${spec.CONFIG.qualify}): the risk engine sizes it on the next scan pass (every 60 s).` };
  }
  if (r.trigger) return { status: 'LOW_SCORE', text: `${label} is live, but conviction ${r.score}/100 is under ${spec.CONFIG.qualify}: not proposed.` };
  if (r.score >= spec.CONFIG.qualify) return { status: 'WAITING', text: `Scores ${r.score}/100, but no entry trigger is live: a score alone is not a trade. Next: ${r.nearest || 'a fresh surge or coil breakout'}.` };
  return { status: 'WATCHING', text: `${r.score}/100, no trigger live. Next: ${r.nearest || 'a fresh surge or coil breakout'}.` };
}

// One Moonshot radar row -> its breakdown. btc: the radar's BTC moves.
function forRow(r, btc, ctx = context(), now = Date.now()) {
  const v = verdict(r, ctx, now);
  const trig = r.trigger ? `${r.trigger === 'COIL' ? 'Coil' : 'Ignition'} live` : `${r.kind === 'COIL' ? 'Coil' : 'Ignition'} forming`;
  return { symbol: r.symbol, at: now, score: r.score, badge: r.badge, trigger: r.trigger, headline: `${display(r.symbol)} ${r.score}/100 · ${trig} · ${v.status}`,
    verdict: v, drivers: [technical(r, btc), socialDriver(r), { key: 'verdict', title: 'Trigger & risk-gate verdict', status: v.status, lines: [v.text] }] };
}

// Any other symbol (Setups): its staged setup / position / latest rejection + social and news.
function forSymbol(symbol, ctx = context(), now = Date.now()) {
  const crypto = symbol.includes('-');
  const o = ctx.pending.find((x) => x.asset === symbol) || ctx.positions.find((x) => x.asset === symbol); // a staged setup, else the held trade's own
  const tech = o ? [`${o.setupType || o.strategyId || 'Setup'} · ${o.direction} · ${o.timeframe || '—'}${ctx.pending.includes(o) ? '' : ' (the open position’s entry case)'}`, ...(o.confirmationCriteria || []).slice(0, 3)]
    : ['No algorithmic setup on it right now (Market Watch).'];
  const lines = [];
  if (crypto) {
    const posts = social.postsFor(symbol, 100);
    const t = social.trendingList().coins.find((c) => c.product === symbol);
    lines.push(t ? `CoinGecko trending #${t.rank}` : 'Not on CoinGecko\'s trending list');
    lines.push(posts.length ? `Reddit: ${posts.length} cached post${posts.length === 1 ? '' : 's'} mention it in ${[...new Set(posts.map((p) => `r/${p.subreddit}`))].join(', ')}` : 'Reddit: no mention in the cached posts');
  }
  const news = sentiment.peek(symbol);
  lines.push(news && news.ok ? (news.score === null ? `News: no recent headlines (${news.source})` : `News sentiment ${news.score}/100 ${news.label} (${news.source})`) : 'News sentiment not loaded yet');
  let v = ledgerVerdict(symbol, ctx);
  if (!v) {
    const rej = rejections.latestFor(symbol, { market: crypto ? 'crypto' : o ? o.market : 'stocks' }, now) || (crypto ? null : rejections.latestFor(symbol, { market: 'options' }, now));
    v = rej ? { status: 'FILTERED', text: `${rej.setupType || rej.strategyId} setup filtered at ${clock(rej.at)}: ${rejectionText(rej)}.` }
      : { status: 'WATCHING', text: 'No strategy proposed a setup on it today; the scan re-checks it every 60 s.' };
  }
  return { symbol, at: now, score: null, headline: `${display(symbol)} · ${v.status}`, verdict: v,
    drivers: [{ key: 'technical', title: 'Technical & setup', lines: tech }, { key: 'social', title: 'Social / news', lines }, { key: 'verdict', title: 'Trigger & risk-gate verdict', status: v.status, lines: [v.text] }] };
}

module.exports = { forRow, forSymbol, context };
