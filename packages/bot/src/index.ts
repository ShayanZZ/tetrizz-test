/** Bot decision-making. It may import only `@tetrizz/core`. */
export { botContext, setBotContext } from "./context";
export type { BotContext, PlanContext } from "./context";
export { MODE_MOD } from "./mode-mod";
export { clamp } from "./math";
export { MAX_PACE_CARRY_MS, paceCarry, paceDeadline } from "./pacing";
export { CC2W, cc2Board, cc2Eval, cc2H, cc2SearchGen, cc2Sim, cc2ToGame } from "./ten-wide";
export { wBoard, wDanger, wEval, wMakeWeights, wSearchGen, wSim } from "./four-wide";
export { botPlanPureGen, botPlanPureWideGen, rotSteps } from "./planner";
export { createPlanGen, handlePlanRequest } from "./service";
export type {
  PlanConfig,
  PlanKind,
  PlanMove,
  PlanRequest,
  PlanResponse,
  PlanResult,
} from "./service";
