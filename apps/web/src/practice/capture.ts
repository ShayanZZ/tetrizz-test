// @ts-nocheck
import { log, swallow } from "../core/logger";
import { clamp, configState } from "../core/config";
import { $, layoutState, savePractice } from "../ui/layout";
import { selectMode } from "../ui/settings";
import {
  addBoardEntry,
  boardLibraryState,
  bvqCommit,
  bvqRender,
  drawStyledGrid,
  renderBoardList,
  selectedBoard,
} from "./board-library";
import { versusLobbyState } from "../versus/lobby";

export const captureState = {
  capStream: null,
  capSrc: null,
  capMode: "",
  capSourceKind: "",
  capRect: null,
  capDragging: false,
  capDragStart: null,
  capRaf: 0,
  capDet: null,
  capTool: "paint",
};

export function capOpen() {
  if (versusLobbyState.vsActive !== undefined && versusLobbyState.vsActive) return;
  if (configState.mode !== "practice") selectMode("practice");
  const ov = $("ovCapture");
  if (!ov) return;
  ov.classList.remove("hidden");
  ov.removeAttribute("inert");
  capNote("");
  capShowSources();
  renderBoardList();
}

export function capClose() {
  capStopStream();
  captureState.capSrc = null;
  captureState.capRect = null;
  captureState.capMode = "";
  captureState.capDragging = false;
  const ov = $("ovCapture");
  if (ov) {
    ov.classList.add("hidden");
    ov.setAttribute("inert", "");
  }
}

export function capShowSources() {
  captureState.capMode = "";
  captureState.capSrc = null;
  captureState.capRect = null;
  const w = $("capWork");
  if (w) w.style.display = "none";
  capStopStream();
}

export function capNote(msg, err) {
  const n = $("capNote");
  if (!n) return;
  n.textContent = msg || "";
  n.style.color = err ? "#f5546b" : "";
}

export function capFromFile(file, kind) {
  capFromFile._kind = kind || "file";
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0);
    capToSelect(c, capFromFile._kind || "file");
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    capNote("Could not read that image.", true);
  };
  img.src = url;
}

export async function capFromScreen() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    capNote("Screen capture is not supported in this browser.", true);
    return;
  }
  capNote("Choose the window or screen that shows the board…");
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 15, cursor: "never" },
      audio: false,
    });
    setTimeout(() => window.focus(), 100);
    capStartLive(s, "screen");
  } catch (_) {
    capNote("Screen capture was cancelled.", true);
  }
}

export function capFromCamera() {
  const ci = $("capCameraInput");
  if (ci) {
    ci.value = "";
    ci.click();
  } else capNote("Camera is not available here.", true);
}

function capStartLive(stream, kind) {
  capStopStream();
  captureState.capStream = stream;
  captureState.capSourceKind = kind;
  captureState.capMode = "live";
  captureState.capRect = null;
  const v = $("capVideo");
  if (v) {
    v.srcObject = stream;
    v.muted = true;
    v.playsInline = true;
    v.play().catch(swallow("practice/capture.videoPlay"));
  }
  const w = $("capWork");
  if (w) w.style.display = "";
  $("capLiveUI").style.display = "";
  $("capSelectUI").style.display = "none";
  if (kind === "screen") {
    capNote(
      "Switch to the board window if needed — the frame freezes automatically in 3 seconds, or click CAPTURE FRAME now.",
    );
    capStartLive._t = setTimeout(() => {
      if (captureState.capMode === "live") capFreeze();
    }, 3000);
  } else capNote("Drag on the image to select the playfield.");
  cancelAnimationFrame(captureState.capRaf);
  const loop = () => {
    if (captureState.capMode !== "live") return;
    capDrawLive();
    captureState.capRaf = requestAnimationFrame(loop);
  };
  captureState.capRaf = requestAnimationFrame(loop);
}

function capFitSize(iw, ih) {
  const stage = $("capStage");
  const availW = Math.max(120, (stage && stage.clientWidth) || 600);
  const availH = Math.max(120, Math.round(innerHeight * 0.52));
  const s = Math.min(availW / iw, availH / ih);
  return { w: Math.max(60, Math.round(iw * s)), h: Math.max(60, Math.round(ih * s)), s: s };
}

function capDrawLive() {
  const v = $("capVideo"),
    cv = $("capCanvas");
  if (!v || !cv || !v.videoWidth) return;
  const fit = capFitSize(v.videoWidth, v.videoHeight);
  const pw = Math.round(fit.w * layoutState.dpr),
    ph = Math.round(fit.h * layoutState.dpr);
  if (cv.width !== pw || cv.height !== ph) {
    cv.width = pw;
    cv.height = ph;
    cv.style.width = fit.w + "px";
    cv.style.height = fit.h + "px";
  }
  const c = cv.getContext("2d");
  c.setTransform(layoutState.dpr, 0, 0, layoutState.dpr, 0, 0);
  c.drawImage(v, 0, 0, fit.w, fit.h);
}

export function capFreeze() {
  const v = $("capVideo");
  if (!v || !v.videoWidth) return;
  const c = document.createElement("canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d", { willReadFrequently: true }).drawImage(v, 0, 0);
  const kind = captureState.capSourceKind;
  capStopStream();
  capToSelect(c, kind);
}

