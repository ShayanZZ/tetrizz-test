// @ts-nocheck
import { isReducedMotion } from "../core/config";

export const brandState = {
  _bfWait: false,
  _bfState: 0,
};

const BRAND = {
  z: "#DF2020",
  bg1: "#2A5AA0",
  bg2: "#152E57",
  block: { bevel: 0.5, gloss: 0.1, glossColor: "#FFFFFF", gap: 0.05, radius: 0.15 },
  shadow: { color: "#000000", opacity: 60, blur: 40, ox: -20, oy: 20 },
  logo: {
    text: {
      content: "Tetri",
      family: "Rubik Mono One",
      weight: "400",
      color: "#2D309A",
      size: 30,
      ls: 1,
      vscale: 177,
      lh: 118,
      rot: 0,
      x: 37,
      y: 52,
    },
    z1: { x: 81, y: 53, size: 13, rot: 0 },
    z2: { x: 88, y: 36, size: 8, rot: 0 },
  },
};

const BRAND_CELLS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [2, 1],
];

const BRAND_INK = {
  dark: {
    top: "#3B46BE",
    mid: "#2D309A",
    bot: "#20267A",
    hi: "#333EB0",
    lo: "#171D68",
    tex: "#141B5C",
    glow: "rgba(70,85,220,.22)",
    sheen: "rgba(190,205,255,.045)",
  },
  light: {
    top: "#3B43BC",
    mid: "#2D309A",
    bot: "#222780",
    hi: "#3940B0",
    lo: "#1C2070",
    tex: "#101450",
    glow: "rgba(45,48,154,.18)",
    sheen: "rgba(255,255,255,.07)",
  },
};

const brandTheme = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

function bzShade(hex, t) {
  const r = parseInt(hex.slice(1, 3), 16),
    g = parseInt(hex.slice(3, 5), 16),
    b = parseInt(hex.slice(5, 7), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(t < 0 ? c * (1 + t) : c + (255 - c) * t)));
  return "rgb(" + f(r) + "," + f(g) + "," + f(b) + ")";
}

function bzRGBA(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16),
    g = parseInt(hex.slice(3, 5), 16),
    b = parseInt(hex.slice(5, 7), 16);
  return "rgba(" + r + "," + g + "," + b + "," + a + ")";
}

