// Live scanner log (Scanner tab): the last ~20 things the market scan concluded,
// newest first, pushed by the server after every pass (SCAN_LOG):
//   scan      per strategy: symbols checked and why each produced no setup
//   rejected  a setup a shield or the risk engine turned down (exact reason)
//   staged    a setup that passed every gate
// Repeats are collapsed server-side ("×12 since 10:31"). Read-only.
// Exposes window.SignalDesk.scanLogView: { render(state, opts) }.
(() => {
  const SD = window.SignalDesk;
  const { el, age } = SD.ui;

  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const TAG = { scan: 'Checked', rejected: 'Rejected', staged: 'Staged' };

  function reasonLine(r) {
    return el('li', { className: 'slog-reason' }, [
      el('span', { className: 'slog-reason-text', textContent: r.reason }),
      el('span', { className: 'slog-count', textContent: `×${r.count}` }),
      el('span', { className: 'slog-syms', textContent: `${r.symbols.join(', ')}${r.more ? ` +${r.more} more` : ''}` }),
    ]);
  }

  function entry(e, opts) {
    const repeat = e.count > 1 ? ` · ×${e.count} since ${time(e.firstAt)}` : '';
    const head = el('div', { className: 'slog-head' }, [
      el('span', { className: `slog-tag is-${e.kind}`, textContent: TAG[e.kind] || e.kind }),
      el('strong', { className: 'slog-title', textContent: e.kind === 'scan' ? e.strategy : `${e.symbol}` }),
      ...(e.kind === 'scan' ? [] : [el('span', { className: 'slog-muted', textContent: e.strategy })]),
      el('span', { className: 'slog-time', textContent: `${time(e.at)}${repeat}`, title: `${age(e.at)} ago` }),
    ]);
    const body = e.kind === 'scan'
      ? [el('p', { className: 'slog-text', textContent: e.text }), ...(e.reasons.length ? [el('ul', { className: 'slog-reasons' }, e.reasons.map(reasonLine))] : [])]
      : [el('p', { className: 'slog-text', textContent: e.text, title: e.detail || '' }),
        ...(e.detail && e.detail !== e.text ? [el('p', { className: 'slog-detail', textContent: e.detail })] : [])];
    const li = el('li', { className: `slog-entry is-${e.kind}` }, [head, ...body]);
    if (e.kind === 'staged' && opts.onReview) {
      const b = el('button', { type: 'button', className: 'scan-link', textContent: 'Review setup' });
      b.onclick = () => opts.onReview(e.id);
      li.append(b);
    }
    return li;
  }

  // opts: { onReview(id) }
  function render(state, opts = {}) {
    const log = state.scanLog || [];
    const last = state.scan && state.scan.finishedAt;
    return el('section', { className: 'slog' }, [
      el('div', { className: 'slog-bar' }, [
        el('h3', { className: 'scan-h', textContent: 'Live scanner log' }),
        el('span', { className: 'slog-muted', textContent: last ? `Last pass ${time(last)} · every ${Math.round(((state.scan && state.scan.intervalMs) || 60000) / 1000)}s · newest first` : 'Waiting for the first pass' }),
      ]),
      log.length
        ? el('ol', { className: 'slog-list' }, log.map((e) => entry(e, opts)))
        : el('p', { className: 'slog-muted', textContent: 'Nothing logged yet: the first scan runs within a minute of the server starting.' }),
    ]);
  }

  SD.scanLogView = { render };
})();
