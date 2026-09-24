// Setups tab fallback charts, used when the chart library is not loaded:
// every level of a setup drawn as a line at its relative height, or (Market
// Watch) just the live price. Pure builders.
// Exposes window.SignalDesk.levelChart: { levels(o, livePrice), watch(o, livePrice, text) }.
(() => {
  const SD = window.SignalDesk;
  const { el, price } = SD.ui;
  const px = (x, o) => price(x, o);
  const displaySymbol = (o) => (o.market === 'crypto' ? o.asset.replace('-', '/') : o.asset);

  // Fallback chart (library not loaded): every level drawn as a line at its relative height.
  function levelChart(o, livePrice) {
    const t = o.targets || [];
    const lines = [
      { name: 'T2', price: t[1] && t[1].price, cls: 'is-target' },
      { name: 'T1', price: t[0] && t[0].price, cls: 'is-target' },
      { name: 'Entry', price: o.entryZone.max, cls: 'is-entry' },
      { name: 'SL', price: o.invalidation, cls: 'is-stop' },
      { name: 'Last', price: livePrice, cls: 'is-last' },
    ].filter((l) => l.price > 0);
    const all = [...lines.map((l) => l.price), o.entryZone.min];
    const hi = Math.max(...all); const lo = Math.min(...all);
    const pad = (hi - lo) * 0.12 || hi * 0.01;
    const top = (p) => `${((hi + pad - p) / (hi - lo + 2 * pad)) * 100}%`;

    const chart = el('div', { className: 'opp-chart' });
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', `Price levels: ${lines.map((l) => `${l.name} ${px(l.price, o)}`).join(', ')}`);
    const band = el('div', { className: 'opp-band' });
    band.style.top = top(o.entryZone.max);
    band.style.height = `calc(${top(o.entryZone.min)} - ${top(o.entryZone.max)})`;
    chart.append(band, el('div', { className: 'opp-chart-note', textContent: 'Chart feed not connected: levels only' }));
    for (const l of lines) {
      const line = el('div', { className: `opp-line ${l.cls}` }, [
        el('span', { className: 'opp-line-label', textContent: `${l.name} ${px(l.price, o)}` })]);
      line.style.top = top(l.price);
      chart.append(line);
    }
    return chart;
  }

  // Market Watch chart: just the live price, centred, until a setup brings levels.
  function watchChart(o, livePrice, text) {
    const chart = el('div', { className: 'opp-chart' });
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', `${displaySymbol(o)} last price ${livePrice > 0 ? px(livePrice, o) : 'unavailable'}`);
    chart.append(el('div', { className: 'opp-watch-mode', textContent: text }));
    if (livePrice > 0) {
      const line = el('div', { className: 'opp-line is-last' }, [el('span', { className: 'opp-line-label', textContent: `Last ${px(livePrice, o)}` })]);
      line.style.top = '50%';
      chart.append(line);
    }
    chart.append(el('div', { className: 'opp-chart-note', textContent: 'Chart feed not connected: live price only' }));
    return chart;
  }

  SD.levelChart = { levels: levelChart, watch: watchChart };
})();