function bzRR(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function miniSVG(id, withBg) {
  const B = BRAND,
    sh = B.shadow,
    bev = B.block.bevel * 0.35,
    gl = B.block.gloss * 0.55;
  const vb = withBg ? "0 0 64 64" : "9.16 12.17 44.8 37.9";
  const P1 = withBg ? { x: 47, y: 58, s: 22 } : { x: 45.55, y: 57.5, s: 21 };
  const P2 = withBg ? { x: 69, y: 30, s: 11 } : { x: 68.55, y: 29.5, s: 10.5 };
  const rectsFor = (p) => {
    const cell = (64 * p.s) / 100,
      gap = cell * B.block.gap,
      rx = cell * B.block.radius,
      W = 3 * cell,
      H = 2 * cell,
      tx = (64 * p.x) / 100 - W / 2,
      ty = (64 * p.y) / 100 - H / 2;
    return BRAND_CELLS.map((q) => [
      tx + q[0] * cell + gap / 2,
      ty + q[1] * cell + gap / 2,
      cell - gap,
      rx,
    ]);
  };
  const r1 = rectsFor(P1),
    r2 = rectsFor(P2);
  const c1 = (64 * P1.s) / 100,
    c2 = (64 * P2.s) / 100;
  const rect = (r, f) =>
    '<rect x="' +
    r[0].toFixed(2) +
    '" y="' +
    r[1].toFixed(2) +
    '" width="' +
    r[2].toFixed(2) +
    '" height="' +
    r[2].toFixed(2) +
    '" rx="' +
    r[3].toFixed(2) +
    '" fill="' +
    f +
    '"/>';
  const grp = (a) => a.map((r) => rect(r, "url(#" + id + "p)")).join("");
  let s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb + '"><defs>';
  if (withBg)
    s +=
      '<radialGradient id="' +
      id +
      'b" cx="50%" cy="50%" r="78%"><stop offset="0%" stop-color="' +
      B.bg1 +
      '"/><stop offset="100%" stop-color="' +
      B.bg2 +
      '"/></radialGradient>';
  s +=
    '<linearGradient id="' +
    id +
    'p" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' +
    bzShade(B.z, bev) +
    '"/><stop offset="50%" stop-color="' +
    B.z +
    '"/><stop offset="100%" stop-color="' +
    bzShade(B.z, -bev) +
    '"/></linearGradient>';
  if (gl > 0)
    s +=
      '<linearGradient id="' +
      id +
      'l" x1="0" y1="0" x2="0" y2="0.5"><stop offset="0%" stop-color="' +
      B.block.glossColor +
      '" stop-opacity="' +
      gl +
      '"/><stop offset="100%" stop-color="' +
      B.block.glossColor +
      '" stop-opacity="0"/></linearGradient>';
  if (withBg) {
    s +=
      '<filter id="' +
      id +
      's1" x="-60%" y="-60%" width="220%" height="220%"><feDropShadow dx="' +
      ((c1 * sh.ox) / 100).toFixed(2) +
      '" dy="' +
      ((c1 * sh.oy) / 100).toFixed(2) +
      '" stdDeviation="' +
      ((c1 * sh.blur) / 200).toFixed(2) +
      '" flood-color="' +
      sh.color +
      '" flood-opacity="' +
      sh.opacity / 100 +
      '"/></filter>';
    s +=
      '<filter id="' +
      id +
      's2" x="-60%" y="-60%" width="220%" height="220%"><feDropShadow dx="' +
      ((c2 * sh.ox) / 100).toFixed(2) +
      '" dy="' +
      ((c2 * sh.oy) / 100).toFixed(2) +
      '" stdDeviation="' +
      ((c2 * sh.blur) / 200).toFixed(2) +
      '" flood-color="' +
      sh.color +
      '" flood-opacity="' +
      sh.opacity / 100 +
      '"/></filter>';
  }
  s += "</defs>";
  if (withBg) s += '<rect width="64" height="64" rx="12" fill="url(#' + id + 'b)"/>';
  if (withBg) {
    s +=
      '<g filter="url(#' +
      id +
      's1)">' +
      grp(r1) +
      '</g><g filter="url(#' +
      id +
      's2)">' +
      grp(r2) +
      "</g>";
  } else {
    s += "<g>" + grp(r1) + "</g><g>" + grp(r2) + "</g>";
  }
  if (gl > 0)
    s +=
      "<g>" +
      r1.map((r) => rect(r, "url(#" + id + "l)")).join("") +
      r2.map((r) => rect(r, "url(#" + id + "l)")).join("") +
      "</g>";
  s += "</svg>";
  return s;
}

function drawLogoPiece(c, W, H, z) {
  const B = BRAND,
    sh = B.shadow,
    blk = B.block,
    bev = blk.bevel * 0.35,
    gl = blk.gloss * 0.55;
  const cell = (z.size / 100) * H,
    gap = cell * blk.gap,
    rad = cell * blk.radius,
    PW = 3 * cell,
    PH = 2 * cell;
  c.save();
  c.translate((z.x / 100) * W, (z.y / 100) * H);
  c.rotate(((z.rot || 0) * Math.PI) / 180);
  c.translate(-PW / 2, -PH / 2);
  const rs = BRAND_CELLS.map((q) => [
    q[0] * cell + gap / 2,
    q[1] * cell + gap / 2,
    cell - gap,
    cell - gap,
    rad,
  ]);
  c.save();
  c.shadowColor = bzRGBA(sh.color, sh.opacity / 100);
  c.shadowBlur = (cell * sh.blur) / 100;
  c.shadowOffsetX = (cell * sh.ox) / 100;
  c.shadowOffsetY = (cell * sh.oy) / 100;
  c.fillStyle = "#000";
  rs.forEach((r) => {
    bzRR(c, r[0], r[1], r[2], r[3], r[4]);
    c.fill();
  });
  c.restore();
  rs.forEach((r) => {
    const g = c.createLinearGradient(r[0], r[1], r[0], r[1] + r[3]);
    g.addColorStop(0, bzShade(B.z, bev));
    g.addColorStop(0.5, B.z);
    g.addColorStop(1, bzShade(B.z, -bev));
    c.fillStyle = g;
    bzRR(c, r[0], r[1], r[2], r[3], r[4]);
    c.fill();
    if (gl > 0) {
      c.save();
      bzRR(c, r[0], r[1], r[2], r[3], r[4]);
      c.clip();
      const hg = c.createLinearGradient(r[0], r[1], r[0], r[1] + r[3] * 0.5);
      hg.addColorStop(0, bzRGBA(blk.glossColor, gl));
      hg.addColorStop(1, bzRGBA(blk.glossColor, 0));
      c.fillStyle = hg;
      c.fillRect(r[0], r[1], r[2], r[3]);
      c.restore();
    }
  });
  c.restore();
}

function drawBrandGlyphs(o, W, H, t, ink) {
  const sizePx = (t.size / 100) * H,
    lsPx = ((t.ls || 0) / 512) * H;
  o.save();
  o.translate((t.x / 100) * W, (t.y / 100) * H);
  o.rotate(((t.rot || 0) * Math.PI) / 180);
  o.scale(1, (t.vscale || 100) / 100);
  o.font = (t.weight || "400") + " " + sizePx + 'px "' + t.family + '", sans-serif';
  o.textBaseline = "middle";
  o.textAlign = "left";
  o.lineJoin = "round";
  const chars = Array.from(t.content),
    ws = chars.map((ch) => o.measureText(ch).width);
  const total = ws.reduce((a, b) => a + b, 0) + lsPx * (chars.length - 1);
  let cx = -total / 2;
  const pos = chars.map((ch, i) => {
    const p = [ch, cx];
    cx += ws[i] + lsPx;
    return p;
  });
  const paint = (f) => {
    o.fillStyle = f;
    pos.forEach((p) => o.fillText(p[0], p[1], 0));
  };
  const g = o.createLinearGradient(0, -sizePx * 0.55, 0, sizePx * 0.55);
  g.addColorStop(0, ink.top);
  g.addColorStop(0.5, ink.mid);
  g.addColorStop(1, ink.bot);
  paint(g);
  o.save();
  o.globalCompositeOperation = "source-atop";
  const sheen = o.createLinearGradient(0, -sizePx * 0.55, 0, sizePx * 0.05);
  sheen.addColorStop(0, ink.sheen);
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  o.fillStyle = sheen;
  o.fillRect(-W, -sizePx, W * 2, sizePx * 2);
  o.globalAlpha = 1;
  const strokeAt = (f, w, oy) => {
    o.strokeStyle = f;
    o.lineWidth = w;
    pos.forEach((p) => o.strokeText(p[0], p[1] + oy, 0));
  };
  strokeAt(ink.hi, Math.max(1, sizePx * 0.015), sizePx * 0.015);
  strokeAt(ink.lo, Math.max(1, sizePx * 0.02), -sizePx * 0.015);
  o.restore();
  o.restore();
}

function brandFontOk() {
  if (brandState._bfState === 1) return true;
  if (brandState._bfState === 2) return false;
  try {
    if (document.fonts && document.fonts.check('10px "' + BRAND.logo.text.family + '"')) {
      brandState._bfState = 1;
      return true;
    }
  } catch (_) {
    brandState._bfState = 1;
    return true;
  }
  return false;
}

function brandFontWhenReady() {
  if (brandState._bfWait || brandState._bfState !== 0) return;
  brandState._bfWait = true;
  const chk = () => {
    try {
      return document.fonts.check('10px "' + BRAND.logo.text.family + '"');
    } catch (_) {
      return true;
    }
  };
  const ok = () => {
    brandState._bfState = 1;
    brandState._bfWait = false;
    const c2 = document.querySelector(".m-logo-cv");
    if (c2) drawLogoCanvas(c2);
  };
  const fail = () => {
    brandState._bfState = 2;
    brandState._bfWait = false;
    const c2 = document.querySelector(".m-logo-cv");
    if (c2) {
      const x = c2.getContext("2d");
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.clearRect(0, 0, c2.width, c2.height);
    }
  };
  if (!document.fonts || !document.fonts.load) {
    fail();
    return;
  }
  document.fonts
    .load('80px "' + BRAND.logo.text.family + '"')
    .then(function (fs) {
      if ((fs && fs.length) || chk()) {
        ok();
        return;
      }
      const retry = () => {
        try {
          document.fonts
            .load('80px "' + BRAND.logo.text.family + '"')
            .then(function (fs2) {
              if ((fs2 && fs2.length) || chk()) ok();
              else fail();
            })
            .catch(fail);
        } catch (_) {
          fail();
        }
      };
      if (document.fonts.ready) document.fonts.ready.then(retry);
      else retry();
    })
    .catch(fail);
}

export function drawLogoCanvas(cv) {
  const c = cv.getContext("2d"),
    W = cv.width,
    H = cv.height;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, W, H);
  if (brandState._bfState === 2) return;
  if (!brandFontOk()) {
    brandFontWhenReady();
    return;
  }
  const ink = BRAND_INK[brandTheme()];
  const t = BRAND.logo.text;
  const O = document.createElement("canvas");
  O.width = W;
  O.height = H;
  const o = O.getContext("2d");
  drawBrandGlyphs(o, W, H, t, ink);
  const sizePx = (t.size / 100) * H;
  c.save();
  c.shadowColor = ink.glow;
  c.shadowBlur = sizePx * 0.3;
  c.drawImage(O, 0, 0);
  c.restore();
  c.save();
  c.shadowColor = bzRGBA(BRAND.shadow.color, BRAND.shadow.opacity / 100);
  c.shadowBlur = sizePx * (BRAND.shadow.blur / 100) * 0.7;
  c.shadowOffsetY = sizePx * (BRAND.shadow.oy / 100) * 0.8;
  c.drawImage(O, 0, 0);
  c.restore();
  c.drawImage(O, 0, 0);
  drawLogoPiece(c, W, H, BRAND.logo.z1);
  drawLogoPiece(c, W, H, BRAND.logo.z2);
  const _lp = cv.parentElement;
  if (_lp && !_lp.classList.contains("logo-on")) {
    _lp.classList.add("logo-on");
    if (cv.animate && !isReducedMotion())
      cv.animate(
        [
          { opacity: 0, transform: "scale(.9) translateY(6px)" },
          { opacity: 1, transform: "scale(1) translateY(0)" },
        ],
        { duration: 550, easing: "cubic-bezier(.2,.9,.3,1)" },
      );
  }
}

