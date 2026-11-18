// @ts-nocheck
import { log } from "../core/logger";
import { $ } from "../ui/layout";
import {
  boardLibraryState,
  bvMirror,
  bvRedo,
  bvSave,
  bvSetTool,
  bvUndo,
  bvqRender,
  dragMoveBoard,
  renderBoardList,
} from "../practice/board-library";

(function () {
  let D = null,
    raf = 0;
  const L = () => $("capBoardList");
  const scr = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const o = getComputedStyle(p).overflowY;
      if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
      p = p.parentElement;
    }
    return document.scrollingElement;
  };
  function upd() {
    if (!D) return;
    const sc = D.sc,
      dy = D.cy + sc.scrollTop - D.y0,
      c = D.T[D.from] + D.H[D.from] / 2 + dy;
    D.it.style.transform = "translateY(" + dy + "px)";
    let to = 0;
    D.items.forEach((_, k) => {
      if (k !== D.from && D.T[k] + D.H[k] / 2 < c) to++;
    });
    D.to = to;
    const sh = D.H[D.from] + D.gap;
    D.items.forEach((x, k) => {
      if (k === D.from) return;
      x.style.transform =
        D.from < to && k > D.from && k <= to
          ? "translateY(" + -sh + "px)"
          : D.from > to && k >= to && k < D.from
            ? "translateY(" + sh + "px)"
            : "";
    });
  }
  function tick() {
    if (!D) return;
    const r =
        D.sc === document.scrollingElement
          ? { top: 0, bottom: innerHeight }
          : D.sc.getBoundingClientRect(),
      z = 60;
    let v = 0;
    if (D.cy < r.top + z) v = -Math.ceil(((r.top + z - D.cy) / z) * 16);
    else if (D.cy > r.bottom - z) v = Math.ceil(((D.cy - (r.bottom - z)) / z) * 16);
    if (v) {
      D.sc.scrollTop += v;
      upd();
    }
    raf = requestAnimationFrame(tick);
  }
  function end(ok) {
    if (!D) return;
    const d = D;
    D = null;
    cancelAnimationFrame(raf);
    removeEventListener("pointermove", mv);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", cn);
    if (ok && d.to !== d.from) dragMoveBoard(d.from, d.to);
    else {
      d.items.forEach((x) => {
        x.style.transform = "";
        x.classList.remove("dragging");
      });
      renderBoardList();
    }
  }
  const mv = (e) => {
      if (!D || e.pointerId !== D.id) return;
      e.preventDefault();
      D.cy = e.clientY;
      upd();
    },
    up = (e) => {
      if (D && e.pointerId === D.id) end(true);
    },
    cn = (e) => {
      if (D && e.pointerId === D.id) end(false);
    };
  document.addEventListener(
    "pointerdown",
    (e) => {
      const g = e.target.closest && e.target.closest(".cbl-grip");
      if (!g || !L() || !L().contains(g) || D) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      const it = g.closest(".cbl-item"),
        items = [...L().children],
        sc = scr(L());
      const from = items.indexOf(it);
      if (from < 0) return;
      const T = items.map((x) => x.getBoundingClientRect().top + sc.scrollTop),
        H = items.map((x) => x.offsetHeight);
      const gap = items.length > 1 ? Math.max(0, T[1] - T[0] - H[0]) : 8;
      D = {
        id: e.pointerId,
        it,
        items,
        sc,
        from,
        to: from,
        T,
        H,
        gap,
        y0: e.clientY + sc.scrollTop,
        cy: e.clientY,
      };
      items.forEach((x) => {
        if (x !== it) x.style.transition = "transform .18s ease";
      });
      it.classList.add("dragging");
      addEventListener("pointermove", mv, { passive: false });
      addEventListener("pointerup", up);
      addEventListener("pointercancel", cn);
      raf = requestAnimationFrame(tick);
    },
    true,
  );
  document.addEventListener(
    "click",
    (e) => {
      if (e.target.closest && e.target.closest(".cbl-grip")) e.stopPropagation();
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (D && e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        end(false);
      }
    },
    true,
  );
})();

(function () {
  const el = $("bvq");
  if (!el) return;
  el.addEventListener("click", (e) => {
    const hb = e.target.closest("[data-bvh]"),
      rm = e.target.closest("[data-bvrm]"),
      ad = e.target.closest("[data-bvadd]"),
      tg = e.target.closest("[data-bvtgt]"),
      cl = e.target.closest("[data-bvclr]");
    if (hb) {
      boardLibraryState.bvSeq.h = +hb.dataset.bvh;
    } else if (rm) {
      const p = rm.dataset.bvrm.split(":");
      boardLibraryState.bvSeq[p[0]].splice(+p[1], 1);
    } else if (ad) {
      if (boardLibraryState.bvSeq.q.length + boardLibraryState.bvSeq.rem.length < 14)
        boardLibraryState.bvSeq[boardLibraryState.bvqTgt].push(+ad.dataset.bvadd);
    } else if (tg) {
      boardLibraryState.bvqTgt = tg.dataset.bvtgt;
      bvqRender();
      return;
    } else if (cl) {
      boardLibraryState.bvSeq = { q: [], rem: [], h: -1 };
    } else return;
    boardLibraryState.bvDirty = true;
    bvqRender();
  });
})();

(function () {
  const cv = $("bvCanvas");
  if (cv)
    cv.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  const _bvWire = (id, fn) => {
    const el = $(id);
    if (el)
      el.addEventListener("click", (e) => {
        fn();
        try {
          el.blur();
        } catch (_) {
          log.debug("boot/14-board-library._bvWire", _);
        }
      });
  };
  _bvWire("bvUndoBtn", bvUndo);
  _bvWire("bvRedoBtn", bvRedo);
  _bvWire("bvPaintBtn", () => bvSetTool("paint"));
  _bvWire("bvEraseBtn", () => bvSetTool("erase"));
  _bvWire("bvMirrorBtn", bvMirror);
  _bvWire("bvSaveBtn", bvSave);
})();