export function capStopStream() {
  if (capStartLive._t) {
    clearTimeout(capStartLive._t);
    capStartLive._t = null;
  }
  cancelAnimationFrame(captureState.capRaf);
  captureState.capRaf = 0;
  if (captureState.capStream) {
    try {
      captureState.capStream.getTracks().forEach((t) => t.stop());
    } catch (_) {
      log.debug("practice/capture.capStopStream", _);
    }
    captureState.capStream = null;
  }
  const v = $("capVideo");
  if (v) v.srcObject = null;
}

function capToSelect(srcCanvas, kind) {
  captureState.capSrc = srcCanvas;
  captureState.capSourceKind = kind;
  captureState.capMode = "select";
  captureState.capRect = null;
  const w = $("capWork");
  if (w) w.style.display = "";
  $("capLiveUI").style.display = "none";
  $("capSelectUI").style.display = "";
  capNote(
    "Drag over the board — or over the whole screenshot, or just the stack. The detector finds the cells, the field and the stack by itself.",
  );
  capDrawSelect();
}

export function capDrawSelect() {
  const cv = $("capCanvas");
  if (!cv || !captureState.capSrc) return;
  const fit = capFitSize(captureState.capSrc.width, captureState.capSrc.height);
  const pw = Math.round(fit.w * layoutState.dpr),
    ph = Math.round(fit.h * layoutState.dpr);
  if (cv.width !== pw || cv.height !== ph) {
    cv.width = pw;
    cv.height = ph;
    cv.style.width = fit.w + "px";
    cv.style.height = fit.h + "px";
  }
  const c = cv.getContext("2d");
  c.setTransform(layoutState.dpr, 0, 0, layoutState.dpr, 0, 0);
  c.clearRect(0, 0, fit.w, fit.h);
  c.drawImage(captureState.capSrc, 0, 0, fit.w, fit.h);
  cv._fitS = fit.s;
  if (captureState.capRect) {
    const s = fit.s;
    const rx = captureState.capRect.x * s,
      ry = captureState.capRect.y * s,
      rw = captureState.capRect.w * s,
      rh = captureState.capRect.h * s;
    c.save();
    c.fillStyle = "rgba(0,0,0,.55)";
    c.fillRect(0, 0, fit.w, ry);
    c.fillRect(0, ry + rh, fit.w, fit.h - (ry + rh));
    c.fillRect(0, ry, rx, rh);
    c.fillRect(rx + rw, ry, fit.w - (rx + rw), rh);
    c.strokeStyle = "#4fe08a";
    c.lineWidth = 2;
    c.setLineDash([6, 4]);
    c.strokeRect(rx, ry, rw, rh);
    c.setLineDash([]);
    c.restore();
  }
}

