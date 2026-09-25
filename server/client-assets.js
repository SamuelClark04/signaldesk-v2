// Client files (Phase 55). Browsers had kept Phase 53 scripts after an upgrade:
// files served before Phase 54 carried no Cache-Control, so a browser could
// heuristically reuse them for hours without asking the server. Now:
//   index.html   rewritten on every load: each local script / stylesheet URL
//                gets ?v=<hash of the client files>, so any change to any client
//                file is a NEW URL (an old cached copy can never be picked up)
//   everything   served with Cache-Control: no-cache (always revalidated)
// Installed after the sign-in gate (server.js), like the static files it replaces.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const MEMO_MS = 5000; // re-hash at most every few seconds
const ASSET_RE = /\b(src|href)="((?:lib\/|views\/|styles\/)?[\w./-]+\.(?:js|css))"/g; // local files only (a CDN URL has "://")
const noCache = (res) => res.setHeader('Cache-Control', 'no-cache');

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}

// Short content hash of every client file (names + bytes).
function version(dir) {
  const h = crypto.createHash('sha256');
  for (const f of files(dir).sort()) h.update(path.relative(dir, f)).update(fs.readFileSync(f));
  return h.digest('hex').slice(0, 10);
}

function install(app, dir) {
  let memo = { at: 0, v: null };
  const current = () => {
    if (Date.now() - memo.at > MEMO_MS) memo = { at: Date.now(), v: version(dir) };
    return memo.v;
  };
  app.get(['/', '/index.html'], (req, res, next) => {
    try {
      const v = current();
      const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace(ASSET_RE, (m, attr, url) => `${attr}="${url}?v=${v}"`);
      noCache(res);
      res.type('html').send(html);
    } catch (err) {
      next(err);
    }
  });
  app.use(express.static(dir, { setHeaders: noCache }));
}

module.exports = { install, version, ASSET_RE };
