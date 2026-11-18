// @ts-nocheck
import { game } from "../game/state";
import { SFX, voice } from "../engine/engine";
import { $, applyGeometry, layout, layoutState } from "../ui/layout";
import { layoutMp } from "../versus/rounds";

SFX.send = () => {
  voice(200, 0.14, "sawtooth", 0.028, {
    slide: 620,
    filter: 2600,
    attack: 0.004,
    noise: true,
    noiseF: 3400,
    noiseVol: 0.22,
    noiseDur: 0.11,
  });
};

SFX.recv = () => {
  voice(82, 0.18, "sine", 0.05, {
    slide: 40,
    filter: 480,
    noise: true,
    noiseF: 760,
    noiseVol: 0.5,
    noiseDur: 0.14,
  });
};

SFX.roundWin = () => {
  [523, 659, 784, 1046, 1318].forEach((f, i) =>
    voice(f, 0.2, "triangle", 0.026, { filter: 4200, rich: true, t0: i * 0.07 }),
  );
};

SFX.roundLose = () => {
  [392, 311, 262, 196].forEach((f, i) =>
    voice(f, 0.26, "sine", 0.03, { filter: 2000, t0: i * 0.11 }),
  );
};

layoutState.wrap = $("wrap");
layoutState.bcv = $("board");
layoutState.g = layoutState.bcv.getContext("2d");

layoutState.holdCv = $("holdCv");
layoutState.nextCvs = [0, 1, 2, 3, 4].map((i) => $("nextCv" + i));

layoutState.nextItems = [...document.querySelectorAll(".col-right .nextItem")];

layoutState.elScore = $("score");
layoutState.elLevel = $("level");
layoutState.elLines = $("lines");
layoutState.elTime = $("stTime");
layoutState.elPieces = $("stPieces");
layoutState.elPps = $("stPps");

layoutState.pScoreH3 = $("pScoreH3");
layoutState.lvlK = $("lvlK");
layoutState.lnK = $("lnK");

layoutState.comboChip = $("comboChip");
layoutState.b2bChip = $("b2bChip");
layoutState.actionLine = $("actionLine");
layoutState.bannerEl = $("banner");

layoutState.headerEl = document.querySelector("header");
layoutState.mainEl = document.querySelector("main");

layoutState.colL = document.querySelector(".col-left");
layoutState.colR = document.querySelector(".col-right");

layoutState.restartHoldEl = $("restartHold");
layoutState.restartHoldBar = layoutState.restartHoldEl
  ? layoutState.restartHoldEl.querySelector("i")
  : null;

if (window.ResizeObserver) {
  new ResizeObserver(layout).observe(layoutState.wrap);
}

window.addEventListener("resize", () => {
  if (layoutState._resizeRaf) cancelAnimationFrame(layoutState._resizeRaf);
  layoutState._resizeRaf = requestAnimationFrame(() => {
    layoutState._resizeRaf = null;
    applyGeometry();
    layout();
    layoutMp(game.MINI);
  });
});

document.body.addEventListener("transitionend", (e) => {
  if (e.target === document.body && e.propertyName === "--hu") layout();
});