function capPos(e) {
  const cv = $("capCanvas");
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

export function capPointerDown(e) {
  if (captureState.capMode === "live") capFreeze();
  if (captureState.capMode !== "select" || !captureState.capSrc) return;
  e.preventDefault();
  captureState.capDragging = true;
  captureState.capDragStart = capPos(e);
  captureState.capRect = null;
  try {
    e.target.setPointerCapture(e.pointerId);
  } catch (_) {
    log.debug("practice/capture.capPointerDown", _);
  }
}

export function capPointerMove(e) {
  if (!captureState.capDragging || captureState.capMode !== "select" || !captureState.capSrc)
    return;
  e.preventDefault();
  const p = capPos(e),
    s = $("capCanvas")._fitS || 1;
  const x0 = Math.min(captureState.capDragStart.x, p.x),
    x1 = Math.max(captureState.capDragStart.x, p.x);
  const y0 = Math.min(captureState.capDragStart.y, p.y),
    y1 = Math.max(captureState.capDragStart.y, p.y);
  const rx = clamp(x0 / s, 0, captureState.capSrc.width),
    ry = clamp(y0 / s, 0, captureState.capSrc.height);
  captureState.capRect = {
    x: rx,
    y: ry,
    w: clamp((x1 - x0) / s, 0, captureState.capSrc.width - rx),
    h: clamp((y1 - y0) / s, 0, captureState.capSrc.height - ry),
  };
  capDrawSelect();
}

export function capPointerUp() {
  if (!captureState.capDragging) return;
  captureState.capDragging = false;
  if (captureState.capRect && (captureState.capRect.w < 8 || captureState.capRect.h < 8)) {
    captureState.capRect = null;
    capNote("Selection too small — drag across the whole playfield.", true);
  }
  capDrawSelect();
}

export function capRetake() {
  captureState.capRect = null;
  captureState.capDet = null;
  capPrevShow(false);
  if (captureState.capSourceKind === "screen") capFromScreen();
  else if (captureState.capSourceKind === "camera") capFromCamera();
  else {
    captureState.capSrc = null;
    captureState.capMode = "";
    const w = $("capWork");
    if (w) w.style.display = "none";
    capNote("");
  }
}

function capHue(r, g, b) {
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b);
  if (mx === mn) return -1;
  const d = mx - mn;
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function capPieceByHue(h) {
  if (h < 20 || h >= 330) return 6;
  if (h < 50) return 2;
  if (h < 70) return 3;
  if (h < 165) return 4;
  if (h < 200) return 0;
  if (h < 260) return 1;
  return 5;
}

function capWrap(d, S) {
  d = d % S;
  if (d > S / 2) d -= S;
  if (d < -S / 2) d += S;
  return d;
}

function capRes(pos, wts, S) {
  let c = 0,
    s = 0,
    W = 0;
  for (let i = 0; i < pos.length; i++) {
    const a = (6.283185307 * pos[i]) / S;
    c += wts[i] * Math.cos(a);
    s += wts[i] * Math.sin(a);
    W += wts[i];
  }
  return W > 0 ? Math.hypot(c, s) / W : 0;
}

function capPhase(pos, wts, S) {
  let m = 0;
  for (let it = 0; it < 3; it++) {
    let c = 0,
      s = 0;
    for (let i = 0; i < pos.length; i++) {
      const a = (6.283185307 * pos[i]) / S;
      const k = it ? (Math.abs(capWrap(pos[i] - m, S)) <= 0.2 * S ? 1 : 0) : 1;
      c += wts[i] * k * Math.cos(a);
      s += wts[i] * k * Math.sin(a);
    }
    m = ((Math.atan2(s, c) / 6.283185307) * S + S) % S;
  }
  return m;
}

function capModeColor(arr) {
  const m = new Map();
  for (const c of arr) {
    const k = ((c[0] / 20) | 0) + "," + ((c[1] / 20) | 0) + "," + ((c[2] / 20) | 0);
    let e = m.get(k);
    if (!e) {
      e = { n: 0, r: 0, g: 0, b: 0 };
      m.set(k, e);
    }
    e.n++;
    e.r += c[0];
    e.g += c[1];
    e.b += c[2];
  }
  let b = null;
  for (const e of m.values()) if (!b || e.n > b.n) b = e;
  return b ? [b.r / b.n, b.g / b.n, b.b / b.n] : null;
}

function capPeriod(lum, w, h) {
  const prof = (len, get) => {
    const e = new Float32Array(len);
    get(e);
    let m = 0;
    for (const v of e) m += v;
    m /= len;
    for (let i = 0; i < len; i++) e[i] -= m;
    let a0 = 0;
    for (const v of e) a0 += v * v;
    if (a0 <= 0) return null;
    let best = 0,
      bl = 0;
    const hi = Math.min(200, len >> 2);
    const ac = [];
    for (let L = 8; L <= hi; L++) {
      let a = 0;
      for (let i = 0; i + L < len; i++) a += e[i] * e[i + L];
      ac[L] = a / a0;
    }
    for (let L = 9; L < hi; L++) {
      if (ac[L] > ac[L - 1] && ac[L] >= ac[L + 1] && ac[L] > best) {
        best = ac[L];
        bl = L;
      }
    }
    return best >= 0.2 ? { L: bl, v: best } : null;
  };
  const px = prof(w, (e) => {
    for (let y = 0; y < h; y += 2)
      for (let x = 0; x < w - 1; x++) e[x] += Math.abs(lum[y * w + x + 1] - lum[y * w + x]);
  });
  const py = prof(h, (e) => {
    for (let y = 0; y < h - 1; y++)
      for (let x = 0; x < w; x += 2) e[y] += Math.abs(lum[(y + 1) * w + x] - lum[y * w + x]);
  });
  if (px && py && Math.abs(px.L - py.L) <= Math.max(1.5, 0.04 * px.L)) return (px.L + py.L) / 2;
  return null;
}

function capAnalyze(src, rect) {
  const rx = Math.max(0, Math.floor(rect.x)),
    ry = Math.max(0, Math.floor(rect.y));
  const rw = Math.max(1, Math.min(Math.floor(rect.w), src.width - rx)),
    rh = Math.max(1, Math.min(Math.floor(rect.h), src.height - ry));
  const sc = Math.min(1, 1400 / Math.max(rw, rh));
  const w = Math.max(8, Math.round(rw * sc)),
    h = Math.max(8, Math.round(rh * sc));
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(src, rx, ry, rw, rh, 0, 0, w, h);
  let img;
  try {
    img = cx.getImageData(0, 0, w, h);
  } catch (_) {
    return null;
  }
  const d = img.data,
    N = w * h;
  const lumA = new Uint8Array(N);
  for (let i = 0, p = 0; i < N; i++, p += 4)
    lumA[i] = (0.3 * d[p] + 0.59 * d[p + 1] + 0.11 * d[p + 2]) | 0;
  const Pgrid = capPeriod(lumA, w, h);
  const mask = new Uint8Array(N);
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const mx = Math.max(d[p], d[p + 1], d[p + 2]),
      mn = Math.min(d[p], d[p + 1], d[p + 2]);
    if (mx >= 60 && mx - mn >= 0.32 * mx)
      mask[i] = capPieceByHue(capHue(d[p], d[p + 1], d[p + 2])) + 1;
  }

  {
    const r = Math.max(1, Math.round(Math.min(w, h) / 450));
    const Lr = new Int16Array(N),
      Rr = new Int16Array(N),
      Ur = new Int16Array(N),
      Dr = new Int16Array(N);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        Lr[i] = x > 0 && mask[i - 1] === mask[i] ? Lr[i - 1] + 1 : 0;
        Ur[i] = y > 0 && mask[i - w] === mask[i] ? Ur[i - w] + 1 : 0;
      }
    for (let y = h - 1; y >= 0; y--)
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (!mask[i]) continue;
        Rr[i] = x < w - 1 && mask[i + 1] === mask[i] ? Rr[i + 1] + 1 : 0;
        Dr[i] = y < h - 1 && mask[i + w] === mask[i] ? Dr[i + w] + 1 : 0;
      }
    for (let i = 0; i < N; i++)
      if (mask[i] && !(Lr[i] >= r && Rr[i] >= r && Ur[i] >= r && Dr[i] >= r)) mask[i] = 0;
  }
  const lab = new Int32Array(N),
    st = new Int32Array(N),
    comps = [];
  for (let i = 0; i < N; i++) {
    if (!mask[i] || lab[i]) continue;
    let sp = 0,
      area = 0,
      x0 = w,
      y0 = h,
      x1 = 0,
      y1 = 0;
    const id = comps.length + 1;
    st[sp++] = i;
    lab[i] = id;
    while (sp) {
      const j = st[--sp],
        x = j % w,
        y = (j / w) | 0;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mask[j - 1] === mask[j] && !lab[j - 1]) {
        lab[j - 1] = id;
        st[sp++] = j - 1;
      }
      if (x < w - 1 && mask[j + 1] === mask[j] && !lab[j + 1]) {
        lab[j + 1] = id;
        st[sp++] = j + 1;
      }
      if (y > 0 && mask[j - w] === mask[j] && !lab[j - w]) {
        lab[j - w] = id;
        st[sp++] = j - w;
      }
      if (y < h - 1 && mask[j + w] === mask[j] && !lab[j + w]) {
        lab[j + w] = id;
        st[sp++] = j + w;
      }
    }
    comps.push({ area, x0, y0, x1: x1 + 1, y1: y1 + 1 });
  }
  let cs = comps.filter(
    (c) =>
      c.area >= 12 &&
      c.x1 - c.x0 >= 3 &&
      c.y1 - c.y0 >= 3 &&
      c.area / Math.max(c.x1 - c.x0, c.y1 - c.y0) >= 3,
  );

  let edgeMode = false;
  if (cs.length < 3) {
    edgeMode = true;
    const lum = new Float32Array(N);
    for (let i = 0, p = 0; i < N; i++, p += 4)
      lum[i] = 0.3 * d[p] + 0.59 * d[p + 1] + 0.11 * d[p + 2];
    const ex = new Float32Array(w),
      ey = new Float32Array(h);
    for (let y = 0; y < h - 1; y++)
      for (let x = 0; x < w - 1; x++) {
        const i = y * w + x;
        ex[x] += Math.abs(lum[i + 1] - lum[i]);
        ey[y] += Math.abs(lum[i + w] - lum[i]);
      }
    const pk = (e) => {
      let m = 0,
        s = 0;
      for (const v of e) {
        m += v;
      }
      m /= e.length;
      for (const v of e) s += (v - m) * (v - m);
      s = Math.sqrt(s / e.length);
      const o = [];
      for (let i = 1; i < e.length - 1; i++)
        if (e[i] > m + 1.2 * s && e[i] >= e[i - 1] && e[i] >= e[i + 1]) o.push(i);
      return o;
    };
    const px = pk(ex),
      py = pk(ey);
    cs = [];
    for (let i = 0; i + 1 < px.length; i++)
      for (let j = 0; j + 1 < py.length && cs.length < 400; j += 1) {
        if (px[i + 1] - px[i] >= 4 && py[j + 1] - py[j] >= 4 && (i + j) % 3 === 0)
          cs.push({
            area: (px[i + 1] - px[i]) * (py[j + 1] - py[j]),
            x0: px[i],
            x1: px[i + 1],
            y0: py[j],
            y1: py[j + 1],
          });
      }
    if (cs.length < 3 && !Pgrid) return null;
  }
  const wt = cs.map((c) => c.area);
  const Lx = cs.map((c) => c.x0),
    Rx = cs.map((c) => c.x1),
    Ty = cs.map((c) => c.y0),
    By = cs.map((c) => c.y1);
  const lists = [Lx, Rx, Ty, By];
  if (cs.length < 3 && Pgrid) {
  }
  const dimErr = (S, idx) => {
    let e = 0,
      W = 0;
    for (const i of idx) {
      const bw = (cs[i].x1 - cs[i].x0) / S,
        bh = (cs[i].y1 - cs[i].y0) / S;
      const f = (v) => {
        if (v < 0.5) return 0.5;
        const k = Math.max(1, Math.round(v + 0.12)),
          df = v - k;
        return df < 0 ? Math.max(0, -df - 0.25) : Math.max(0, df - 0.1);
      };
      e += (wt[i] * (f(bw) + f(bh))) / 2;
      W += wt[i];
    }
    return W ? e / W : 1;
  };
  const allIdx = cs.map((_, i) => i);

  const inliers = (S) => {
    const ph = lists.map((l) => capPhase(l, wt, S));
    const out = [];
    for (let i = 0; i < cs.length; i++) {
      let ok = true;
      for (let k = 0; k < 4; k++)
        if (Math.abs(capWrap(lists[k][i] - ph[k], S)) > 0.14 * S) {
          ok = false;
          break;
        }
      if (ok) out.push(i);
    }
    return out;
  };
  const inlW = (S) => {
    const ii = inliers(S);
    let s = 0,
      t = 0;
    for (const i of ii) s += wt[i];
    for (const w of wt) t += w;
    return { ii, f: t ? s / t : 0 };
  };
  let best = -1;
  const tab = [];
  const minS = 6,
    maxS = Math.min(200, Math.max(w, h) / 3);
  for (let S = minS; S <= maxS; S += 0.5) {
    const r = inlW(S);
    const de = dimErr(S, r.ii.length ? r.ii : allIdx);
    tab.push([S, r.f, de]);
    if (r.f > best) best = r.f;
  }
  let S0 = minS;
  for (let i = tab.length - 1; i >= 0; i--) {
    if (tab[i][1] >= best - 0.1 && tab[i][2] <= 0.14) {
      S0 = tab[i][0];
      break;
    }
  }
  if (Pgrid) {
    let bd = 1e9,
      bS = 0;
    for (const t of tab) {
      const dd = Math.abs(t[0] - Pgrid);
      if (dd < bd && t[1] >= best - 0.25 && t[2] <= 0.25) {
        bd = dd;
        bS = t[0];
      }
    }
    if (
      bS &&
      bd <= Math.max(1.5, 0.05 * Pgrid) &&
      (cs.length < 6 || S0 < bS * 0.7 || S0 > bS * 1.3)
    )
      S0 = bS;
  }
  let S = S0,
    bs = -9;
  {
    const ii0 = inlW(S0).ii;
    const sub = (l) => ii0.map((i) => l[i]),
      sw = ii0.map((i) => wt[i]);
    const use = ii0.length >= 2 ? [sub(Lx), sub(Rx), sub(Ty), sub(By)] : lists,
      ww = ii0.length >= 2 ? sw : wt;
    for (let t = S0 * 0.9; t <= S0 * 1.1; t += 0.05) {
      let v = 0;
      for (const l of use) v += capRes(l, ww, t);
      if (v >= bs - 1e-9) {
        bs = v;
        S = t;
      }
    }
  }
  const inl = inlW(S).ii;
  const sx = (l) => (inl.length >= 2 ? inl.map((i) => l[i]) : l),
    sw2 = inl.length >= 2 ? inl.map((i) => wt[i]) : wt;
  const ox = capPhase(sx(Lx), sw2, S),
    oy = capPhase(sx(Ty), sw2, S);

  const iS = ox >= 0.4 * S ? -1 : 0,
    jS = oy >= 0.4 * S ? -1 : 0;
  const cells = [];
  let nC = 0,
    nR = 0;
  for (let j = jS; ; j++) {
    const y0 = oy + j * S,
      y1 = y0 + S,
      vy0 = Math.max(0, y0),
      vy1 = Math.min(h, y1);
    if (vy1 - vy0 < 0.4 * S) break;
    nR++;
    const row = [];
    nC = 0;
    for (let i = iS; ; i++) {
      const x0 = ox + i * S,
        x1 = x0 + S,
        vx0 = Math.max(0, x0),
        vx1 = Math.min(w, x1);
      if (vx1 - vx0 < 0.4 * S) break;
      nC++;
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      const ax = vx0 + 0.3 * (vx1 - vx0),
        bx = vx0 + 0.7 * (vx1 - vx0),
        ay = vy0 + 0.3 * (vy1 - vy0),
        by = vy0 + 0.7 * (vy1 - vy0);
      const stx = Math.max(1, (bx - ax) / 6),
        sty = Math.max(1, (by - ay) / 6);
      for (let yy = ay; yy <= by; yy += sty)
        for (let xx = ax; xx <= bx; xx += stx) {
          const p = (Math.min(h - 1, yy | 0) * w + Math.min(w - 1, xx | 0)) * 4;
          r += d[p];
          g += d[p + 1];
          b += d[p + 2];
          n++;
        }
      row.push([r / n, g / n, b / n]);
    }
    cells.push(row);
  }
  return {
    S,
    scale: sc,
    ox,
    oy,
    nC,
    nR,
    cells,
    edgeMode,
    imgW: w,
    imgH: h,
    lum: lumA,
    iS,
    jS,
  };
}

