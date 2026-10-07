// Phase 95 (plan 9.1, Task 2.2): a minimal Google Cloud Storage client for the research transfer. Shared by the VM collector's
// exporter (a key that may only CREATE objects) and the PC puller (a key that may only READ). Service-account auth: a JWT signed
// RS256 with node's crypto (no dependency), exchanged for an access token that is cached until 60 s before it expires.
// Every call answers { ok, status, ... } and never throws; errors never contain key material.
//   client({ key, bucket, scope: 'read_write' | 'read_only', baseUrl?, timeoutMs? })
//     .upload(name, buffer, { ifNotExists })  -> { ok, status, exists? }   (ifNotExists: an existing object is never overwritten)
//     .list(prefix)                            -> { ok, items: [{ name, size }] }  (all pages)
//     .get(name)                               -> { ok, body: Buffer }
const crypto = require('crypto');

const SCOPES = { read_write: 'https://www.googleapis.com/auth/devstorage.read_write', read_only: 'https://www.googleapis.com/auth/devstorage.read_only' };
const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
const clean = (s) => String(s || '').replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[key]').slice(0, 300);

function client({ key, bucket, scope = 'read_only', baseUrl = 'https://storage.googleapis.com', timeoutMs = 30000 }) {
  let token = null; let tokenExp = 0;
  const tokenUri = (key && key.token_uri) || 'https://oauth2.googleapis.com/token';

  async function auth() {
    if (token && Date.now() < tokenExp - 60000) return { ok: true };
    try {
      const iat = Math.floor(Date.now() / 1000);
      const unsigned = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ iss: key.client_email, scope: SCOPES[scope], aud: tokenUri, iat, exp: iat + 3600 })}`;
      const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url');
      const res = await fetch(tokenUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }), signal: AbortSignal.timeout(timeoutMs) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.access_token) return { ok: false, status: res.status, error: `token: ${clean(j.error_description || j.error || res.status)}` };
      token = j.access_token; tokenExp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
      return { ok: true };
    } catch (err) { return { ok: false, status: 0, error: `token: ${err.code === 'ERR_OSSL_UNSUPPORTED' || /key/i.test(err.message) ? 'the service-account key could not be used' : clean(err.message)}` }; }
  }

  async function call(method, url, body, headers = {}) {
    const a = await auth(); if (!a.ok) return a;
    try {
      const res = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, ...headers }, body, signal: AbortSignal.timeout(timeoutMs) });
      return { res };
    } catch (err) { return { ok: false, status: 0, error: clean(err.message) }; }
  }
  const errOf = async (res) => { const j = await res.json().catch(() => ({})); return clean((j.error && (j.error.message || j.error)) || `HTTP ${res.status}`); };
  const o = (name) => encodeURIComponent(name);

  async function upload(name, buf, { ifNotExists = true } = {}) {
    const q = new URLSearchParams({ uploadType: 'media', name }); if (ifNotExists) q.set('ifGenerationMatch', '0');
    const r = await call('POST', `${baseUrl}/upload/storage/v1/b/${bucket}/o?${q}`, buf, { 'content-type': 'application/octet-stream' });
    if (!r.res) return r;
    if (r.res.status === 412) return { ok: false, status: 412, exists: true };
    return r.res.ok ? { ok: true, status: r.res.status } : { ok: false, status: r.res.status, error: await errOf(r.res) };
  }
  async function list(prefix) {
    const items = []; let pageToken = null;
    do {
      const q = new URLSearchParams({ prefix }); if (pageToken) q.set('pageToken', pageToken);
      const r = await call('GET', `${baseUrl}/storage/v1/b/${bucket}/o?${q}`);
      if (!r.res) return r;
      if (!r.res.ok) return { ok: false, status: r.res.status, error: await errOf(r.res) };
      const j = await r.res.json(); for (const it of j.items || []) items.push({ name: it.name, size: Number(it.size) });
      pageToken = j.nextPageToken || null;
    } while (pageToken);
    return { ok: true, status: 200, items };
  }
  async function get(name) {
    const r = await call('GET', `${baseUrl}/storage/v1/b/${bucket}/o/${o(name)}?alt=media`);
    if (!r.res) return r;
    return r.res.ok ? { ok: true, status: 200, body: Buffer.from(await r.res.arrayBuffer()) } : { ok: false, status: r.res.status, error: await errOf(r.res) };
  }
  return { upload, list, get };
}

module.exports = { client, SCOPES };