export function mountBrand() {
  document.querySelectorAll("header .tiles").forEach((t, i) => {
    t.innerHTML = miniSVG("tzb" + i, false);
  });
  const ip = document.querySelector(".ipop-icon");
  if (ip) ip.innerHTML = miniSVG("tzip", true);
  const host = document.querySelector('#ovStart .menu-screen[data-screen="main"] .m-title');
  if (host && !host.querySelector(".m-logo-cv")) {
    const cv = document.createElement("canvas");
    cv.className = "m-logo-cv";
    cv.width = 1024;
    cv.height = 512;
    host.innerHTML = "";
    host.appendChild(cv);
  }
  const cv = document.querySelector(".m-logo-cv");
  if (cv) drawLogoCanvas(cv);
  if (!mountBrand._obs) {
    mountBrand._obs = new MutationObserver(() => {
      const c2 = document.querySelector(".m-logo-cv");
      if (c2) drawLogoCanvas(c2);
    });
    mountBrand._obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }
}

export const PLAYER_COLORS = ["#4257b8", "#c23a55", "#2f9468", "#b89a2e"];

export { MODE_MOD } from "@tetrizz/bot";

export const VS_DEFAULTS = {
  diff: 5,
  pps: 1,
  rounds: 3,
  submode: "battle",
  target: "random",
  grav: 0.02,
  gravInc: 0.0025,
  gravMargin: 60000,
  gMult: 1,
  gMargin: 180000,
  gInc: 0.008,
  autoPps: true,
  reverse: false,
  players: [
    { type: "user", dev: "key" },
    { type: "bot", dev: "key" },
    { type: "off", dev: "key" },
    { type: "off", dev: "key" },
  ],
};
