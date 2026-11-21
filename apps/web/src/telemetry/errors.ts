/**
 * Describes a script error for telemetry without sending anything that could identify a person:
 * a short message with long tokens (ids, keys, room codes) blanked out, the error's name, the
 * place in the code it came from (file name and line, no path) and a hash of the top of the
 * stack so equal errors can be counted together.
 */
import type { TelemetryClient } from "./client";

export interface ErrorDescription {
  name: string;
  message: string;
  /** For example `game.ts:412`; empty when the stack says nothing usable. */
  where: string;
  hash: string;
}

const MAX_MESSAGE = 120;
const TOP_FRAMES = 3;
const LONG_TOKEN = /[A-Za-z0-9_-]{16,}/g;
const FRAME_AT = /([^\s()/\\]+\.(?:ts|js|mjs|html)):(\d+)(?::\d+)?/;

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function describeError(error: unknown, fallbackMessage = ""): ErrorDescription {
  let name = "Error";
  let message = fallbackMessage;
  let stack = "";
  if (error instanceof Error) {
    name = error.name || "Error";
    message = error.message;
    stack = error.stack ?? "";
  } else if (typeof error === "string") {
    message = error;
  } else if (error !== null && typeof error === "object") {
    const shaped = error as { name?: unknown; message?: unknown; stack?: unknown };
    if (typeof shaped.name === "string") name = shaped.name;
    if (typeof shaped.message === "string") message = shaped.message;
    if (typeof shaped.stack === "string") stack = shaped.stack;
  }
  const frames = stack
    .split("\n")
    .map((line) => FRAME_AT.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .slice(0, TOP_FRAMES)
    .map((match) => `${match[1]}:${match[2]}`);
  const where = frames[0] ?? "";
  const cleanName = name.replace(/[^A-Za-z0-9_.]/g, "").slice(0, 40) || "Error";
  const cleanMessage = message.replace(LONG_TOKEN, "…").replace(/\s+/g, " ").trim();
  return {
    name: cleanName,
    message: cleanMessage.slice(0, MAX_MESSAGE),
    where,
    hash: fnv1a(`${cleanName}|${frames.join("|")}|${frames.length === 0 ? cleanMessage : ""}`),
  };
}

export interface ErrorReporter {
  report(error: unknown, fallbackMessage?: string): boolean;
}

/** At most `limit` errors per page load, and each distinct error (by hash) only once. */
export function createErrorReporter(
  sink: Pick<TelemetryClient, "record">,
  limit = 5,
): ErrorReporter {
  const seen = new Set<string>();
  return {
    report(error, fallbackMessage) {
      if (seen.size >= limit) return false;
      const described = describeError(error, fallbackMessage);
      if (seen.has(described.hash)) return false;
      seen.add(described.hash);
      sink.record("js_error", described);
      return true;
    },
  };
}
