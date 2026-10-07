// Phase 95 Task 2.2: the Google Cloud Storage client (service-account JWT signed with node's crypto, no dependency). A local fake
// token + storage server verifies the JWT signature with the test key's public half. No network. Run: node tests/ph95gcs.js
const http = require('http'); const crypto = require('crypto'); const path = require('path');
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${x ? ` - ${x}` : ''}`); if (!ok) fails += 1; };

(async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const objects = new Map(); const seen = { tokenBodies: [], auth: [] };
  const srv = http.createServer((req, res) => {
    let body = []; req.on('data', (c) => body.push(c)); req.on('end', () => {
      body = Buffer.concat(body); const u = new URL(req.url, 'http://x');
      const send = (code, obj, raw) => { res.writeHead(code, { 'content-type': raw ? 'application/octet-stream' : 'application/json' }); res.end(raw || JSON.stringify(obj)); };
      if (u.pathname === '/token') {
        const p = new URLSearchParams(body.toString()); seen.tokenBodies.push(p);
        const [h, c, s] = p.get('assertion').split('.');
        const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url'));
        return ok ? send(200, { access_token: 'tok-1', expires_in: 3600 }) : send(401, { error: 'bad signature' });
      }
      seen.auth.push(req.headers.authorization);
      if (req.headers.authorization !== 'Bearer tok-1') return send(401, { error: 'no auth' });
      if (req.method === 'POST' && u.pathname === '/upload/storage/v1/b/bk/o') {
        const name = u.searchParams.get('name');
        if (name.startsWith('deny/')) return send(403, { error: { message: 'does not have storage.objects.create access' } });
        if (u.searchParams.get('ifGenerationMatch') === '0' && objects.has(name)) return send(412, { error: { message: 'precondition' } });
        objects.set(name, body); return send(200, { name, size: String(body.length) });
      }
      if (req.method === 'GET' && u.pathname === '/storage/v1/b/bk/o') {
        const prefix = u.searchParams.get('prefix') || ''; const names = [...objects.keys()].filter((n) => n.startsWith(prefix)).sort();
        const start = Number(u.searchParams.get('pageToken') || 0); const page = names.slice(start, start + 2);
        return send(200, { items: page.map((n) => ({ name: n, size: String(objects.get(n).length) })), ...(start + 2 < names.length ? { nextPageToken: String(start + 2) } : {}) });
      }
      const m = /^\/storage\/v1\/b\/bk\/o\/(.+)$/.exec(u.pathname);
      if (req.method === 'GET' && m && u.searchParams.get('alt') === 'media') { const n = decodeURIComponent(m[1]); return objects.has(n) ? send(200, null, objects.get(n)) : send(404, { error: { message: 'No such object' } }); }
      return send(404, { error: { message: 'unknown route' } });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const G = require(path.join(__dirname, '..', 'server', 'research', 'gcs'));
  const key = { type: 'service_account', client_email: 'sd-vm-writer@proj.iam.gserviceaccount.com', private_key: pem, token_uri: `${base}/token` };
  const c = G.client({ key, bucket: 'bk', scope: 'read_write', baseUrl: base });

  const up = await c.upload('raw/optq/2026-10-07/optq-2026-10-07-14.jsonl.gz', Buffer.from('hello'), { ifNotExists: true });
  const tb = seen.tokenBodies[0];
  const claims = JSON.parse(Buffer.from(tb.get('assertion').split('.')[1], 'base64url').toString());
  check('token: JWT bearer grant, RS256-signed with the service account key, claims iss / scope / aud / exp', tb.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer'
    && claims.iss === key.client_email && claims.scope === 'https://www.googleapis.com/auth/devstorage.read_write' && claims.aud === key.token_uri && claims.exp - claims.iat === 3600, JSON.stringify(claims));
  check('upload: stored, answered ok', up.ok === true && up.status === 200);
  const again = await c.upload('raw/optq/2026-10-07/optq-2026-10-07-14.jsonl.gz', Buffer.from('changed'), { ifNotExists: true });
  check('upload with ifNotExists: an existing object is NEVER overwritten (412 = exists)', again.ok === false && again.exists === true && objects.get('raw/optq/2026-10-07/optq-2026-10-07-14.jsonl.gz').toString() === 'hello');
  check('the access token is cached (one token request for several calls)', seen.tokenBodies.length === 1);
  const denied = await c.upload('deny/x', Buffer.from('x'));
  check('a 403 is reported as { ok: false, status: 403, error } and never throws', denied.ok === false && denied.status === 403 && /create access/.test(denied.error));
  await c.upload('raw/events/2026-10-07/a.gz', Buffer.from('a')); await c.upload('raw/events/2026-10-07/b.gz', Buffer.from('bb')); await c.upload('raw/events/2026-10-07/c.gz', Buffer.from('ccc'));
  const list = await c.list('raw/events/');
  check('list: follows nextPageToken across pages, names and sizes', list.ok && list.items.map((i) => i.name).join() === 'raw/events/2026-10-07/a.gz,raw/events/2026-10-07/b.gz,raw/events/2026-10-07/c.gz'
    && list.items[2].size === 3, JSON.stringify(list));
  const got = await c.get('raw/events/2026-10-07/b.gz');
  check('get: the object bytes (alt=media), names URL-encoded', got.ok && got.body.toString() === 'bb');
  const missing = await c.get('raw/nope');
  check('get of a missing object: { ok: false, status: 404 }', missing.ok === false && missing.status === 404);
  const r = G.client({ key, bucket: 'bk', scope: 'read_only', baseUrl: base });
  await r.list('raw/'); const claims2 = JSON.parse(Buffer.from(seen.tokenBodies[1].get('assertion').split('.')[1], 'base64url').toString());
  check('a read-only client asks only for the read_only scope', claims2.scope === 'https://www.googleapis.com/auth/devstorage.read_only');
  check('errors never contain the private key', !JSON.stringify(denied).includes('PRIVATE KEY'));
  const bad = G.client({ key: { ...key, private_key: 'not a key' }, bucket: 'bk', scope: 'read_write', baseUrl: base });
  const b2 = await bad.upload('raw/x', Buffer.from('x'));
  check('an unusable key: { ok: false, error } (no throw, no key text)', b2.ok === false && !/not a key/.test(b2.error || ''), JSON.stringify(b2));
  const V = require(path.join(__dirname, '..', 'scripts', 'research', 'gcs-check')).verdict;
  check('gcs-check: a writer that can create but not list is OK; one that can also list is NOT AS INTENDED',
    V('writer', { ok: true, status: 200 }, { ok: false, status: 403 }).ok && !V('writer', { ok: true, status: 200 }, { ok: true, status: 200 }).ok);
  check('gcs-check: a reader that can list but not create is OK; a reader that can create is NOT AS INTENDED; a network error is never OK',
    V('reader', { ok: false, status: 403 }, { ok: true, status: 200 }).ok && !V('reader', { ok: true, status: 200 }, { ok: true, status: 200 }).ok
    && !V('reader', { ok: false, status: 0, error: 'ECONNREFUSED' }, { ok: true, status: 200 }).ok);
  srv.closeAllConnections(); await new Promise((r) => srv.close(r));
  console.log(`\nph95gcs: ${fails ? `${fails} FAIL` : 'all passed'}`);
  process.exitCode = fails ? 1 : 0; // no process.exit(): open keep-alive sockets trip a Windows libuv assertion
})().catch((e) => { console.error(e); process.exit(1); });
