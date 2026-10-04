// Quick Flips radar card (Phase 91): what an Approvals card shows for an Options Quick Flip, so it can be judged from the card alone:
// the contract, why it fired, the full cost per contract, the exits that run automatically after approval, and the approval window
// (the setup expires at its entry deadline: signal bar end + 60 s + 3 min). facts(o, now) is pure (tested in Node); body(o) builds the
// DOM and ticks its countdown every second while on screen. Exposes window.SignalDesk.quickFlipCard.
(() => {
  const SD = window.SignalDesk;
  const FEE = 0.65; // per contract per fill (the app's options commission model)
  const usd = (x) => `$${Number(x).toFixed(2)}`;
  const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const countdownOf = (left) => (left > 0 ? `Approve within ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}` : 'Approval window closed: the quote is stale');
  function facts(o, now = Date.now()) {
    const od = o && o.optionsData; const q = od && od.quickFlip;
    if (!od || !q || !(od.ask > 0) || !(od.bid >= 0) || !od.exitRule) return null; // older / partial data: the generic options block
    const m = od.multiplier || 100; const mid = (od.ask + od.bid) / 2; const spread = od.ask - od.bid;
    const word = o.direction === 'short' ? 'below' : 'above';
    const range = q.orLow != null && q.orHigh != null ? `the opening range ${q.orLow}-${q.orHigh}` : `the trigger ${q.trigger}`;
    const base = q.setup === 'S2' ? `VWAP-trend pullback: 5-min close back ${word} the EMA20 ${q.trigger}, VWAP ${q.vwap}` : `5-min close ${word} ${range} and ${word} VWAP ${q.vwap}`;
    const left = Math.max(0, (o.expiresAt || od.entryDeadlineAt || 0) - now);
    return {
      contract: `BUY 1 ${od.label}`,
      occ: od.contract,
      terms: [`${od.dte} DTE`, `strike ${od.strike}`, `expires ${od.expiration}`, Number.isFinite(od.delta) ? `delta ${od.delta.toFixed(2)}` : null, Number.isFinite(od.iv) ? `IV ${(od.iv * 100).toFixed(0)}%` : null].filter(Boolean).join(' · '),
      why: `${base}${Number.isFinite(q.relVol) ? `, RelVol ${q.relVol.toFixed(1)}x` : ''}; still ${word} it at the decision minute${q.signalAt ? ` (signal ${clock(q.signalAt)} ET)` : ''}.`,
      cost: [
        ['Ask (your entry limit)', `${usd(od.ask)} · ${usd(od.ask * m)} per contract`],
        ['Bid', `${usd(od.bid)} · ${usd(od.bid * m)}`],
        ['Bid / ask spread', `${usd(spread * m)} (${((spread / mid) * 100).toFixed(1)}% of mid)`],
        ['Commission', `${usd(FEE)} x 2 = ${usd(2 * FEE)}`],
        ['Cost if sold at the bid right away', usd(spread * m + 2 * FEE)],
        ['Max loss at the -30% stop', `${usd((od.debit - od.exitRule.stopValue) * m + 2 * FEE)} before slippage (stop value ${usd(od.exitRule.stopValue)})`],
        ['Target +45%', `value ${usd(od.exitRule.targetValue)} · ${usd((od.exitRule.targetValue - od.debit) * m - 2 * FEE)} net`],
        ['Quote', `${od.quoteTime && od.refAt ? `${Math.round((od.refAt - od.quoteTime) / 1000)} s old at the signal` : 'age unknown'} · Alpaca ${od.feed || 'indicative'} (not OPRA)`],
      ],
      exits: `After approval these run automatically: -30% (${usd(od.exitRule.stopValue)}) / +45% (${usd(od.exitRule.targetValue)}), a 5-min close back through VWAP, ${q.maxHoldMin || 60} min max hold, closed by 3:40 PM ET.`,
      leftMs: left, expired: left <= 0, countdown: countdownOf(left),
    };
  }
  function body(o) {
    const f = facts(o); if (!f) return null;
    const { el } = SD.ui;
    const cd = el('p', { className: `qf-countdown${f.expired ? ' is-expired' : f.leftMs < 60000 ? ' is-soon' : ''}`, textContent: f.countdown });
    const deadline = o.expiresAt || o.optionsData.entryDeadlineAt || 0;
    const timer = setInterval(() => {
      if (!cd.isConnected) { clearInterval(timer); return; }
      const left = Math.max(0, deadline - Date.now());
      cd.textContent = countdownOf(left);
      cd.className = `qf-countdown${left <= 0 ? ' is-expired' : left < 60000 ? ' is-soon' : ''}`;
      if (left <= 0) clearInterval(timer);
    }, 1000);
    return el('div', { className: 'qf-card' }, [
      el('div', { className: 'qf-contract' }, [el('strong', { textContent: f.contract }), el('span', { className: 'qf-muted', textContent: `${f.occ} · ${f.terms}` })]),
      el('p', { className: 'qf-why', textContent: f.why }),
      el('div', { className: 'qf-cost' }, f.cost.map(([k, v]) => el('div', { className: 'qf-row' }, [el('span', { className: 'qf-k', textContent: k }), el('span', { textContent: v })]))),
      el('p', { className: 'qf-exits', textContent: f.exits }),
      cd,
    ]);
  }
  SD.quickFlipCard = { facts, body };
})();
