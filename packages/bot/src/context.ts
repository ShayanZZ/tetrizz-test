/**
 * The few inputs the bot evaluators need from the surrounding game: the board size, the versus
 * sub-mode (it scales the evaluation weights) and a source of random numbers for evaluation noise
 * and deliberate mistakes. Keeping them here lets the evaluators run unchanged on the main thread
 * and inside a worker, where the game state does not exist.
 */
export interface BotContext {
  /** Board columns. */
  cols: number;
  /** Board rows including the hidden rows above the visible field. */
  rows: number;
  /** Versus sub-mode id (`battle`, `ultra`, `sprint`, `endless`, `wide`). */
  submode: string;
  /** Random number source in [0, 1). The default reads `Math.random` at call time. */
  random: () => number;
}

export const botContext: BotContext = {
  cols: 10,
  rows: 23,
  submode: "battle",
  random: () => Math.random(),
};

/** Replaces the given fields of the shared context; omitted fields keep their value. */
export function setBotContext(next: Partial<BotContext>): void {
  Object.assign(botContext, next);
}

/** The part of the context that describes the match and travels with every planning request. */
export interface PlanContext {
  cols: number;
  rows: number;
  submode: string;
}
