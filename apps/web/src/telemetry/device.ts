/**
 * Coarse facts about this device for the owner's analytics. Nothing here identifies a person:
 * sizes and counts are rounded into buckets, no fonts, plugins or canvas data are read, and the
 * server adds the browser and system names it parses from the user agent itself. What the page
 * sends is only what the user agent string cannot say well: the real system version (Chromium
 * reduces the string), the device class (an iPad claims to be a Mac), screen and pixel density,
 * how the page was opened and the language.
 */
import type {
  TelemetryDevice,
  TelemetryDeviceClass,
  TelemetryDisplayMode,
} from "@tetrizz/protocol";

export interface UserAgentDataLike {
  mobile?: boolean;
  platform?: string;
  getHighEntropyValues?(hints: string[]): Promise<Record<string, unknown>>;
}

/** What `collectDevice` reads, so a test can describe any device. */
export interface DeviceEnv {
  userAgentData?: UserAgentDataLike | undefined;
  maxTouchPoints?: number | undefined;
  /** `(pointer: coarse)` matches: the main pointer is a finger. */
  coarsePointer?: boolean | undefined;
  screenWidth?: number | undefined;
  screenHeight?: number | undefined;
  devicePixelRatio?: number | undefined;
  hardwareConcurrency?: number | undefined;
  deviceMemory?: number | undefined;
  language?: string | undefined;
  /** The page runs as an installed app (`display-mode: standalone` or `navigator.standalone`). */
  standalone?: boolean | undefined;
  protocol?: string | undefined;
  /** Gives up waiting for the high-entropy values after this many milliseconds. */
  withTimeout?<T>(work: Promise<T>, ms: number): Promise<T | undefined>;
}

const CORE_BUCKETS = [1, 2, 4, 6, 8, 12, 16, 24, 32] as const;
const SCREEN_STEP = 20;
const TABLET_MIN_SHORT_SIDE = 600;
const HIGH_ENTROPY_WAIT_MS = 1500;
const PLAIN = /^[\x20-\x7e]{1,40}$/;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const plain = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return PLAIN.test(trimmed) ? trimmed : undefined;
};

export function displayModeOf(env: DeviceEnv): TelemetryDisplayMode {
  if (env.protocol === "file:") return "single-file";
  return env.standalone === true ? "pwa" : "browser";
}

export function deviceClassOf(env: DeviceEnv): TelemetryDeviceClass {
  const short = Math.min(env.screenWidth ?? 0, env.screenHeight ?? 0);
  const touch = env.coarsePointer === true || (env.maxTouchPoints ?? 0) > 1;
  if (env.userAgentData?.mobile === true) return "mobile";
  if (touch && short > 0) return short >= TABLET_MIN_SHORT_SIDE ? "tablet" : "mobile";
  if (short > 0) return "desktop";
  return "unknown";
}

/** `360x800`: the short side first, each rounded to the nearest 20, so turning the phone changes nothing. */
export function screenBucket(width: number, height: number): string | undefined {
  if (!finite(width) || !finite(height) || width < 1 || height < 1) return undefined;
  const round = (n: number) => Math.max(SCREEN_STEP, Math.round(n / SCREEN_STEP) * SCREEN_STEP);
  const [short, long] = width <= height ? [width, height] : [height, width];
  return `${round(short)}x${round(long)}`;
}

/** The largest bucket not above `cores`: 5 cores read as 4, 20 as 16. */
export function coreBucket(cores: number): number | undefined {
  if (!finite(cores) || cores < 1) return undefined;
  let bucket: number = CORE_BUCKETS[0];
  for (const candidate of CORE_BUCKETS) if (candidate <= cores) bucket = candidate;
  return bucket;
}

/** Windows reports 10.0 for both 10 and 11; a platform version from 13 up is Windows 11. */
function systemVersion(
  platform: string | undefined,
  version: string | undefined,
): string | undefined {
  if (version === undefined) return undefined;
  const [major = "", minor = "0"] = version.split(".");
  if (!/^\d+$/.test(major)) return undefined;
  if (platform === "Windows") return Number(major) >= 13 ? "11" : "10";
  if (platform === "Android" || platform === "iOS") return major;
  return /^\d+$/.test(minor) ? `${major}.${minor}` : major;
}

async function highEntropy(env: DeviceEnv): Promise<Record<string, unknown> | undefined> {
  const source = env.userAgentData;
  if (!source?.getHighEntropyValues) return undefined;
  try {
    const work = source.getHighEntropyValues(["platformVersion", "model"]);
    return env.withTimeout ? await env.withTimeout(work, HIGH_ENTROPY_WAIT_MS) : await work;
  } catch {
    return undefined;
  }
}

/** Never throws: a device with nothing readable gives an empty description. */
export async function collectDevice(env: DeviceEnv): Promise<TelemetryDevice> {
  const device: TelemetryDevice = {};
  device.deviceClass = deviceClassOf(env);
  device.displayMode = displayModeOf(env);

  if (finite(env.screenWidth) && finite(env.screenHeight)) {
    const screen = screenBucket(env.screenWidth, env.screenHeight);
    if (screen !== undefined) device.screen = screen;
  }
  if (finite(env.devicePixelRatio) && env.devicePixelRatio > 0) {
    device.dpr = Math.min(10, Math.max(0.5, Math.round(env.devicePixelRatio * 4) / 4));
  }
  const cores = finite(env.hardwareConcurrency) ? coreBucket(env.hardwareConcurrency) : undefined;
  if (cores !== undefined) device.cores = cores;
  if (finite(env.deviceMemory) && env.deviceMemory > 0) device.memoryGb = env.deviceMemory;
  const language = plain(env.language);
  if (language !== undefined) device.language = language;

  const high = await highEntropy(env);
  const platform = plain(env.userAgentData?.platform);
  if (high && platform !== undefined && platform !== "Unknown") {
    const osVersion = systemVersion(platform, plain(high.platformVersion));
    device.os = platform;
    if (osVersion !== undefined) device.osVersion = osVersion;
  }
  const model = plain(high?.model);
  if (model !== undefined) device.model = model;
  return device;
}
