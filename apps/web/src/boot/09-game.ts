// @ts-nocheck
import { log } from "../core/logger";
import { bindingsState } from "../input/bindings";
import { game } from "../game/state";
import { togglePause } from "../game/game";
import { cfIsOpen } from "../ui/settings";
import { onlineSessionState } from "../net/online-session";

window.addEventListener(
  "keydown",
  function (e) {
    try {
      if (e.key !== "Escape" && e.code !== "Escape") return;
      if (bindingsState.listening || game.editMode || cfIsOpen()) return;
      const _onlineOrSpec =
        (onlineSessionState.isOnlineGame !== undefined && onlineSessionState.isOnlineGame) ||
        (onlineSessionState.isSpectator !== undefined && onlineSessionState.isSpectator);
      if (!_onlineOrSpec) return;
      if (
        game.state === "playing" ||
        game.state === "countdown" ||
        game.state === "vsround" ||
        game.state === "paused"
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        togglePause();
      }
    } catch (_) {
      log.debug("boot/09-game", _);
    }
  },
  true,
);