function capReadBoard(an, opt) {
  opt = opt || {};
  const cells = an.cells,
    nR = an.nR,
    nC = an.nC;
  const sat = (c) => {
    const mx = Math.max(c[0], c[1], c[2]),
      mn = Math.min(c[0], c[1], c[2]);
    return mx === 0 ? 0 : (mx - mn) / mx;
  };
  const mx3 = (c) => Math.max(c[0], c[1], c[2]);
  const d2 = (a, b) => {
    const x = a[0] - b[0],
      y = a[1] - b[1],
      z = a[2] - b[2];
    return x * x + y * y + z * z;
  };
  const isCol = (c) => sat(c) >= 0.33 && mx3(c) >= 70;
  const cluster = (isB) => {
    const seen = new Set(),
      out = [];
    for (let r = 0; r < nR; r++)
      for (let c = 0; c < nC; c++) {
        if (!isB(r, c) || seen.has(r * nC + c)) continue;
        const q = [[r, c]],
          mem = [];
        seen.add(r * nC + c);
        while (q.length) {
          const [a, b] = q.pop();
          mem.push([a, b]);
          for (let da = -2; da <= 2; da++)
            for (let db = -2; db <= 2; db++) {
              const x = a + da,
                y = b + db;
              if (x < 0 || y < 0 || x >= nR || y >= nC || seen.has(x * nC + y) || !isB(x, y))
                continue;
              seen.add(x * nC + y);
              q.push([x, y]);
            }
        }
        out.push(mem);
      }
    out.sort((p, q) => q.length - p.length);
    return out;
  };
  let grayMode = false,
    E = null;
  let cl = cluster((r, c) => isCol(cells[r][c]));
  {
    const all = [];
    for (const row of cells) for (const c of row) all.push(c);
    const E0 = capModeColor(all) || [0, 0, 0];
    const gcl = cluster((r, c) => !isCol(cells[r][c]) && d2(cells[r][c], E0) > 12000);
    if (!cl.length || cl[0].length < 3 || (gcl.length && gcl[0].length > 2 * cl[0].length)) {
      grayMode = true;
      E = E0;
      cl = cluster((r, c) => d2(cells[r][c], E0) > 12000);
    }
  }
  if (!cl.length)
    return {
      cols: opt.cols || 10,
      vis: opt.rows || 20,
      grid: Array.from({ length: opt.rows || 20 }, () => new Array(opt.cols || 10).fill(0)),
      blocks: 0,
      note: "No blocks found in the selection.",
    };
  const main = cl[0];
  let rt = 1e9,
    rb = -1,
    cL = 1e9,
    cR = -1;
  for (const [r, c] of main) {
    rt = Math.min(rt, r);
    rb = Math.max(rb, r);
    cL = Math.min(cL, c);
    cR = Math.max(cR, c);
  }

  {
    const arr = [];
    for (let r = Math.max(0, rt - 8); r <= rb; r++)
      for (let c = cL; c <= cR; c++) {
        const x = cells[r][c];
        if (!isCol(x) && !(grayMode && d2(x, E) > 12000)) arr.push(x);
      }
    E = capModeColor(arr) || E || capModeColor([].concat(...cells)) || [0, 0, 0];
  }
  const TOL = 5200;
  const kind = (c) => {
    if (isCol(c) && !grayMode) return 1;
    const dd = d2(c, E);
    if (dd <= TOL) return 0;
    return grayMode ? 1 : 2;
  };
  const K = cells.map((row) => row.map(kind));
  const Kstrict = cells.map((row, r) =>
    row.map((c, k) => (K[r][k] === 0 ? (d2(c, E) <= 160 ? 0 : 3) : K[r][k])),
  );
  const wallStr = (b) => {
    const x = Math.round(an.ox + (b + an.iS) * an.S);
    if (x < 3 || x >= an.imgW - 3) return 0;
    let tot = 0,
      n = 0;
    const wr0 = rt >= 2 ? Math.max(0, rt - 10) : rt,
      wr1 = rt >= 2 ? rt - 1 : rb;
    for (let r = wr0; r <= wr1; r++) {
      const y0 = Math.round(an.oy + (r + an.jS) * an.S);
      for (let y = y0 + Math.round(an.S * 0.2); y < y0 + an.S * 0.8 && y < an.imgH; y += 2) {
        let m = 0;
        for (let dx = -2; dx <= 2; dx++) {
          const g = Math.abs(an.lum[y * an.imgW + x + dx + 1] - an.lum[y * an.imgW + x + dx - 1]);
          if (g > m) m = g;
        }
        tot += m;
        n++;
      }
    }
    return n ? tot / n : 0;
  };
  const WS = [];
  for (let b = 0; b <= nC; b++) WS.push(wallStr(b));

  let wallA = -1,
    wallB = -1;
  if (rt >= 2) {
    const sorted = WS.slice().sort((a, b) => a - b),
      med = sorted[sorted.length >> 1],
      T = Math.max(25, 2.2 * med + 10);
    let a = -1,
      b = -1;
    for (let q = cL; q >= 0; q--)
      if (WS[q] >= T) {
        a = q;
        break;
      }
    for (let q = cR + 1; q <= nC; q++)
      if (WS[q] >= T) {
        b = q;
        break;
      }
    if (a >= 0 && b >= 0 && b - a >= 4 && b - a <= 20 && b - a >= cR - cL + 1) {
      wallA = a;
      wallB = b;
    }
  }

  let W = opt.cols > 0 ? opt.cols : 0,
    autoNote = "";
  if (!W && wallA >= 0) W = wallB - wallA;
  if (!W) {
    let rr = -1;
    for (let r = rt - 1; r >= Math.max(0, rt - 6); r--) {
      if (K[r][Math.floor((cL + cR) / 2)] === 0) {
        rr = r;
        break;
      }
    }
    if (rr < 0) rr = rt;
    let a = Math.floor((cL + cR) / 2),
      b = a;
    while (a > 0 && (Kstrict[rr][a - 1] === 0 || Kstrict[rr][a - 1] === 1)) a--;
    while (b < nC - 1 && (Kstrict[rr][b + 1] === 0 || Kstrict[rr][b + 1] === 1)) b++;
    const bounded = a > 0 && b < nC - 1,
      run = b - a + 1;
    W =
      bounded && run >= 4 && run <= 20
        ? run
        : rt >= 2 && a === 0 && b === nC - 1 && nC >= 4 && nC <= 12
          ? nC
          : 10;
    if (W < cR - cL + 1) W = Math.min(20, cR - cL + 1);
  }

  const bw = cR - cL + 1;
  let p;
  if (wallA >= 0 && W === wallB - wallA && !(opt.cols > 0)) {
    p = wallA;
  } else if (nC <= W) {
    p = Math.round((nC - W) / 2);
    autoNote =
      nC < W
        ? "The selection is narrower than the board — placed in the middle (use ◀ ▶ to move it)."
        : "";
  } else {
    const wallBonus = (q) => {
      const inner = WS.slice(q + 1, q + W)
        .slice()
        .sort((a, b) => a - b);
      const m = inner.length ? inner[inner.length >> 1] : 0;
      const f = (v) => Math.max(0, Math.min(3, (v - m) / (m + 8)));
      return f(WS[q]) + f(WS[q + W]);
    };
    let bestS = -1e9,
      bestP = 0,
      bd = 1e9;
    const lo = bw <= W ? Math.max(0, cR - W + 1) : 0,
      hi = bw <= W ? Math.min(nC - W, cL) : nC - W;
    for (let q = lo; q <= hi; q++) {
      let s = 0;
      for (let r = Math.max(0, rt - 3); r <= rb; r++)
        for (let c = q; c < q + W; c++) {
          const k = Kstrict[r][c];
          s += k === 1 ? 1 : k === 0 ? 0.5 : k === 3 ? -0.5 : -1;
        }
      s += 14 * wallBonus(q);
      const dist = Math.abs(q + W / 2 - (cL + cR + 1) / 2);
      if (s > bestS + 1e-9 || (Math.abs(s - bestS) < 1e-9 && dist < bd)) {
        bestS = s;
        bestP = q;
        bd = dist;
      }
    }
    p = bestP;
  }
  p += opt.shift || 0;

  const typ = Array.from({ length: nR }, () => new Array(W).fill(0));
  for (let r = 0; r < nR; r++)
    for (let k = 0; k < W; k++) {
      const c = p + k;
      if (c < 0 || c >= nC) continue;
      const v = cells[r][c];
      if (isCol(v)) {
        const h = capHue(v[0], v[1], v[2]);
        typ[r][k] = h < 0 ? 8 : capPieceByHue(h) + 1;
      } else if (grayMode && K[r][c] === 1) typ[r][k] = 8;
    }
  if (!grayMode) {
    const seen = new Set(),
      q = [];
    for (let r = 0; r < nR; r++)
      for (let k = 0; k < W; k++)
        if (typ[r][k]) {
          seen.add(r * W + k);
          q.push([r, k]);
        }
    while (q.length) {
      const [r, k] = q.pop();
      for (const [a, b] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const x = r + a,
          y = k + b;
        if (x < 0 || y < 0 || x >= nR || y >= W || seen.has(x * W + y)) continue;
        const c = p + y;
        if (c < 0 || c >= nC) continue;
        if (K[x][c] !== 2) continue;
        const v = cells[x][c];
        if (isCol(v)) continue;
        seen.add(x * W + y);
        typ[x][y] = 8;
        q.push([x, y]);
      }
    }
  }

  let floor = -1;
  for (let r = 0; r < nR; r++) if (typ[r].some((v) => v)) floor = r;
  {
    const seen = new Set();
    const comps = [];
    for (let r = 0; r < nR; r++)
      for (let k = 0; k < W; k++) {
        if (!typ[r][k] || seen.has(r * W + k)) continue;
        const t = typ[r][k],
          q = [[r, k]],
          mem = [];
        seen.add(r * W + k);
        while (q.length) {
          const [a, b] = q.pop();
          mem.push([a, b]);
          for (const [da, db] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const x = a + da,
              y = b + db;
            if (x < 0 || y < 0 || x >= nR || y >= W || seen.has(x * W + y) || typ[x][y] !== t)
              continue;
            seen.add(x * W + y);
            q.push([x, y]);
          }
        }
        comps.push(mem);
      }
    let removed = 0;
    if (comps.length > 1)
      for (const m of comps) {
        if (m.length !== 4) continue;
        let touch = false,
          nb = false;
        const own = new Set(m.map(([a, b]) => a * W + b));
        for (const [a, b] of m) {
          if (a >= floor) touch = true;
          for (let da = -1; da <= 1; da++)
            for (let db = -1; db <= 1; db++) {
              const x = a + da,
                y = b + db;
              if (x < 0 || y < 0 || x >= nR || y >= W || own.has(x * W + y)) continue;
              if (typ[x][y]) nb = true;
            }
        }
        if (!touch && !nb) {
          for (const [a, b] of m) typ[a][b] = 0;
          removed++;
        }
      }
    if (removed) {
      floor = -1;
      for (let r = 0; r < nR; r++) if (typ[r].some((v) => v)) floor = r;
    }
  }
  let top = nR;
  for (let r = 0; r < nR; r++)
    if (typ[r].some((v) => v)) {
      top = r;
      break;
    }
  const sh = floor < 0 ? 0 : floor - top + 1;
  const H = opt.rows > 0 ? opt.rows : Math.min(40, Math.max(20, sh));
  const grid = Array.from({ length: H }, () => new Array(W).fill(0));
  let blocks = 0,
    clipped = false;
  for (let r = top; r <= floor && floor >= 0; r++) {
    const orow = H - 1 - (floor - r);
    if (orow < 0) {
      clipped = true;
      continue;
    }
    for (let k = 0; k < W; k++) {
      grid[orow][k] = typ[r][k];
      if (typ[r][k]) blocks++;
    }
  }
  return {
    cols: W,
    vis: H,
    grid,
    blocks,
    shift: opt.shift || 0,
    winStart: p,
    nC,
    nR,
    stackH: sh,
    note:
      autoNote +
      (clipped ? " Stack is taller than the board — top rows were cut." : "") +
      (grayMode ? " (grey-only board)" : ""),
  };
}

