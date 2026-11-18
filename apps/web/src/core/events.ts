import { log } from "./logger";

/** Notifications: emitted after something happened. */
export interface EventMap {
  tick: number;
  refreshVs: undefined;
  vsStartMatch: undefined;
  vsBeginRound: undefined;
  vsRoundEnd: number;
  vsMatchEnd: number;
  startCountdown: undefined;
  gameOver: undefined;
  resetGame: undefined;
  syncVsPlay: undefined;
  fxKick: { dx: number; dy: number; dr: number };
  fxSpin: { dir: number };
  stFxKick: { i: number; dx: number; dy: number; dr: number };
  stFxSpin: { i: number; dir: number };
  showAction: { title: string; sub: string; cls: string; color: string };
  showStAction: { i: number; title: string; sub: string; cls: string; color: string };
  banner: { txt: string; color: string; cls: string };
  stBanner: { i: number; txt: string; color: string; cls: string };
}

/** Emitted just before the action runs; handlers receive the action's arguments. */
export interface BeforeEventMap {
  startCountdown: [];
  gameOver: [];
  vsStartMatch: [];
  vsBeginRound: [];
  vsRoundEnd: [winnerSlot: number];
}

/** Handlers can veto an action by returning true. */
export interface InterceptMap {
  tick: [timestamp: number];
  sendAttack: [from: number, amount: number];
  togglePause: [];
}

type Args<T> = T extends undefined ? [] : [payload: T];
type Handler = (...args: never[]) => unknown;

class Registry<M extends object> {
  private readonly handlers = new Map<keyof M, Handler[]>();

  add<K extends keyof M>(name: K, fn: Handler): () => void {
    const list = this.handlers.get(name) ?? [];
    list.push(fn);
    this.handlers.set(name, list);
    return () => {
      const current = this.handlers.get(name);
      const index = current ? current.indexOf(fn) : -1;
      if (current && index >= 0) current.splice(index, 1);
    };
  }

  /** Calls handlers in registration order. A throwing handler is logged and skipped. */
  run<K extends keyof M>(name: K, args: readonly unknown[], stopOnTrue: boolean): boolean {
    const list = this.handlers.get(name);
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      try {
        if ((list[i] as (...a: unknown[]) => unknown)(...args) && stopOnTrue) return true;
      } catch (error) {
        log.debug(`events.${String(name)}`, error);
      }
    }
    return false;
  }
}

const events = new Registry<EventMap>();
const beforeEvents = new Registry<BeforeEventMap>();
const intercepts = new Registry<InterceptMap>();

export function onEvent<K extends keyof EventMap>(
  name: K,
  fn: (payload: EventMap[K]) => void,
): () => void {
  return events.add(name, fn as Handler);
}

export function emitEvent<K extends keyof EventMap>(name: K, ...payload: Args<EventMap[K]>): void {
  events.run(name, payload, false);
}

export function onBefore<K extends keyof BeforeEventMap>(
  name: K,
  fn: (...args: BeforeEventMap[K]) => void,
): () => void {
  return beforeEvents.add(name, fn as Handler);
}

export function emitBefore<K extends keyof BeforeEventMap>(
  name: K,
  ...args: BeforeEventMap[K]
): void {
  beforeEvents.run(name, args, false);
}

export function intercept<K extends keyof InterceptMap>(
  name: K,
  fn: (...args: InterceptMap[K]) => boolean | void,
): () => void {
  return intercepts.add(name, fn as Handler);
}

/** True when any handler vetoed the action. */
export function isIntercepted<K extends keyof InterceptMap>(
  name: K,
  ...args: InterceptMap[K]
): boolean {
  return intercepts.run(name, args, true);
}
