// @ts-nocheck
import { PIECES } from "@tetrizz/core";
import { configState } from "../core/config";
import { invalidateCellCache } from "./render";

export const themeState = {
  COL: undefined,
  cvTheme: undefined,
};

function hx(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

export function shade(h, t) {
  const [r, g, b] = hx(h);
  const m = t > 0 ? 255 : 0,
    k = Math.abs(t);
  return `rgb(${Math.round(r + (m - r) * k)},${Math.round(g + (m - g) * k)},${Math.round(b + (m - b) * k)})`;
}

export function rgba(h, a) {
  const [r, g, b] = hx(h);
  return `rgba(${r},${g},${b},${a})`;
}

const COLOR_PALETTES = {
  classic: {
    pieces: ["#2a93a8", "#4257b8", "#c26a32", "#b89a2e", "#2f9468", "#7a52bd", "#c23a55"],
    garbage: "#707a88",
  },
  neon: {
    pieces: ["#00e5ff", "#2979ff", "#ff9100", "#ffea00", "#00e676", "#d500f9", "#ff1744"],
    garbage: "#455a64",
  },
  pastel: {
    pieces: ["#7fd8e6", "#8ea8f0", "#f0b58a", "#ecd98a", "#8fe6b4", "#c4a8ec", "#f094a8"],
    garbage: "#b0b8c4",
  },
  mono: {
    pieces: ["#e8eef8", "#c6d2e6", "#a3b5d4", "#7f98c2", "#5f7cae", "#435f94", "#2b4470"],
    garbage: "#707a88",
  },
  lcd: {
    pieces: ["#9bbc0f", "#8bac0f", "#306230", "#0f380f", "#4b6b2a", "#6b8f23", "#aebf3a"],
    garbage: "#5f6f52",
  },
};

export const COLOR_THEMES = Object.keys(COLOR_PALETTES);

export function applyColorTheme(name) {
  if (!COLOR_PALETTES[name]) name = "classic";
  configState.colorTheme = name;
  const pal = COLOR_PALETTES[name];
  PIECES.forEach((p, i) => {
    p.c = pal.pieces[i];
  });
  for (let i = 0; i < 7; i++) {
    themeState.COL[i].base = pal.pieces[i];
    themeState.COL[i].hi = shade(pal.pieces[i], 0.42);
    themeState.COL[i].lo = shade(pal.pieces[i], -0.34);
  }
  themeState.COL[7].base = pal.garbage;
  themeState.COL[7].hi = shade(pal.garbage, 0.42);
  themeState.COL[7].lo = shade(pal.garbage, -0.34);
  invalidateCellCache();
}

export const CANVAS_THEMES = {
  dark: {
    well: "#030508",
    gridRGB: "148,170,210",
    gridA: 0.055,
    border: "rgba(148,170,210,.5)",
    ghost: "#9aa6bd",
  },
  light: {
    well: "#ffffff",
    gridRGB: "25,45,90",
    gridA: 0.09,
    border: "rgba(25,45,90,.6)",
    ghost: "#66758f",
  },
};

themeState.cvTheme = CANVAS_THEMES.dark;
