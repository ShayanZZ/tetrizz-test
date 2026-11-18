// @ts-nocheck
import {
  TOUCH_DEFAULT_ORDER,
  loadTouchOrder,
  loadTouchPresets,
  renderTouchBars,
  touchState,
} from "../input/touch";

touchState.touchOrder = TOUCH_DEFAULT_ORDER.slice();
touchState.touchSel = null;
touchState.touchPresets = [];

loadTouchOrder();

loadTouchPresets();

renderTouchBars();