export function bvqMount(w) {
  const q = $("bvq");
  if (!q) return;
  if (w === "cap") {
    const h = $("capPrevQ");
    if (h && q.parentNode !== h) h.appendChild(q);
  } else {
    const m = $("bvqMark");
    if (m && q.previousSibling !== m) m.after(q);
  }
}

export function capPrevShow(on) {
  const b = $("capPrevBox");
  if (b) b.style.display = on ? "" : "none";
  if (on) bvqMount("cap");
  else bvqMount("bv");
}

export function capPrevDraw() {
  const o = captureState.capDet;
  if (!o || !o.res) return;
  const rd = o.res,
    cv = $("capPrev");
  if (!cv) return;
  const cols = rd.cols,
    vis = rd.vis;
  const cs = Math.max(
    2,
    Math.min(
      18,
      Math.floor(
        Math.min((innerWidth * 0.8) / cols, 320 / cols, Math.min(460, innerHeight * 0.55) / vis),
      ),
    ),
  );
  cv.width = cols * cs;
  cv.height = vis * cs;
  cv.style.width = cols * cs + "px";
  cv.style.height = vis * cs + "px";
  const c = cv.getContext("2d");
  c.fillStyle = "#05070c";
  c.fillRect(0, 0, cv.width, cv.height);
  c.strokeStyle = "rgba(255,255,255,.07)";
  c.lineWidth = 1;
  c.beginPath();
  for (let i = 1; i < cols; i++) {
    c.moveTo(i * cs + 0.5, 0);
    c.lineTo(i * cs + 0.5, vis * cs);
  }
  for (let j = 1; j < vis; j++) {
    c.moveTo(0, j * cs + 0.5);
    c.lineTo(cols * cs, j * cs + 0.5);
  }
  c.stroke();
  drawStyledGrid(c, rd.grid, cols, vis, cs, 0, 0);
  const info = $("capPrevInfo");
  if (info)
    info.textContent =
      rd.blocks +
      " blocks · " +
      cols +
      "×" +
      vis +
      " board · cell ≈ " +
      Math.round(o.an.S / o.an.scale) +
      " px" +
      (rd.note ? " · " + rd.note.trim() : "");
  const a = $("capPcV"),
    b = $("capPrV");
  if (a) a.textContent = cols;
  if (b) b.textContent = vis;
  const ub = $("capTUndo"),
    rb = $("capTRedo");
  if (ub) ub.disabled = !(o.hist && o.hist.length);
  if (rb) rb.disabled = !(o.redo && o.redo.length);
}

