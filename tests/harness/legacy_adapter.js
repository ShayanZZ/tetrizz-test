// Harness adapter for the v1.2.0 single file: exposes window.__h using the
// file's own globals. A modular build must provide a window.__h with the same shape.
(() => {
  const hash = (s) => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };
  window.__h = {
    startSolo(m) { selectMode(m); hideAllOverlays(); startCountdown(); },
    act(name, arg) {
      if (name === 'move') return movePiece(arg);
      if (name === 'rotate') return tryRotate(arg);
      if (name === 'hold') return doHold();
      if (name === 'soft') return softStep();
      if (name === 'drop') return hardDrop();
    },
    snap() {
      return {
        state, mode, score, lines, level, combo, maxCombo, b2b: b2bChain, pieces,
        hold: hold === null ? -1 : hold, cur: piece ? piece.type : -1,
        px: piece ? piece.x : -1, rot: piece ? piece.rot : -1,
        board: hash(JSON.stringify(board)),
      };
    },
    startVs(cfg) { localStorage.setItem('tetris_vsbot', JSON.stringify(cfg)); loadVs(); selectMode('vsbot'); hideAllOverlays(); vsStartMatch(); },
    vsSnap() {
      return {
        state, active: !!vsActive, round: vsRound, wins: MP.wins.slice(0, 4),
        stations: MP.stations.map((st) => ({ pieces: st.pieces, timeMs: Math.round(st.timeMs), lines: st.lines, alive: st.alive, isBot: !!st.isBot })),
      };
    },
    async profileSummary() {
      const txt = (n) => { showScreen($('ovStart'), n); const s = document.querySelector('.menu-screen.active'); return s ? s.innerText.replace(/\s+/g, ' ').trim() : ''; };
      const list = JSON.parse(localStorage.getItem('tetris_replays') || '[]');
      const replays = [];
      for (const r of list) {
        const d = await rpEntryData(r);
        replays.push({ id: r.id, dur: r.dur, nR: r.nR, rounds: d ? d.rounds.length : -1, frames: d ? d.rounds.reduce((a, x) => a + x.frames.length, 0) : -1 });
      }
      return { opts: snapOpts(), mode, scoresText: txt('scores'), replaysText: txt('replays'), replays };
    },
    showScreen(name) { showScreen($('ovStart'), name); },
    openInstallPop() { openInstallPop(); },
    togglePause() { togglePause(); },
    gameOver() { gameOver(); },
    shapes() { return PIECES.map((p) => p.cells); },
    board() { return JSON.parse(JSON.stringify(board)); },
  };
})();
