// @ts-nocheck
import { fireDown, fireUp } from "../ui/controls";

const wheelTimers = {};

export function wheelPulse(act) {
  fireDown(act);
  clearTimeout(wheelTimers[act]);
  wheelTimers[act] = setTimeout(() => fireUp(act), 140);
}
