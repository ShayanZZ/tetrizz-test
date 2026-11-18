/**
 * How a bot keeps to the pieces-per-second it was asked for.
 *
 * A bot drops its piece on the first frame at or after the piece's deadline. A frame is 16.7 ms
 * long at 60 Hz, so every drop lands up to one frame late; if the next deadline is measured from
 * that late drop, the lateness adds up piece after piece (a 100 ms budget came out as 112 ms on
 * 16 ms frames, 8.8 PPS instead of 10). Carrying the lateness into the next deadline keeps the
 * deadlines on a fixed schedule, so the long-run rate equals the setting whatever the frame rate.
 * Which move the bot plays is not affected, only when the piece is dropped.
 */

/** Most lateness handed on to the next piece, so one long stall can never make a burst of drops. */
export const MAX_PACE_CARRY_MS = 60;

/** Lateness of a drop at `now` against its `deadline`, limited to what may be carried over. */
export function paceCarry(now: number, deadline: number): number {
  const late = now - deadline;
  if (!(late > 0)) return 0;
  return late < MAX_PACE_CARRY_MS ? late : MAX_PACE_CARRY_MS;
}

/** Deadline for a piece that starts at `now` with `budgetMs` to spend and `carryMs` already used. */
export function paceDeadline(now: number, budgetMs: number, carryMs: number): number {
  return now + budgetMs - carryMs;
}
