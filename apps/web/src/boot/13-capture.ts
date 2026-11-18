// @ts-nocheck
import { log } from "../core/logger";
import { game } from "../game/state";
import { $, layoutState } from "../ui/layout";
import { capPrevDraw, capPush, capRedo, capUndo, captureState } from "../practice/capture";
import { boardLibraryState } from "../practice/board-library";

(function () {
  const arrow =
    '<path d="M3 2L3 20L7.6 15.8L10.6 22.6L13.4 21.4L10.4 14.8L16.6 14.4Z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/>';
  const badge = (d) =>
    '<path d="' +
    d +
    '" stroke="#000" stroke-width="3.4" stroke-linecap="round" fill="none"/><path d="' +
    d +
    '" stroke="#fff" stroke-width="1.5" stroke-linecap="round" fill="none"/>';
  const mk = (d) =>
    'url("data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">' +
        arrow +
        badge(d) +
        "</svg>",
    ) +
    '") 3 2,default';
  const P = mk("M24 5V11M21 8H27"),
    E = mk("M21 8H27");
  const apply = (e) => {
    const t = e.target;
    if (!t) return;
    let tool = null,
      els = null;
    if (t.id === "capPrev") {
      tool = captureState.capTool;
      els = [t];
    } else if (t.id === "bvCanvas") {
      tool = boardLibraryState.bvTool;
      els = [t];
    } else if (
      game.editMode &&
      (t === layoutState.bcv ||
        t === layoutState.wrap ||
        (layoutState.wrap && layoutState.wrap.contains(t)))
    ) {
      tool = game.editTool;
      els = [layoutState.bcv];
      if (e.buttons) els.push(layoutState.wrap);
      else layoutState.wrap.style.cursor = "";
    } else if (!game.editMode && layoutState.bcv.style.cursor) {
      layoutState.bcv.style.cursor = "";
      layoutState.wrap.style.cursor = "";
    }
    if (!tool) return;
    if (e.buttons & 2) tool = tool === "erase" ? "paint" : "erase";
    const cur = tool === "erase" ? E : P;
    els.forEach((x) => (x.style.cursor = cur));
  };
  ["pointermove", "pointerdown", "pointerup"].forEach((n) =>
    document.addEventListener(n, apply, true),
  );
})();

(function () {
  let down = false,
    val = 8;
  const cv = () => $("capPrev");
  const cell = (e) => {
    const o = captureState.capDet;
    if (!o || !o.res) return null;
    const r = cv().getBoundingClientRect(),
      c = o.res.cols,
      v = o.res.vis,
      x = Math.floor(((e.clientX - r.left) / r.width) * c),
      y = Math.floor(((e.clientY - r.top) / r.height) * v);
    return x >= 0 && y >= 0 && x < c && y < v ? [x, y] : null;
  };
  const put = (e) => {
    const p = cell(e);
    if (!p) return;
    const g = captureState.capDet.res.grid;
    if (g[p[1]][p[0]] !== val) {
      g[p[1]][p[0]] = val;
      (captureState.capDet.ops = captureState.capDet.ops || []).push({
        t: "s",
        x: p[0],
        y: p[1],
        v: val,
      });
      captureState.capDet.res.blocks = g.reduce((n, r) => n + r.filter(Boolean).length, 0);
      capPrevDraw();
    }
  };
  document.addEventListener("contextmenu", (e) => {
    if (e.target && e.target.id === "capPrev") e.preventDefault();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!e.target || e.target.id !== "capPrev" || !captureState.capDet || !captureState.capDet.res)
      return;
    e.preventDefault();
    down = true;
    val = (e.button === 2) !== (captureState.capTool === "erase") ? 0 : 8;
    try {
      e.target.setPointerCapture(e.pointerId);
    } catch (_) {
      log.debug("boot/13-capture", _);
    }
    capPush();
    put(e);
  });
  document.addEventListener("pointermove", (e) => {
    if (down) put(e);
  });
  const stop = () => {
    down = false;
  };
  document.addEventListener("pointerup", stop);
  document.addEventListener("pointercancel", stop);
  const tl = (t) => {
    captureState.capTool = t;
    $("capTPaint").classList.toggle("active", t === "paint");
    $("capTErase").classList.toggle("active", t === "erase");
  };
  document.addEventListener("click", (e) => {
    const id = e.target && e.target.id;
    if (id === "capTPaint") tl("paint");
    else if (id === "capTErase") tl("erase");
    else if (id === "capTMirror" && captureState.capDet && captureState.capDet.res) {
      capPush();
      captureState.capDet.res.grid.forEach((r) => r.reverse());
      (captureState.capDet.ops = captureState.capDet.ops || []).push({ t: "m" });
      capPrevDraw();
    } else if (id === "capTUndo") capUndo();
    else if (id === "capTRedo") capRedo();
  });
})();
