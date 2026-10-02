// AI Trade Analyst (Phase 84): on-demand PRE_TRADE breakdowns (a staged setup) and IN_TRADE briefings (an open position).
//   POST /api/ai/analyze { mode, payload: { id } } (http-routes.js) -> analyze(): the facts are rebuilt on the SERVER from the
//   ledger (ai-payload.js), sent with a fixed risk-manager system prompt to OpenAI (OPENAI_API_KEY, model OPENAI_MODEL or
//   gpt-4o-mini) or Gemini (GEMINI_API_KEY, GEMINI_MODEL or gemini-flash-latest): settings.aiProvider 'auto' (the first key
//   configured) | 'openai' | 'gemini'. Keys come from the encrypted vault (Settings > Accounts & Connections) or .env and
//   travel in request headers only. 15 s abort per call; any failure is a clean { ok: false, error } (never a crash).
//   Phase 86 (answer()): a Gemini model that is overloaded (503 "high demand"), rate-limited (429), gone (404), failing (500) or
//   silent hands over to the key's other Flash models (gemini-models.js), then to the other provider when its key is set, all
//   within TOTAL_MS; the reply says which model answered.
//   Cost guard: the same mode + id is answered from a 60 s cache; at most MAX_PER_HOUR calls an hour.
//   Guardrails: the prompt forbids price / timing predictions and stop widening; the reply is also scanned for a timing claim
//   ("will hit ... in 3 hours") and flagged. The verdict line (Recommendation / Action) is parsed for the UI badge.
const facts = require('./ai-payload');

