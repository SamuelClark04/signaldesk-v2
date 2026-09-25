// Portfolio money maths shared by Portfolio, Pilot, Today and the Setups risk
// panel: live P/L marks, per-venue totals, and the capital breakdown
//   Total = Managed (SignalDesk positions) + External (broker balances SignalDesk
//           does not manage + manual holdings: Robinhood / other) + Cash.
// Manual holdings and the protective levels of broker-synced ones come from the
// server (EXTERNAL_HOLDINGS: execution/external-holdings.js).
// P/L uses the ledger's own maths: gross = (price − fill) × size (× −1 short);
// estimated exit fees use the position's fee model (sent by the server), exactly
// as the ledger books a close. Real option contracts are marked at their live
// bid (or modelled value) from the server; older options setups get no $ P/L.
// Exposes window.SignalDesk.portfolioMetrics.
(() => {
  const SD = window.SignalDesk;
  const { clock } = SD.ui;
  const QTY_DUST = 1e-8;

  const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
  const closeOf = (state, asset) => { const c = state.refPrices && state.refPrices[asset]; return c && c.price > 0 ? c.price : null; }; // latest session close
  const markOf = (state, p) => { // the server's mark for an external holding (live, else its last session close)
    const x = p.markPrice > 0 ? p : ((state.external && state.external.positions) || []).find((e) => e.asset === p.asset && e.markPrice > 0);
    return x ? x.markPrice : null;
  };
  const display = (p) => (p.market === 'crypto' ? p.asset.replace('-', '/') : p.asset);
  const costBasis = (p) => (p.market === 'options' && p.optionsData
    ? p.positionSize * p.optionsData.debit * p.optionsData.multiplier : p.positionSize * p.fillPrice);

  // One position marked at a live price. Without one (market closed, weekend),
  // stocks / coins are marked at the latest regular-session close (`close`, from
  // REFERENCE_PRICES; priceSource 'close', live false: closing still needs a
  // live price). Broker holdings fall back to their value from the last sync
  // (priceSource 'sync'); their cost is the broker's own cost basis.
  // WYSIWYG (Phase 59): a paper position's net is the server's exit quote (what a
  // close books: exit spread + fees), not the mid less fees.
  function mark(p, livePrice, close) {
    const m = rawMark(p, livePrice, close);
    return m && p.exitQuote && Number.isFinite(p.exitQuote.net) ? { ...m, net: p.exitQuote.net, netSource: 'exit quote' } : m;
  }
  function rawMark(p, livePrice, close) {
    if (p.execution === 'BROKER') return markBroker(p, livePrice > 0 ? livePrice : close, livePrice > 0);
    const cost = costBasis(p);
    const fm = p.feeModel || {};
    // Entry leg at its own rate (maker for a paper limit entry), exit at market (taker).
    const exitFees = (x) => (fm.perContractRoundTrip ? fm.perContractRoundTrip * p.positionSize
      : fm.exitRate ? p.positionSize * ((fm.entryRate ?? fm.exitRate) * p.fillPrice + fm.exitRate * x)
        : fm.legRate ? fm.legRate * p.positionSize * (p.fillPrice + x) : null);
    if (p.market === 'options' && p.optionsData && p.optionsData.contract) return markOption(p, livePrice, cost, exitFees);
    const px = livePrice > 0 ? livePrice : p.market !== 'options' && close > 0 ? close : null;
    if (!px) return { live: false, cost, marketValue: cost, gross: null, net: null, fees: null, pctGross: null };
    if (p.market === 'options') { // older setups (no real contract): only the underlying's move is known
      return { live: true, price: livePrice, cost, marketValue: cost, gross: null, net: null, fees: exitFees(livePrice), pctGross: null,
        underlyingMove: livePrice / p.fillPrice - 1 };
    }
    const sign = p.direction === 'short' ? -1 : 1;
    const gross = (px - p.fillPrice) * p.positionSize * sign;
    const fees = exitFees(px);
    return { live: livePrice > 0, priceSource: livePrice > 0 ? 'live' : 'close', price: px, cost, marketValue: cost + gross, gross, fees, net: fees === null ? null : gross - fees,
      pctGross: cost > 0 ? gross / cost : null, r: p.dollarRisk > 0 ? gross / p.dollarRisk : null };
  }

  // Real option contract: valued at the server's optionMark (per share): the
  // real BID from a fresh quote, else the Black-Scholes value at the live
  // underlying (basis 'model'). P/L = (value − premium paid) × 100 × contracts.
  // `live` still means "the underlying has a live price" (closing needs one).
  function markOption(p, livePrice, cost, exitFees) {
    const om = p.optionMark;
    const underlying = livePrice > 0 ? livePrice : om && om.underlying > 0 ? om.underlying : null;
    const base = { live: livePrice > 0, price: underlying, cost, underlyingMove: underlying ? underlying / p.fillPrice - 1 : null };
    if (!om || !(om.value >= 0)) return { ...base, marketValue: cost, gross: null, net: null, fees: null, pctGross: null };
    const { debit, multiplier } = p.optionsData;
    const gross = (om.value - debit) * multiplier * p.positionSize;
    const fees = exitFees(underlying);
    return { ...base, marketValue: cost + gross, gross, fees, net: fees === null ? null : gross - fees, pctGross: cost > 0 ? gross / cost : null,
      r: p.dollarRisk > 0 ? gross / p.dollarRisk : null, optionValue: om.value, optionBasis: om.basis, optionAt: om.at };
  }

  function markBroker(p, livePrice, isLive = livePrice > 0) {
    const qty = p.positionSize;
    const syncPx = p.brokerValue > 0 && qty > 0 ? p.brokerValue / qty : null;
    const px = livePrice > 0 ? livePrice : syncPx;
    const cost = Number.isFinite(p.costBasis) && p.costBasis > 0 ? p.costBasis : p.fillPrice > 0 ? qty * p.fillPrice : null;
    const marketValue = px ? qty * px : 0;
    const gross = px && cost !== null ? marketValue - cost : null;
    const fees = px && p.feeModel && p.feeModel.legRate ? p.feeModel.legRate * qty * ((p.fillPrice || px) + px) : null;
    return { live: isLive, priceSource: isLive ? 'live' : livePrice > 0 ? 'close' : syncPx ? 'sync' : null, price: px, cost: cost === null ? marketValue : cost, marketValue,
      gross, fees, net: gross === null || fees === null ? null : gross - fees, pctGross: gross !== null && cost > 0 ? gross / cost : null, r: null, noBasis: cost === null };
  }

  // Which rows a venue filter shows. 'crypto' = the synced Coinbase account; until
  // a sync succeeds it falls back to the ledger's LIVE Coinbase positions. The
  // ledger's LIVE Coinbase trades are part of the synced balance, so they are
  // never added on top of it (they annotate the matching holding instead).
  // 'crypto' is the "Live / External" filter: synced broker accounts + manual holdings.
  const VENUE_KEYS = { paper: ['paper'], crypto: ['coinbase', 'alpaca', 'external'], combined: ['paper', 'coinbase', 'alpaca', 'external'] };

  function ledgerVenue(p) {
    if (p.execution !== 'LIVE') return 'paper';
    return p.broker === 'Coinbase' ? 'coinbase-ledger' : 'alpaca-ledger';
  }

  // External rows' "Next step": a pending Pilot card for it, else its matrix verdict.
  function externalAlert(state, positionId, asset) {
    const a = (state.pilotActions || []).find((x) => x.positionId === positionId);
    if (a) return { asset, tone: 'warn', action: a.manual ? `Do in ${a.broker}: ${a.action}` : `${a.action} waiting in Approvals`, detail: a.instruction || a.reason };
    const m = ((state.pilotMatrix && state.pilotMatrix.rows) || []).find((r) => r.positionId === positionId);
    return m ? { asset, tone: m.action === 'HOLD' ? 'info' : 'warn', action: `Pilot: ${m.action}`, detail: m.reason } : null;
  }


  // A synced Coinbase holding: which part SignalDesk manages (its LIVE trades +
  // adopted positions of that coin) and which part is external. Its alert is the
  // most urgent one of the managed positions inside it, else a plain info line.
  function brokerRow(p, ledger, alerts, state) {
    const venue = p.broker === 'Alpaca' ? 'alpaca' : 'coinbase';
    const tracked = ledger.filter((x) => x.key === `${venue}-ledger` && x.p.asset === p.asset).map((x) => x.p);
    const ext = ((state.external && state.external.positions) || []).find((x) => x.id === `ext:${venue}:${p.asset}`);
    const managedQty = Math.min(p.positionSize, tracked.reduce((s, t) => s + t.positionSize, 0));
    const freeQty = Math.max(0, Math.round((p.positionSize - managedQty) * 1e8) / 1e8); // 8 dp: no float noise
    const urgent = tracked.map((t) => alerts.get(t.id)).filter(Boolean).find((a) => a.tone === 'warn') || null;
    const adoptedOnly = tracked.length > 0 && tracked.every((t) => t.adopted);
    const info = !tracked.length
      ? { action: 'External holding', detail: `Held at ${p.broker}; bought outside SignalDesk. It has protective Pilot levels (stop / T1 / T2) and is in the Pilot matrix.` }
      : adoptedOnly
        ? { action: 'Adopted: watched by SignalDesk', detail: `SignalDesk alerts at your stop and target; no orders are placed at ${p.broker} (you sell there)` }
        : { action: `SignalDesk bracket at ${p.broker}`, detail: `${tracked.length} SignalDesk position(s) in this balance; SignalDesk's own trades have stop/target orders at ${p.broker}` };
    const levels = ext && !tracked.length ? { invalidation: ext.invalidation, targets: ext.targets, extId: ext.id, levelsBasis: ext.levelsBasis, customLevels: ext.customLevels,
      dollarRisk: ext.dollarRisk } : {};
    return { p: { ...p, ...levels, tracked, managedQty, freeQty: freeQty > QTY_DUST ? freeQty : 0 }, key: venue,
      alert: urgent ? { ...urgent, asset: p.asset } : (ext && externalAlert(state, ext.id, p.asset)) || { asset: p.asset, tone: 'info', ...info } };
  }

  // Rows + totals for the active venue. Paper KPIs use the configured bankroll;
  // Coinbase KPIs use the synced account (holdings + cash); Combined sums both.
  // LIVE Alpaca positions are listed under Combined but not synced, so excluded from KPIs.
  function metrics(state, venue = 'paper') {
    const alerts = new Map(((state.intelligence && state.intelligence.attention) || []).filter((a) => a.positionId).map((a) => [a.positionId, a]));
    const cb = state.holdings && state.holdings.coinbase;
    const al = state.holdings && state.holdings.alpaca;
    const synced = !!(cb && cb.ok);
    const alSynced = !!(al && al.ok);
    const ledger = (state.positions || []).map((p) => ({ p, key: ledgerVenue(p) }));
    const broker = [...(synced ? cb.positions : []), ...(alSynced ? al.positions : [])].map((p) => brokerRow(p, ledger, alerts, state));
    const manual = ((state.external && state.external.positions) || []).filter((p) => p.external === 'manual')
      .map((p) => ({ p, key: 'external', alert: externalAlert(state, p.id, p.asset) }));
    const keys = new Set(VENUE_KEYS[venue] || VENUE_KEYS.paper);
    if (!synced && keys.has('coinbase')) keys.add('coinbase-ledger'); // no snapshot yet: show what the ledger knows
    if (!alSynced && keys.has('alpaca')) keys.add('alpaca-ledger');
    const rows = [...ledger, ...broker, ...manual].filter((r) => keys.has(r.key))
      .sort((a, b) => (b.p.openedAt || 0) - (a.p.openedAt || 0))
      // No live price: the latest session close, else the server's markPrice (external holdings, Phase 55).
      .map((r) => ({ ...r, m: mark(r.p, state.prices && state.prices[r.p.asset], closeOf(state, r.p.asset) || markOf(state, r.p)), alert: r.alert || alerts.get(r.p.id) || null }));

    const paper = rows.filter((r) => r.key === 'paper');
    const cbRows = rows.filter((r) => r.key === 'coinbase');
    const alRows = rows.filter((r) => r.key === 'alpaca');
    const extRows = rows.filter((r) => r.key === 'external');
    const counted = [...paper, ...cbRows, ...alRows, ...extRows];
    const usePaper = keys.has('paper');
    const useCb = keys.has('coinbase') && synced;
    const useAl = keys.has('alpaca') && alSynced;
    const alCash = useAl ? al.cash || 0 : 0;
    const sum = (list) => list.reduce((s, r) => s + r.m.marketValue, 0);
    const managedOf = (list) => list.reduce((s, r) => s + (r.p.positionSize > 0 ? (r.m.marketValue * r.p.managedQty) / r.p.positionSize : 0), 0);
    const alValue = sum(alRows);
    const extValue = sum(extRows);
    const outside = alValue - managedOf(alRows) + extValue; // Alpaca balances + manual holdings not managed by SignalDesk
    const bankroll = usePaper ? (state.settings && state.settings.bankroll) || 0 : 0;
    const realized = usePaper ? (state.journal || []).filter((t) => t.execution !== 'LIVE').reduce((s, t) => s + (t.netPnl || 0), 0) : 0;
    const cbCash = useCb ? cb.cash || 0 : 0;
    const paperCost = paper.reduce((s, r) => s + r.m.cost, 0);
    const paperValue = paper.reduce((s, r) => s + r.m.marketValue, 0);
    const cbValue = cbRows.reduce((s, r) => s + r.m.marketValue, 0);
    // Managed vs external split of the Coinbase holdings, by quantity.
    const cbManaged = managedOf(cbRows);
    const unrealized = counted.reduce((s, r) => s + (r.m.gross || 0), 0);
    const committed = counted.reduce((s, r) => s + (r.m.noBasis ? 0 : r.m.cost), 0); // no cost basis: not in the P/L % base
    const paperCash = usePaper ? bankroll + realized - paperCost : 0;
    const totals = {
      venue, bankroll, realized, committed, paperCost, unrealized, synced, usePaper, useCb, cbCash, paperCash, syncedAt: cb && cb.syncedAt,
      holdingsValue: paperValue + cbValue + alValue + extValue,
      managedValue: paperValue + cbManaged + managedOf(alRows),
      externalValue: cbValue - cbManaged + outside,
      accountValue: (usePaper ? bankroll + realized + paper.reduce((s, r) => s + (r.m.gross || 0), 0) : 0) + (useCb ? cbValue + cbCash : 0) + (useAl ? alValue + alCash : 0) + extValue,
      cash: paperCash + cbCash + alCash, alCash, extValue,
      unrealizedPct: committed > 0 ? unrealized / committed : null,
      exitFees: counted.reduce((s, r) => s + (r.m.fees || 0), 0),
      fresh: rows.filter((r) => r.m.live).length,
      atClose: rows.filter((r) => !r.m.live && r.m.priceSource === 'close').length,
      unmarked: counted.filter((r) => r.m.gross === null).length,
      live: rows.length - counted.length,
      // Venue-isolated bankroll: paper = configured bankroll; Live Crypto = the
      // Coinbase account's value (holdings + cash); Combined = both.
      liveAccountValue: useCb ? cbValue + cbCash : 0,
    };
    totals.currentBankroll = (usePaper ? bankroll : 0) + totals.liveAccountValue;
    totals.bankrollLabel = [usePaper ? 'paper bankroll' : '', useCb ? 'Coinbase account value' : ''].filter(Boolean).join(' + ');
    totals.deployedPct = totals.accountValue > 0 ? totals.holdingsValue / totals.accountValue : null;
    return { rows, totals };
  }

  // The bankroll a single order is measured against, by the venue it will use:
  // 'paper' | 'coinbase' | 'alpaca'. { amount|null, label, note }. Live accounts
  // are only known after a sync (Coinbase) or from BROKER_STATE (Alpaca equity).
  function venueBankroll(state, key) {
    if (key === 'coinbase') {
      const cb = state.holdings && state.holdings.coinbase;
      if (!cb || !cb.ok) return { amount: null, label: 'Live Coinbase account value', note: 'not synced: press Sync Broker' };
      return { amount: metrics(state, 'crypto').totals.liveAccountValue, label: 'Live Coinbase account value', note: `synced ${clock(cb.syncedAt)}` };
    }
    if (key === 'alpaca') {
      const v = state.broker && state.broker.venues && state.broker.venues.alpaca;
      if (!v || !v.ok || !(v.equity > 0)) return { amount: null, label: 'Live Alpaca equity', note: v && v.error ? `unavailable: ${v.error}` : 'unavailable' };
      return { amount: v.equity, label: 'Live Alpaca equity', note: `as of ${clock(v.fetchedAt)}` };
    }
    const b = state.settings && state.settings.bankroll;
    return { amount: b > 0 ? b : null, label: 'Paper bankroll', note: 'configured in Settings' };
  }

  // The cash that would pay for a new buy on this venue: { amount|null, label, note }.
  function fundingSource(state, key) {
    if (key === 'coinbase') {
      const v = state.broker && state.broker.venues && state.broker.venues.coinbase;
      if (v && v.ok && Number.isFinite(v.buyingPower)) return { amount: v.buyingPower, label: 'Coinbase USD + USDC cash', note: `as of ${clock(v.fetchedAt)}` };
      const cb = state.holdings && state.holdings.coinbase;
      if (cb && cb.ok) return { amount: cb.cash, label: 'Coinbase USD + USDC cash', note: `last sync ${clock(cb.syncedAt)}` };
      return { amount: null, label: 'Coinbase USD + USDC cash', note: 'unknown: sync the broker' };
    }
    if (key === 'alpaca') {
      const v = state.broker && state.broker.venues && state.broker.venues.alpaca;
      return v && v.ok ? { amount: v.buyingPower, label: 'Alpaca buying power', note: `as of ${clock(v.fetchedAt)}` } : { amount: null, label: 'Alpaca buying power', note: 'unavailable' };
    }
    return { amount: metrics(state, 'paper').totals.paperCash, label: 'Paper cash available', note: 'bankroll + realized − open paper positions' };
  }

  SD.portfolioMetrics = { mark, metrics, venueBankroll, fundingSource, pct, display };
})();
