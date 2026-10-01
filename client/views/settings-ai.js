// Settings > AI Trade Analyst (Phase 84): which provider answers the [AI Breakdown] / [AI Briefing] buttons
// (settings.aiProvider: auto = the first key connected, OpenAI first). The API keys themselves are entered (masked,
// tested, encrypted) on the OpenAI / Google Gemini cards under Accounts & Connections, or come from .env.
// Exposes window.SignalDesk.aiSettings.
(() => {
  const SD = window.SignalDesk;
  const { $, el } = SD.ui;
  const CHOICES = [['auto', 'Auto (first key connected)'], ['openai', 'OpenAI (gpt-4o-mini)'], ['gemini', 'Google Gemini (gemini-flash-latest)']];
  let saved = null;

  function render(settings) {
    if (settings) saved = settings;
    const box = $('settings-ai');
    if (!box) return;
    if (!saved) { box.replaceChildren(el('span', { className: 'settings-status', textContent: 'Waiting for the server…' })); return; }
    const pick = el('select', { className: 'input', id: 'settings-ai-provider' }, CHOICES.map(([v, t]) => el('option', { value: v, textContent: t, selected: (saved.aiProvider || 'auto') === v })));
    pick.onchange = () => SD.settings.request({ aiProvider: pick.value });
    box.replaceChildren(
      el('label', { className: 'field' }, [el('span', { className: 'field-label', textContent: 'AI provider' }), pick]),
      el('p', { className: 'settings-note', textContent: 'API keys: the OpenAI / Google Gemini cards under Accounts & Connections (masked, tested, stored encrypted) or OPENAI_API_KEY / '
        + 'GEMINI_API_KEY in .env. Each AI Breakdown / Briefing is one API call (the same setup is reused for a minute; at most 30 an hour). '
        + 'The analyst sees the trade\'s facts from the ledger, never your keys or account numbers.' }));
  }

  SD.aiSettings = { render };
})();