const TIMEOUT_MS = 15000;
const TOTAL_MS = 30000; // every attempt of one analysis (fallback models + the other provider)
const MIN_TRY_MS = 2000; // never start an attempt with less left than this
const HANDOVER = new Set([404, 429, 500, 502, 503, 504, 'timeout', 'network']); // the next model may answer; 400 / 401 / 403 never
const CACHE_MS = 60 * 1000;
const MAX_PER_HOUR = 30;
// Phase 85b: Google's hot-swapped alias for its current Flash model (gemini-2.5-flash is closed to new API users; 1.5 / 2.0 shut down).
const GEMINI_DEFAULT = 'gemini-flash-latest';
const MODELS = { openai: () => process.env.OPENAI_MODEL || 'gpt-4o-mini', gemini: () => process.env.GEMINI_MODEL || GEMINI_DEFAULT };
const KEYS = { openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
const BASE = { openai: () => (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  gemini: () => (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '') };
const cache = new Map(); // `${mode}|${id}` -> { at, result }
const calls = []; // times of provider calls (last hour)
const inFlight = new Map(); // `${mode}|${id}` -> promise

const SECTIONS = {
  PRE_TRADE: ['1. Setup Thesis Assessment', '2. Catalyst & News Conflict Check', '3. Risk/Reward & Spread Quality Check', '4. Final Recommendation'],
  IN_TRADE: ['1. Current State vs Original Thesis', '2. Market Noise vs Structural Invalidation', '3. Time Horizon & Greeks', '4. Action Plan'],
};
const VERDICT = { PRE_TRADE: { label: 'Recommendation', values: ['PROCEED', 'CAUTION', 'PASS'] }, IN_TRADE: { label: 'Action', values: ['HOLD', 'TAKE_PROFIT', 'TRIM', 'EXIT'] } };

function systemPrompt(mode) {
  const v = VERDICT[mode];
  return [
    'You are a Senior Quantitative Risk Manager and Trading Desk Coach reviewing ONE trade for an individual trader who uses SignalDesk.',
    'Tone: grounded, objective, candid and psychologically stabilizing. No hype, no fear, no filler.',
    'Rules:',
    '- Use ONLY the facts in the JSON you are given. If something is missing or null, say it is unknown. Never invent prices, levels, news or statistics.',
    '- Never predict or guarantee future prices, outcomes or timing (never "this will hit the target in X hours"). Speak in conditions: "if X holds..., if Y breaks...".',
    '- Stops are pre-committed decisions: never suggest moving a stop further away or removing it. Tightening, trimming or exiting early is fine when the facts justify it.',
    '- Weigh: technical thesis validity, catalysts and news conflicts, volatility, option time decay (DTE) when it is an option, bid/ask and fee costs, and stop discipline.',
    '- Say whether it is PAPER or LIVE money when it matters.',
    `Answer in Markdown with exactly these four headings, in order: ${SECTIONS[mode].map((s) => `"## ${s}"`).join(', ')}.`,
    mode === 'IN_TRADE' ? '- In section 3, if it is not an option, cover the time horizon and volatility instead of Greeks.' : '',
    `Keep it under 350 words. End with one last line exactly: "${v.label}: ${v.values.join(' | ')}" choosing ONE value.`,
  ].filter(Boolean).join('\n');
}

const userPrompt = (mode, f) => `Mode: ${mode}\nTrade facts (JSON, all prices in USD; the only source of truth):\n\`\`\`json\n${JSON.stringify(f, null, 1)}\n\`\`\``;

// Which provider answers. -> { provider, key, model } | null (no key configured)
function pickProvider(settings = {}) {
  const want = settings.aiProvider === 'openai' || settings.aiProvider === 'gemini' ? settings.aiProvider : 'auto';
  const order = want === 'auto' ? ['openai', 'gemini'] : [want];
  const id = order.find((p) => process.env[KEYS[p]]);
  return id ? { provider: id, key: process.env[KEYS[id]], model: MODELS[id]() } : null;
}

function request(p, system, user, opts = {}) {
  if (p.provider === 'openai') {
    const body = { model: p.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_completion_tokens: 900, ...(/^gpt-4/.test(p.model) ? { temperature: 0.3 } : {}) };
    return { url: `${BASE.openai()}/chat/completions`, headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' }, body };
  }
  return { url: `${BASE.gemini()}/models/${encodeURIComponent(p.model)}:generateContent`, headers: { 'x-goog-api-key': p.key, 'Content-Type': 'application/json' },
    body: geminiBody(p.model, system, user, opts) };
}

// Gemini generateContent body (Phase 85b): systemInstruction { parts: [{ text }] }, contents [{ role: 'user', parts: [{ text }] }],
// generationConfig { maxOutputTokens } and nothing a model may refuse: no temperature (Gemini 3 wants its 1.0 default), and a
// thinkingConfig only where it is documented (2.5 Flash / Flash-Lite: thinkingBudget 0 = off). A "flash" model without that field
// (2.0, Gemini 3: thinkingLevel; both fields at once is a 400) got "HTTP 400: Request contains an invalid argument". bare: required only.
const GEMINI_THINKING = [[/^gemini-2\.5-flash(-lite)?(-\d+)?$/, { thinkingBudget: 0 }]];
function geminiBody(model, system, user, { bare = false } = {}) {
  const thinking = bare ? null : (GEMINI_THINKING.find(([re]) => re.test(model)) || [])[1];
  return { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: { maxOutputTokens: 2048, ...(thinking ? { thinkingConfig: { ...thinking } } : {}) } };
}

const textOf = (provider, j) => (provider === 'openai' ? j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
  : j && j.candidates && j.candidates[0] && j.candidates[0].content && (j.candidates[0].content.parts || []).map((x) => x.text || '').join(''));

// "gemini HTTP 400: Request contains an invalid argument. [generation_config.thinking_config: ...]" (Google names the field in details).
function providerError(p, status, j) {
  const e = j && j.error;
  const fields = ((e && Array.isArray(e.details) && e.details) || []).flatMap((d) => d.fieldViolations || []).map((v) => `${v.field}: ${v.description}`).join('; ');
  const hint = p.provider === 'gemini' && status === 404 ? ` (model "${p.model}" is not available to this key: unset GEMINI_MODEL to use ${GEMINI_DEFAULT})` : '';
  return `${p.provider} HTTP ${status}${e ? `: ${String(e.message || e).slice(0, 200)}` : ''}${fields ? ` [${fields.slice(0, 200)}]` : ''}${hint}`;
}
const finishOf = (j) => { const c = j && j.candidates && j.candidates[0]; return (j && j.promptFeedback && j.promptFeedback.blockReason) || (c && c.finishReason) || null; };

// One provider call. -> { ok, text } | { ok: false, error }. Gemini: a 400 to a body with optional fields is retried once bare.
async function callProvider(p, system, user, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, bare = false } = {}) {
  const req = request(p, system, user, { bare });
  const until = Date.now() + timeoutMs;
  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ac.signal });
    const j = await res.json().catch(() => null);
    if (res.status === 400 && p.provider === 'gemini' && !bare && req.body.generationConfig.thinkingConfig) {
      console.warn(`[ai] ${providerError(p, 400, j)}; retried without thinkingConfig`);
      clearTimeout(kill);
      return callProvider(p, system, user, { fetchImpl, timeoutMs: Math.max(1000, until - Date.now()), bare: true });
    }
    if (!res.ok) return { ok: false, status: res.status, error: providerError(p, res.status, j) };
    const text = textOf(p.provider, j);
    return text && text.trim() ? { ok: true, text: text.trim() } : { ok: false, error: `${p.provider} returned no text${finishOf(j) ? ` (${finishOf(j)})` : ''}` };
  } catch (err) {
    return { ok: false, status: ac.signal.aborted ? 'timeout' : 'network', error: ac.signal.aborted ? `${p.provider} did not answer within ${timeoutMs >= 1000 ? Math.round(timeoutMs / 1000) : timeoutMs / 1000} s` : `${p.provider} unreachable (${err.message})` };
  } finally { clearTimeout(kill); }
}

