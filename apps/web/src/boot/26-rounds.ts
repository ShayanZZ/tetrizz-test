// @ts-nocheck
import { showEndStatsFor } from "../versus/rounds";

document.addEventListener("click", function (e) {
  const v = e.target && e.target.closest ? e.target.closest("#vsFinal .vfr") : null;
  if (!v) return;
  const slot = parseInt(v.dataset.slot, 10);
  if (!isNaN(slot)) showEndStatsFor(slot);
});
