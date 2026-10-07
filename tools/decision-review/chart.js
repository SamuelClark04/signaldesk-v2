// Inline SVG candles for one setup card (Phase 93): the chart BEFORE the decision (as the app saw it: RECORDED bars when captured,
// else FETCHED), the path AFTER it to the planned end, the decision time, and the entry / stop / T1 / T2 levels. No scripts, no fonts.
const W = 760; const H = 230; const PAD = { l: 8, r: 64, t: 14, b: 22 };

// Group rows into at most `max` candles.
function bucketize(rows, max) {
  if (rows.length <= max) return rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4] }));
  const per = Math.ceil(rows.length / max); const out = [];
  for (let i = 0; i < rows.length; i += per) {
    const g = rows.slice(i, i + per).filter(Boolean);
    if (!g.length) continue;
    out.push({ t: g[0][0], o: g[0][1], h: Math.max(...g.map((r) => r[2])), l: Math.min(...g.map((r) => r[3])), c: g[g.length - 1][4] });
  }
  return out;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (x) => (x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(3) : x.toPrecision(4));

// opts: { pre, post, t0, levels, p0, d, preLabel, postLabel }
function svg(opts) {
  const pre = (opts.pre || []).filter((r) => r && Number.isFinite(r[4]));
  const post = (opts.post || []).filter((r) => r && Number.isFinite(r[4]));
  if (!pre.length && !post.length) return '<p class="nochart">No chart data.</p>';
  const nPost = Math.max(10, Math.round(140 * (post.length / Math.max(1, pre.length + post.length))));
  const a = bucketize(pre, 140 - Math.min(nPost, 100)); const b = bucketize(post, Math.min(nPost, 100));
  const all = [...a.map((c) => ({ ...c, pre: true })), ...b];
  const L = opts.levels || {};
  const lv = [['entry', L.entry], ['stop', L.stop], ['T1', L.t1], ['T2', L.t2]].filter(([, v]) => v > 0);
  let lo = Math.min(...all.map((c) => c.l), ...lv.map(([, v]) => v)); let hi = Math.max(...all.map((c) => c.h), ...lv.map(([, v]) => v));
  if (!(hi > lo)) { hi = lo * 1.01 + 0.01; lo *= 0.99; }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const iw = W - PAD.l - PAD.r; const ih = H - PAD.t - PAD.b;
  const x = (i) => PAD.l + (iw * (i + 0.5)) / all.length; const y = (p) => PAD.t + ih * (1 - (p - lo) / (hi - lo));
  const cw = Math.max(1, Math.min(7, (iw / all.length) * 0.7));
  const parts = [];
  all.forEach((c, i) => {
    const up = c.c >= c.o; const cls = c.pre ? 'pre' : up ? 'up' : 'dn';
    parts.push(`<line class="wick ${cls}" x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(c.h).toFixed(1)}" y2="${y(c.l).toFixed(1)}"/>`);
    const top = y(Math.max(c.o, c.c)); const bot = y(Math.min(c.o, c.c));
    parts.push(`<rect class="body ${cls}" x="${(x(i) - cw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${cw.toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}"/>`);
  });
  for (const [name, v] of lv) {
    parts.push(`<line class="lvl ${name.toLowerCase()}" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`);
    parts.push(`<text class="lvl-t ${name.toLowerCase()}" x="${W - PAD.r + 4}" y="${(y(v) + 4).toFixed(1)}">${name} ${money(v)}</text>`);
  }
  if (a.length) {
    const xd = (x(a.length - 1) + x(a.length)) / 2;
    parts.push(`<line class="t0" x1="${xd.toFixed(1)}" x2="${xd.toFixed(1)}" y1="${PAD.t}" y2="${H - PAD.b}"/>`);
    parts.push(`<text class="ax" x="${(xd + 4).toFixed(1)}" y="${PAD.t + 10}">decision</text>`);
  }
  const lab = `${opts.preLabel ? `before: ${esc(opts.preLabel)}` : ''}${opts.postLabel ? `   after: ${esc(opts.postLabel)}` : ''}`;
  parts.push(`<text class="ax" x="${PAD.l}" y="${H - 6}">${lab}</text>`);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="price chart around the decision">${parts.join('')}</svg>`;
}

module.exports = { svg, bucketize, esc };
