// @ts-nocheck
import { clamp, configState } from "../core/config";
import { game } from "../game/state";
import { $, savePractice } from "../ui/layout";
import { askConfirm, cfIsOpen, showEditNote } from "../ui/settings";
import {
  capClose,
  capDrawSelect,
  capFromFile,
  capNote,
  capPointerDown,
  capPointerMove,
  capPointerUp,
  capPrevRun,
  capPrevSave,
  capPrevShow,
  capShowSources,
  capStopStream,
  captureState,
} from "../practice/capture";
import {
  PRACTICE_PRESETS,
  addBoardEntry,
  animMove,
  boardLibraryState,
  boardThumb,
  bvClose,
  bvOpen,
  bvPointerDown,
  bvPointerMove,
  bvPointerUp,
  deleteBoard,
  exportBoardsFile,
  importBoardsText,
  isPresetBoard,
  migrateBoards,
  presetGrid,
  presetTypes,
  renameBoard,
  renderBoardList,
  saveCurrentPracticeBoard,
  selectedBoard,
  syncPracticeToBoard,
  toast,
} from "../practice/board-library";
import {
  snapBack,
  snapPlay,
  snapRelayout,
  snapSave,
  snapShowView,
  snapshotState,
} from "../practice/snapshot";
import { exitReplay } from "../replay/replay";

window.addEventListener(
  "click",
  (e) => {
    if (e.target && e.target.closest && e.target.closest("#snapBackBtn")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      snapBack();
    }
  },
  true,
);

window.addEventListener("resize", () => {
  clearTimeout(snapshotState._snT);
  snapshotState._snT = setTimeout(snapRelayout, 90);
});

