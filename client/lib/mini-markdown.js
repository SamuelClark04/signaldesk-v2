// A small, SAFE Markdown renderer for AI Analyst replies (Phase 84): headings, paragraphs, bullet / numbered lists,
// quotes, code blocks and inline **bold**, *italic* / _italic_, `code`. It builds DOM nodes through `el` with text only
// (never innerHTML), so nothing in a model's reply can become markup or script. Pure; loads in the browser
// (window.SignalDesk.miniMarkdown) and in Node (tests pass their own `el`).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SignalDesk = root.SignalDesk || {}; root.SignalDesk.miniMarkdown = api; }
}(typeof window !== 'undefined' ? window : this, () => {
  const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s\n][^*\n]*\*|_[^_\s\n][^_\n]*_)/g;

  // "a **b** `c`" -> ['a ', <strong>b</strong>, ' ', <code>c</code>]
  function inline(text, el) {
    const out = [];
    let last = 0;
    let m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('**')) out.push(el('strong', { textContent: t.slice(2, -2) }));
      else if (t.startsWith('`')) out.push(el('code', { textContent: t.slice(1, -1) }));
      else out.push(el('em', { textContent: t.slice(1, -1) }));
      last = m.index + t.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  // Markdown text -> an array of block nodes.
  function render(md, el) {
    const out = [];
    let para = [];
    let list = null;
    let code = null;
    const flush = () => { if (para.length) { out.push(el('p', {}, inline(para.join(' '), el))); para = []; } };
    const endList = () => { if (list) { out.push(el(list.tag, {}, list.items)); list = null; } };
    for (const raw of String(md || '').replace(/\r/g, '').split('\n')) {
      if (code) {
        if (/^\s*```/.test(raw)) { out.push(el('pre', { textContent: code.join('\n') })); code = null; } else code.push(raw);
        continue;
      }
      const line = raw.trim();
      let m;
      if (/^```/.test(line)) { flush(); endList(); code = []; continue; }
      if (!line) { flush(); endList(); continue; }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); endList(); out.push(el(m[1].length <= 2 ? 'h3' : 'h4', {}, inline(m[2].replace(/\s+#+$/, ''), el))); continue; }
      if ((m = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line))) {
        flush();
        const tag = /^\d/.test(line) ? 'ol' : 'ul';
        if (!list || list.tag !== tag) { endList(); list = { tag, items: [] }; }
        list.items.push(el('li', {}, inline(m[1], el)));
        continue;
      }
      if ((m = /^>\s?(.*)$/.exec(line))) { flush(); endList(); out.push(el('blockquote', {}, inline(m[1], el))); continue; }
      endList();
      para.push(line);
    }
    if (code) out.push(el('pre', { textContent: code.join('\n') }));
    flush();
    endList();
    return out;
  }

  return { render, inline };
}));
