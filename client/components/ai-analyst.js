// AI Trade Analyst modal (Phase 84). SD.aiAnalyst.open(mode, id, title):
//   PRE_TRADE  [AI Breakdown] on an Approvals card (a staged setup)
//   IN_TRADE   [AI Briefing] on the open position's Trade Panel (next to Manual Exit / Close Now)
// POSTs { mode, payload: { id } } to /api/ai/analyze (the SERVER builds the facts from the ledger), then shows the reply
// (lib/mini-markdown.js: text only, never HTML), the verdict badge, the facts it was given (collapsed), the provider /
// model, and a reminder that it is a model's opinion. Never blocks trading: Approve / Close stay where they were.
// Exposes window.SignalDesk.aiAnalyst.
(() => {
  const SD = window.SignalDesk;
  const { el } = SD.ui;
  const MODE = { PRE_TRADE: 'AI Breakdown', IN_TRADE: 'AI Briefing' };
  const TONE = { PROCEED: 'is-go', HOLD: 'is-go', CAUTION: 'is-warn', TRIM: 'is-warn', TAKE_PROFIT: 'is-warn', PASS: 'is-stop', EXIT: 'is-stop' };
  let overlay = null;
  let seq = 0;

  function close() { if (overlay) { overlay.remove(); overlay = null; document.removeEventListener('keydown', onKey); } }
  function onKey(e) { if (e.key === 'Escape') close(); }

  function shell(mode, title) {
    close();
    const body = el('div', { className: 'ai-body', textContent: 'Asking the analyst… (up to 15 s)' });
    const x = el('button', { type: 'button', className: 'btn ai-close', textContent: 'Close', title: 'Close (Esc)' });
    x.onclick = close;
    const box = el('div', { className: 'ai-modal', role: 'dialog' }, [
      el('header', { className: 'ai-head' }, [el('strong', { textContent: `${MODE[mode]} · ${title}` }), x]), body]);
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', `${MODE[mode]}: ${title}`);
    overlay = el('div', { className: 'ai-overlay' }, [box]);
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    x.focus();
    return body;
  }

  function result(body, r) {
    const md = SD.miniMarkdown.render(r.markdown, el);
    const facts = el('details', { className: 'ai-facts' }, [el('summary', { textContent: 'The facts the analyst was given' }), el('pre', { textContent: JSON.stringify(r.facts, null, 1) })]);
    body.replaceChildren(
      ...(r.verdict ? [el('div', { className: `ai-verdict ${TONE[r.verdict] || ''}`, textContent: `${r.mode === 'PRE_TRADE' ? 'Recommendation' : 'Action'}: ${r.verdict.replace('_', ' ')}` })] : []),
      ...(r.warnings || []).map((w) => el('p', { className: 'ai-warn', textContent: w })),
      el('div', { className: 'ai-md' }, md),
      facts,
      el('p', { className: 'ai-foot', textContent: `${r.provider === 'gemini' ? 'Gemini' : 'OpenAI'} · ${r.model}${r.cached ? ' · cached (under a minute old)' : ''} · `
        + 'A language model\'s opinion from the facts above, not financial advice: your stop, target and position size rules still decide.' }));
  }

  async function open(mode, id, title = '') {
    const body = shell(mode, title);
    const mine = ++seq;
    let r;
    try {
      const res = await fetch('/api/ai/analyze', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, payload: { id } }) });
      // Not JSON: the tunnel / proxy answered, not SignalDesk (a 502 / 504 while the server restarts or is busy).
      r = await res.json().catch(() => ({ ok: false, error: res.status >= 500
        ? `SignalDesk did not answer in time (HTTP ${res.status} from the tunnel): the server may be restarting or busy. Try again in a minute.`
        : `HTTP ${res.status}` }));
    } catch (err) {
      r = { ok: false, error: `Could not reach SignalDesk (${err.message})` };
    }
    if (mine !== seq || !overlay) return; // closed or replaced while waiting
    if (r.ok) result(body, r);
    else body.replaceChildren(el('p', { className: 'ai-error', textContent: r.error || 'AI Analyst unavailable' }),
      ...(r.code === 'NO_KEY' ? [el('p', { className: 'ai-foot', textContent: 'Settings > Accounts & Connections: paste an OpenAI or Gemini key and press Test & Save.' })] : []));
  }

  // The button the cards / panels add. kind: 'PRE_TRADE' | 'IN_TRADE'
  function button(mode, id, title, { disabled = false } = {}) {
    const b = el('button', { type: 'button', className: 'btn ai-btn', textContent: `✦ ${MODE[mode]}`, disabled,
      title: mode === 'PRE_TRADE' ? 'A risk manager\'s read on this setup before you approve it (AI; costs one API call)' : 'A risk manager\'s read on this open trade (AI; costs one API call)' });
    b.onclick = () => open(mode, id, title);
    return b;
  }

  SD.aiAnalyst = { open, button, close };
})();