(function () {
  const cfi = $("capFileInput");
  if (cfi)
    cfi.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) capFromFile(f, "file");
      e.target.value = "";
    });
  const cci = $("capCameraInput");
  if (cci)
    cci.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) capFromFile(f, "camera");
      e.target.value = "";
    });
  const ccv = $("capCanvas");
  if (ccv) {
    ccv.addEventListener("pointerdown", capPointerDown);
    ccv.addEventListener("pointermove", capPointerMove);
    ccv.addEventListener("pointerup", capPointerUp);
    ccv.addEventListener("pointercancel", capPointerUp);
  }
  const cbl = $("capBoardList");
  if (cbl)
    cbl.addEventListener("click", (e) => {
      const act = e.target.closest("[data-bact]");
      const row = e.target.closest("[data-bi]");
      if (!row) return;
      const i = +row.dataset.bi;
      if (act) {
        const a = act.dataset.bact;
        if (a === "up") animMove(i, -1);
        else if (a === "down") animMove(i, 1);
        else if (a === "view") bvOpen(i);
        else if (a === "name") renameBoard(i);
        else if (a === "del") deleteBoard(i);
        return;
      }
      configState.practice.boardSel = configState.practice.boardSel === i ? -1 : i;
      configState.practice.startExtras = null;
      if (configState.practice.boardSel >= 0) syncPracticeToBoard(configState.practice.boards[i]);
      savePractice();
      renderBoardList();
    });
  const csn = $("capSelNoneBtn");
  if (csn)
    csn.addEventListener("click", () => {
      configState.practice.boardSel = -1;
      configState.practice.startExtras = null;
      savePractice();
      renderBoardList();
    });
  const cra = $("capRemoveAllBtn");
  if (cra)
    cra.addEventListener("click", () => {
      if (!configState.practice.boards || !configState.practice.boards.length) {
        showEditNote("No saved boards to remove.", "list");
        return;
      }
      askConfirm(
        "Delete <b>ALL " +
          configState.practice.boards.length +
          " saved boards</b>?<br>This cannot be undone.",
        "DELETE ALL",
        () => {
          configState.practice.boards = [];
          configState.practice.boardSel = -1;
          configState.practice.startExtras = null;
          savePractice();
          renderBoardList();
          showEditNote("All boards removed ✓");
        },
      );
    });
  (function () {
    const on = (id, fn) => {
      const e = $(id);
      if (e) e.addEventListener("click", fn);
    };

    on("capExportFileBtn", exportBoardsFile);
    on("capImportFileBtn", () => {
      const f = $("capBoardsFile");
      if (f) {
        f.value = "";
        f.click();
      }
    });
    const bf = $("capBoardsFile");
    if (bf)
      bf.addEventListener("change", () => {
        const f = bf.files && bf.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => importBoardsText(String(rd.result || ""));
        rd.onerror = () => showEditNote("Could not read that file.", "list");
        rd.readAsText(f);
      });

    on("nbStd", () => {
      $("nbW").value = 10;
      $("nbH").value = 20;
    });
    on("nbWide", () => {
      $("nbW").value = 4;
      $("nbH").value = 26;
    });
    on("nbCreate", () => {
      const w = clamp(Math.round(+$("nbW").value || 10), 4, 20),
        h = clamp(Math.round(+$("nbH").value || 20), 4, 40);
      $("nbW").value = w;
      $("nbH").value = h;
      const _pv = {
        sel: configState.practice.boardSel,
        w: configState.practice.width,
        h: configState.practice.height,
        ex: configState.practice.startExtras,
      };
      addBoardEntry(
        Array.from({ length: h }, () => new Array(w).fill(0)),
        w,
        h,
        true,
      );
      boardLibraryState.bvDraft = { i: configState.practice.boards.length - 1, pv: _pv };
      const ent = selectedBoard();
      if (ent) {
        ent.name = "NEW " + w + "×" + h;
        ent.note = "Empty board — paint it, then add a queue and hold.";
      }
      savePractice();
      renderBoardList();
      bvOpen(configState.practice.boards.length - 1);
    });

    on("saveBoardBtn", saveCurrentPracticeBoard);

    const bump = (k, d, lo, hi) => {
      const o = captureState.capDet;
      if (!o || !o.res) return;
      o[k] = clamp((k === "cols" ? o.res.cols : o.res.vis) + d, lo, hi);
      if (k === "cols") o.shift = 0;
      capPrevRun();
    };
    on("capPcM", () => bump("cols", -1, 4, 20));
    on("capPcP", () => bump("cols", 1, 4, 20));
    on("capPrM", () => bump("rows", -1, 4, 40));
    on("capPrP", () => bump("rows", 1, 4, 40));
    on("capPsL", () => {
      if (captureState.capDet) {
        captureState.capDet.shift += 1;
        capPrevRun();
      }
    });
    on("capPsR", () => {
      if (captureState.capDet) {
        captureState.capDet.shift -= 1;
        capPrevRun();
      }
    });
    on("capPAuto", () => {
      if (captureState.capDet) {
        captureState.capDet.cols = 0;
        captureState.capDet.rows = 0;
        captureState.capDet.shift = 0;
        capPrevRun();
      }
    });
    on("capPrevSave", capPrevSave);
    on("capPrevBack", () => {
      captureState.capDet = null;
      capPrevShow(false);
    });

    const sb = $("snapBody");
    if (sb)
      sb.addEventListener("click", (e) => {
        const card = e.target.closest("[data-sn]");
        if (card) {
          snapShowView(+card.dataset.sn);
          return;
        }
        const sv = e.target.closest("#snSave");
        if (sv) {
          if (!sv.disabled && snapSave()) {
            sv.textContent = "SAVED ✓";
            sv.disabled = true;
            toast("Saved to Board Library ✓");
          }
          return;
        }
        if (e.target.closest("#snPlay")) snapPlay();
      });
  })();

  (function () {
    const LEGACY = [
      ["TSD SETUP LEFT", [".557700000", "55.7700000", "44.6000000", "4466600000", "1111000000"]],
      ["TSD SETUP RIGHT", ["000007755.", "0000077.55", "000006.44.", "000066644.", "000001111."]],
      [
        "TST SETUP",
        [
          ".557700000",
          "55.7700000",
          "44.6000000",
          "4466600000",
          "1111000000",
          "3300000000",
          "3000000000",
          "3000000000",
        ],
      ],
      ["PCO STARTER", ["3.44000000", "3344000000", "3000000000"]],
      ["DT CANNON", ["5500000077", "5500000077", "5000000077", "5550000777"]],
      ["TKI FLAT-TOP", ["1111000000", "2003000044", "2220333044"]],
      ["GRACE SYSTEM", ["6677001122", "6677001122"]],
      ["LST STACKING", ["3300000044", "3300000044"]],
      ["4-WIDE SURVIVAL", ["0001111000", "0001111000", "0001111000", "0001111000"]],
      [
        "GARBAGE DIGGING",
        ["8888088888", "8888088888", "8888088888", "8888088888", "8888088888", "8888088888"],
      ],
    ];
    const btn = $("capPresetsBtn");
    if (!btn) return;
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.textContent = "ADD PRESETS";
    const legacyGrid = (rows) => {
      const g = [];
      for (let i = 0; i < 20 - rows.length; i++) g.push(new Array(10).fill(0));
      for (const r of rows) {
        const a = new Array(10).fill(0);
        for (let x = 0; x < 10; x++) {
          const ch = r[x] || ".";
          a[x] = ch === "." || ch === "0" ? 0 : ch === "G" ? 8 : +ch;
        }
        g.push(a);
      }
      return g;
    };
    fresh.addEventListener("click", () => {
      migrateBoards();
      let removed = 0;
      for (let i = configState.practice.boards.length - 1; i >= 0; i--) {
        const b = configState.practice.boards[i];
        const lg = LEGACY.find((l) => l[0] === b.name);
        if (
          lg &&
          !b.seq &&
          !isPresetBoard(b) &&
          JSON.stringify(b.grid) === JSON.stringify(legacyGrid(lg[1]))
        ) {
          configState.practice.boards.splice(i, 1);
          removed++;
          if (configState.practice.boardSel === i) configState.practice.boardSel = -1;
          else if (configState.practice.boardSel > i) configState.practice.boardSel--;
        }
      }
      const sel = selectedBoard(),
        keep = [],
        have = new Map();
      for (const b of configState.practice.boards) {
        if (isPresetBoard(b) && !have.has(b.name)) have.set(b.name, b);
        else keep.push(b);
      }
      const pres = [];
      let added = 0,
        refreshed = 0;
      for (const p of PRACTICE_PRESETS) {
        let e = have.get(p.n);
        if (e) {
          have.delete(p.n);
          refreshed++;
        } else {
          const g = presetGrid(p);
          e = { name: p.n, cols: 10, vis: 20, grid: g, thumb: boardThumb(g, 10, 20) };
          added++;
        }
        e.preset = true;
        e.fixedSize = true;
        e.cat = p.cat;
        e.note = p.note;
        if (p.q || p.rem) e.seq = { q: presetTypes(p.q), rem: presetTypes(p.rem), h: null };
        else delete e.seq;
        pres.push(e);
      }
      for (const e of have.values()) keep.push(e);
      configState.practice.boards = keep.concat(pres);
      if (configState.practice.boardSel >= 0)
        configState.practice.boardSel = configState.practice.boards.indexOf(sel);
      savePractice();
      renderBoardList();
      showEditNote(
        (added ? added + " presets added" : "") +
          (refreshed ? (added ? " · " : "") + refreshed + " presets refreshed" : "") +
          (removed ? " · " + removed + " old presets replaced" : "") +
          " — presets are listed last, from easiest to hardest.",
        "list",
      );
      const _bl = $("capBoardList");
      if (_bl) _bl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  })();
  const bvc = $("bvCanvas");
  {
    const bn = $("bvName");
    if (bn)
      bn.addEventListener("input", () => {
        boardLibraryState.bvDirty = true;
      });
  }
  if (bvc) {
    bvc.addEventListener("pointerdown", bvPointerDown);
    bvc.addEventListener("pointermove", bvPointerMove);
    bvc.addEventListener("pointerup", bvPointerUp);
    bvc.addEventListener("pointercancel", bvPointerUp);
  }
  window.addEventListener(
    "keydown",
    function (e) {
      if (e.key !== "Escape" && e.code !== "Escape") return;
      if (cfIsOpen()) return;
      if (captureState.capDragging) {
        e.preventDefault();
        e.stopImmediatePropagation();
        captureState.capDragging = false;
        captureState.capRect = null;
        capDrawSelect();
        return;
      }
      const sn = $("ovSnap");
      if (sn && !sn.classList.contains("hidden")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        snapBack();
        return;
      }
      const bv = $("ovBoardView");
      if (bv && !bv.classList.contains("hidden")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        bvClose();
        return;
      }
      const ov = $("ovCapture");
      if (!ov || ov.classList.contains("hidden")) {
        if (game.state === "replay" && !document.querySelector(".overlay:not(.hidden)")) {
          e.preventDefault();
          e.stopImmediatePropagation();
          exitReplay();
        }
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (captureState.capMode === "live") {
        capStopStream();
        capShowSources();
        capNote("");
      } else capClose();
    },
    true,
  );
})();