function capClone(r) {
  return Object.assign({}, r, { grid: r.grid.map((x) => x.slice()) });
}

function capSnap() {
  const o = captureState.capDet;
  return {
    c: o.lc || 0,
    r: o.lr || 0,
    s: o.ls || 0,
    res: capClone(o.res),
    ops: (o.ops || []).slice(),
  };
}

function capApplyOps(o) {
  const r = o.res;
  if (!r || !r.grid) return;
  for (const p of o.ops || []) {
    if (p.t === "m") r.grid.forEach((row) => row.reverse());
    else if (r.grid[p.y] && p.x < r.grid[p.y].length) r.grid[p.y][p.x] = p.v;
  }
  r.blocks = r.grid.reduce((n, row) => n + row.filter(Boolean).length, 0);
}

export function capPush() {
  const o = captureState.capDet;
  if (!o || !o.res) return;
  (o.hist = o.hist || []).push(capSnap());
  if (o.hist.length > 100) o.hist.shift();
  o.redo = [];
}

function capRestore(e) {
  const o = captureState.capDet;
  o.cols = o.lc = e.c;
  o.rows = o.lr = e.r;
  o.shift = o.ls = e.s;
  o.res = e.res;
  o.ops = e.ops || [];
  capPrevShow(true);
  capPrevDraw();
}

