// @ts-nocheck
import { setDVH } from "../core/config";
import { layoutSoon } from "../ui/layout";
import { log, setLogLevel } from "../core/logger";
import { runStorageMigrations, storage } from "../core/storage";

runStorageMigrations();
try {
  setLogLevel(storage.get("tetris_loglevel"));
} catch (error) {
  log.debug("boot.logLevel", error);
}

setDVH();

addEventListener("resize", setDVH);

addEventListener("orientationchange", setDVH);

addEventListener("pageshow", function () {
  setDVH();
  layoutSoon(80);
  layoutSoon(400);
});
