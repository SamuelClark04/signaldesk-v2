// Gemini fallback models (Phase 86). Google answers "HTTP 503: This model is currently experiencing high demand" per MODEL (the
// free tier is shed first), and the alias gemini-flash-latest points at the newest, busiest one. When it is overloaded the AI
// Analyst tries the other stable Flash models THIS key can use, read from the key's own model list (GET /models: free, no tokens,
// cached CACHE_MS), so no model name is guessed: full Flash models newest first, then Flash-Lite (lighter, rarely overloaded).
// Previews, -latest aliases, TTS / live / image variants are skipped. Without a list (network error): FIXED.
const crypto = require('crypto');

const CACHE_MS = 6 * 3600 * 1000;
const LIST_TIMEOUT_MS = 4000;
const MAX_FALLBACKS = 5;
const STABLE = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/;
const FIXED = ['gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
let cache = null; // { at, key (hash), names }
const base = () => (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
const hash = (key) => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);

// The key's models that can generateContent (ids without "models/"). [] when Google cannot be read.
async function list(key, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (cache && cache.key === hash(key) && now - cache.at < CACHE_MS) return cache.names;
  const names = [];
  try {
    let token = '';
    for (let page = 0; page < 3; page += 1) {
      const res = await fetchImpl(`${base()}/models?pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`,
        { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
      if (!res.ok) break;
      const j = await res.json();
      for (const m of j.models || []) if ((m.supportedGenerationMethods || []).includes('generateContent')) names.push(String(m.name || '').replace(/^models\//, ''));
      token = j.nextPageToken;
      if (!token) break;
    }
  } catch { /* the fixed list below */ }
  cache = names.length ? { at: now, key: hash(key), names } : null;
  return names;
}

// Stable Flash models other than `primary`: full Flash newest first, then Flash-Lite newest first.
function rank(names, primary) {
  const v = (n) => { const m = STABLE.exec(n); return m ? { ver: Number(m[1]), lite: m[2] ? 1 : 0 } : null; };
  return [...new Set(names)].filter((n) => n !== primary && v(n)).sort((a, b) => (v(a).lite - v(b).lite) || (v(b).ver - v(a).ver));
}

async function fallbacks(key, primary, opts = {}) {
  const names = await list(key, opts);
  return (names.length ? rank(names, primary) : FIXED.filter((n) => n !== primary)).slice(0, MAX_FALLBACKS);
}

const reset = () => { cache = null; };

module.exports = { list, rank, fallbacks, reset, FIXED, MAX_FALLBACKS, CACHE_MS };