// One analysis: the chosen model, then (Gemini, on a HANDOVER failure) the key's other Flash models, then the other provider if
// its key is set. -> { ok, text, provider, model, tried } | { ok: false, error, tried }
async function answer(p, system, user, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, totalMs = TOTAL_MS } = {}) {
  const until = Date.now() + totalMs;
  const left = () => until - Date.now();
  const tried = [];
  const attempt = async (q) => {
    const r = await callProvider(q, system, user, { fetchImpl, timeoutMs: Math.min(timeoutMs, left()) });
    if (r.ok) return { ...r, provider: q.provider, model: q.model, tried };
    tried.push({ provider: q.provider, model: q.model, status: r.status, error: r.error });
    return null;
  };
  const models = [p.model];
  for (let i = 0; i < models.length && left() >= MIN_TRY_MS; i += 1) {
    const ok = await attempt({ ...p, model: models[i] });
    if (ok) return ok;
    if (p.provider !== 'gemini' || !HANDOVER.has(tried[tried.length - 1].status)) break;
    if (i === 0) for (const m of await require('./gemini-models').fallbacks(p.key, p.model, { fetchImpl })) if (!models.includes(m)) models.push(m);
  }
  const o = p.provider === 'gemini' ? 'openai' : 'gemini';
  if (process.env[KEYS[o]] && left() >= MIN_TRY_MS) { const ok = await attempt({ provider: o, key: process.env[KEYS[o]], model: MODELS[o]() }); if (ok) return ok; }
  const busy = tried.length && tried.every((t) => t.status === 503 || t.status === 429);
  const list = tried.map((t) => `${t.model}: ${t.error.replace(/^(gemini|openai) /, '')}`).join(' | ');
  return { ok: false, tried, busy, error: busy
    ? `${tried.length > 1 ? `all ${tried.length} models tried are` : `${tried[0].model} is`} overloaded or rate-limited right now (${list.slice(0, 400)}). Google sheds free-tier traffic first under high demand: try again in a few minutes${process.env[KEYS.openai] ? '' : ', or add an OpenAI key as a backup (Settings > Accounts & Connections)'}.`
    : list.slice(0, 600) };
}

