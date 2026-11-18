import { botPlanPureGen, botPlanPureWideGen } from "./planner";
import { setBotContext, type PlanContext } from "./context";

/** Which evaluator plans the move: the 10-wide one or the 4-wide one. */
export type PlanKind = "ten" | "wide";

/** The move the bot decided on for the current piece. */
export interface PlanMove {
  /** `S` plans a spin that needs a final rotation, `N` a plain placement. */
  kind: "S" | "N";
  targetRot: number;
  targetX: number;
  fy: number;
  spin: { mini: boolean } | null;
  spinKind: number | null;
  fromRot?: number;
  preX?: number;
}

/** What a planner returns: the move, plus any hold the bot must use first. */
export interface PlanResult {
  /** Set when no legal placement exists. */
  empty?: boolean;
  plan?: PlanMove;
  /** Rotations to apply right after the piece appears. */
  topActions?: string[];
  holdAction: { bank: number; pull: number } | null;
  /** The piece type the plan is for (after the hold, if one is used). */
  finalType: number;
}

/**
 * Everything a planner reads: the encoded board, the falling piece, the next pieces, the held
 * piece, the chain state and the bot's skill. Plain data, so it can be sent to a worker.
 */
export interface PlanConfig {
  c: number[];
  type: number;
  queue: number[];
  hold: number | null;
  holdUsed: boolean;
  holdAge: number;
  skill: Record<string, number>;
  b2b: number;
  combo: number;
  diff: number;
}

/** A planning request as sent to a worker. */
export interface PlanRequest {
  id: number;
  kind: PlanKind;
  cfg: PlanConfig;
  ctx: PlanContext;
}

/** A worker's answer: the plan, or the message of the error that stopped it. */
export type PlanResponse =
  { id: number; ok: true; res: PlanResult } | { id: number; ok: false; error: string };

/** Creates the cooperative planner for a request; each `next()` is one slice of search work. */
export function createPlanGen(kind: PlanKind, cfg: PlanConfig): Generator<unknown, PlanResult> {
  const gen = kind === "wide" ? botPlanPureWideGen(cfg) : botPlanPureGen(cfg);
  return gen as unknown as Generator<unknown, PlanResult>;
}

/** Runs a request to the end and returns its plan; used by workers and by tests. */
export function handlePlanRequest(req: PlanRequest): PlanResponse {
  try {
    setBotContext(req.ctx);
    const gen = createPlanGen(req.kind, req.cfg);
    for (;;) {
      const step = gen.next();
      if (step.done) return { id: req.id, ok: true, res: step.value };
    }
  } catch (error) {
    return { id: req.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