export function capUndo() {
  const o = captureState.capDet;
  if (!o || !o.res || !o.hist || !o.hist.length) return;
  (o.redo = o.redo || []).push(capSnap());
  capRestore(o.hist.pop());
}

export function capRedo() {
  const o = captureState.capDet;
  if (!o || !o.res || !o.redo || !o.redo.length) return;
  (o.hist = o.hist || []).push(capSnap());
  capRestore(o.redo.pop());
}

export function capPrevRun() {
  const o = captureState.capDet;
  if (!o) return;
  if (o.res) capPush();
  o.res = capReadBoard(o.an, { cols: o.cols, rows: o.rows, shift: o.shift });
  capApplyOps(o);
  o.lc = o.cols;
  o.lr = o.rows;
  o.ls = o.shift;
  capPrevShow(true);
  capPrevDraw();
}

export function capApply() {
  if (captureState.capMode !== "select" || !captureState.capSrc) {
    capNote("Load or capture an image first.", true);
    return;
  }
  if (!captureState.capRect || captureState.capRect.w < 8 || captureState.capRect.h < 8) {
    capNote(
      "Drag on the image to select an area first — the whole screenshot, just the board, or only the stack all work.",
      true,
    );
    return;
  }
  let an = null;
  try {
    an = capAnalyze(captureState.capSrc, captureState.capRect);
  } catch (_) {
    an = null;
  }
  if (!an) {
    capNote(
      "Could not find any blocks to read in that area. Try a bigger area that includes some coloured blocks.",
      true,
    );
    return;
  }
  captureState.capDet = {
    an: an,
    cols: 0,
    rows: 0,
    shift: 0,
    res: null,
    hist: [],
    redo: [],
    lc: 0,
    lr: 0,
    ls: 0,
    ops: [],
  };
  capNote("");
  boardLibraryState.bvSeq = { q: [], rem: [], h: -1 };
  boardLibraryState.bvqTgt = "q";
  capPrevRun();
  bvqRender();
}

export function capPrevSave() {
  const o = captureState.capDet;
  if (!o || !o.res) return;
  const rd = o.res;
  if (!rd.blocks) {
    capNote("No blocks found — nothing to save.", true);
    return;
  }
  addBoardEntry(rd.grid, rd.cols, rd.vis, true);
  const ent = selectedBoard();
  if (ent) {
    ent.note = "Captured from an image.";
    bvqCommit(ent);
  }
  savePractice();
  renderBoardList();
  const n = rd.blocks;
  captureState.capDet = null;
  capPrevShow(false);
  capNote("Board saved ✓ (" + n + " blocks) — it is selected in Saved Boards below.");
}
