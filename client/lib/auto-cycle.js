// Auto-cycle timer for the "command center" displays (Setups bottom tabs, chart
// rotation). One 1 s ticker per cycler calls advance() every periodMs while it is
// playing and canRun() says the display is on screen and not in use.
//   reset()        restart the countdown (the user just clicked something)
//   setPlaying(v)  play / pause; remembered per browser when `key` is given
//   remaining()    ms until the next switch (for a countdown label), or null
// Exposes window.SignalDesk.autoCycle(opts).
(() => {
  const SD = window.SignalDesk;

  function autoCycle({ periodMs, canRun = () => true, advance, key = null, playing: initial = true }) {
    let playing = initial;
    if (key) { try { const v = localStorage.getItem(key); if (v !== null) playing = v === 'play'; } catch { /* storage blocked */ } }
    let due = Date.now() + periodMs;

    setInterval(() => {
      if (!playing || document.hidden) { due = Date.now() + periodMs; return; }
      if (!canRun()) { due = Math.max(due, Date.now() + 2000); return; } // in use: hold, then give a moment before switching
      if (Date.now() < due) return;
      due = Date.now() + periodMs;
      try { advance(); } catch (err) { console.error('[auto-cycle]', err); }
    }, 1000);

    return {
      reset: () => { due = Date.now() + periodMs; },
      playing: () => playing,
      setPlaying(v) {
        playing = !!v;
        due = Date.now() + periodMs;
        if (key) { try { localStorage.setItem(key, playing ? 'play' : 'pause'); } catch { /* storage blocked */ } }
      },
      remaining: () => (playing ? Math.max(0, due - Date.now()) : null),
    };
  }

  SD.autoCycle = autoCycle;
})();