function verdictOf(mode, text) {
  const v = VERDICT[mode];
  const m = new RegExp(`${v.label}\\s*:\\s*\\**\\s*(${v.values.join('|')})\\b`, 'i').exec(text || '');
  return m ? m[1].toUpperCase() : null;
}
const timingClaim = (text) => /\bwill\s+(hit|reach|touch|get to)\b[^.\n]{0,60}\b(in|within|by)\s+(\d+|a few|the next)\s*(min|minute|hour|day|session)/i.test(text || '');

// { mode, payload: { id } } -> { ok, mode, provider, model, markdown, verdict, warnings, at, facts } | { ok: false, error, code }
async function analyze(input = {}, { settings = null, fetchImpl, timeoutMs, now = Date.now() } = {}) {
  const mode = input.mode === 'IN_TRADE' ? 'IN_TRADE' : input.mode === 'PRE_TRADE' ? 'PRE_TRADE' : null;
  const id = input.payload && typeof input.payload.id === 'string' ? input.payload.id.slice(0, 200) : null;
  if (!mode || !id) return { ok: false, code: 'BAD_REQUEST', error: 'mode (PRE_TRADE / IN_TRADE) and payload.id are required' };
  const set = settings || (() => { try { return require('../execution/paper-ledger').getSettings(); } catch { return {}; } })();
  const p = pickProvider(set);
  if (!p) return { ok: false, code: 'NO_KEY', error: 'AI Analyst API key missing: add an OpenAI or Gemini key in Settings > Accounts & Connections (or OPENAI_API_KEY / GEMINI_API_KEY in .env).' };
  const key = `${mode}|${id}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return { ...hit.result, cached: true };
  if (inFlight.has(key)) return inFlight.get(key);
  while (calls.length && now - calls[0] > 3600e3) calls.shift();
  if (calls.length >= MAX_PER_HOUR) return { ok: false, code: 'RATE_LIMIT', error: `AI Analyst limit reached (${MAX_PER_HOUR} analyses an hour); try again later.` };
  const job = (async () => {
    const f = await facts.build(mode, id, now);
    if (!f.ok) return { ok: false, code: 'NOT_FOUND', error: f.error };
    calls.push(now);
    const r = await answer(p, systemPrompt(mode), userPrompt(mode, f.facts), { fetchImpl, timeoutMs });
    if (!r.ok) return { ok: false, code: r.busy ? 'BUSY' : 'PROVIDER', error: r.busy ? `AI Analyst: ${r.error}` : `AI Analyst provider unreachable or refused: ${r.error}`, provider: p.provider, model: p.model };
    const warnings = timingClaim(r.text) ? ['The reply contains a timing prediction; SignalDesk cannot verify it: ignore it.'] : [];
    if (r.tried.length) warnings.push(`${r.tried.map((t) => t.model).join(', ')} ${r.tried.length > 1 ? 'were' : 'was'} unavailable (${[...new Set(r.tried.map((t) => t.status))].join(' / ')}); answered by ${r.model}.`);
    const result = { ok: true, mode, id, provider: r.provider, model: r.model, markdown: r.text, verdict: verdictOf(mode, r.text), warnings, at: now, facts: f.facts };
    cache.set(key, { at: now, result });
    return result;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

const reset = () => { cache.clear(); calls.length = 0; inFlight.clear(); };

module.exports = { analyze, answer, TOTAL_MS, systemPrompt, userPrompt, pickProvider, request, geminiBody, providerError, GEMINI_DEFAULT, callProvider, verdictOf, timingClaim, reset, SECTIONS, VERDICT, TIMEOUT_MS, MAX_PER_HOUR, CACHE_MS };
