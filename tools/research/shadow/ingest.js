// Phase 95 Task 3.3 (desktop mode): the collector's research-YYYY-MM-DD.jsonl files -> the research ledger.
//   OPTION_CANDIDATES -> candidates (research.sqlite; written once, never overwritten)
//   OPTION_QUOTES     -> quotes-YYYY-MM.sqlite (by the quote's provider time), feed + label kept
// A file is re-read only when its size changed (the day's file grows while the collector runs); every upsert is idempotent, so a
// re-read never duplicates. The JSONL files stay the record of origin (60 days on disk); the ledger keeps everything after that.
const fs = require('fs');
const path = require('path');
const W = require('../db');

function lines(file) {
  const out = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* a torn last line: read next time */ } }
  return out;
}

// -> { files, candidates, quotes } counts of this run
function ingest(db, { dir, quotesDir, through = null }) {
  const seen = db.prepare('select size from files where name = ?');
  const mark = db.prepare('insert into files (name, sha256, size, kind, day, imported_at) values (?, ?, ?, ?, ?, ?) on conflict (name) do update set size = excluded.size, imported_at = excluded.imported_at');
  const out = { files: 0, candidates: 0, quotes: 0 };
  const names = fs.readdirSync(dir).filter((n) => /^research-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  const qdbs = new Map(); const qdb = (ym) => { if (!qdbs.has(ym)) qdbs.set(ym, W.openQuotes(quotesDir, ym)); return qdbs.get(ym); };
  try {
    for (const name of names) {
      const day = name.slice(9, 19); if (through && day > through) continue;
      const size = fs.statSync(path.join(dir, name)).size; const prev = seen.get(name);
      if (prev && prev.size === size) continue;
      const cands = []; const byMonth = new Map();
      for (const e of lines(path.join(dir, name))) {
        if (e.kind === 'OPTION_CANDIDATES') {
          for (const r of e.rows || []) cands.push({ recordedAt: e.at, underlying: e.underlying, bucket: r.bucket, side: r.side, contract: r.contract, expiry: r.expiry, strike: r.strike, delta: r.delta, dte: r.dte, rule: `${r.rule}|spot=${e.spot}` });
        } else if (e.kind === 'OPTION_QUOTES') {
          for (const r of e.rows || []) {
            const [contract, tQuote, bid, ask, bidSize, askSize, iv, delta] = r; if (!contract || !Number.isFinite(tQuote)) continue;
            const ym = new Date(tQuote).toISOString().slice(0, 7);
            if (!byMonth.has(ym)) byMonth.set(ym, []);
            byMonth.get(ym).push({ contract, tQuote, tRecv: e.tRecv || e.at, bid, ask, bidSize, askSize, iv, delta, feed: e.label || 'INDICATIVE_ESTIMATE', pinned: e.src === 'Q' || e.src === 'DW' });
          }
        }
      }
      out.candidates += W.upsertCandidates(db, cands);
      for (const [ym, rows] of byMonth) out.quotes += W.upsertQuotes(qdb(ym), rows);
      mark.run(name, null, size, 'research', day, Date.now()); out.files += 1;
    }
  } finally { for (const q of qdbs.values()) q.close(); }
  return out;
}

module.exports = { ingest, lines };
