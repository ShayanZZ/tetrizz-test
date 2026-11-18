/**
 * Entry point of the bot worker. It answers each planning request with the same planner code the
 * main thread uses, so a bot plays the same whichever side thinks for it.
 */
import { handlePlanRequest, type PlanRequest } from "@tetrizz/bot";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PlanRequest>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (event) => {
  scope.postMessage(handlePlanRequest(event.data));
};
