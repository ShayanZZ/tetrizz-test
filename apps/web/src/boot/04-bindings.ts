// @ts-nocheck
import { MOBILE, VS } from "../core/config";
import { ACTIONS, ACTION_MAP, bindingsState } from "../input/bindings";

ACTIONS.forEach((a) => {
  ACTION_MAP[a.id] = a;
});

bindingsState.menuView = "main";
bindingsState.ctrlDev = MOBILE.matches ? "touch" : "key";
bindingsState.openOverlayEl = null;

bindingsState.KEYNAME = {
  ArrowLeft: "◀" + VS,
  ArrowRight: "▶" + VS,
  ArrowUp: "▲" + VS,
  ArrowDown: "▼" + VS,
  Space: "SPACE",
  Enter: "ENTER",
  Escape: "ESC",
  ShiftLeft: "L‑SHIFT",
  ShiftRight: "R‑SHIFT",
  ControlLeft: "L‑CTRL",
  ControlRight: "R‑CTRL",
  AltLeft: "L‑ALT",
  AltRight: "R‑ALT",
  Tab: "TAB",
  Backspace: "BACK",
};

bindingsState.PADBTN = {
  0: "GP A",
  1: "GP B",
  2: "GP X",
  3: "GP Y",
  4: "GP LB",
  5: "GP RB",
  6: "GP LT",
  7: "GP RT",
  8: "GP BACK",
  9: "GP START",
  10: "GP LS",
  11: "GP RS",
  12: "GP ▲" + VS,
  13: "GP ▼" + VS,
  14: "GP ◀" + VS,
  15: "GP ▶" + VS,
};
