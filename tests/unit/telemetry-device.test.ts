import { describe, expect, it } from "vitest";
import { parseTelemetryDevice } from "@tetrizz/protocol";
import {
  collectDevice,
  coreBucket,
  deviceClassOf,
  displayModeOf,
  screenBucket,
  type DeviceEnv,
} from "../../apps/web/src/telemetry/device";

const s8: DeviceEnv = {
  userAgentData: {
    mobile: true,
    platform: "Android",
    getHighEntropyValues: () => Promise.resolve({ platformVersion: "8.0.0", model: "SM-G955F" }),
  },
  maxTouchPoints: 5,
  coarsePointer: true,
  screenWidth: 360,
  screenHeight: 740,
  devicePixelRatio: 4,
  hardwareConcurrency: 8,
  deviceMemory: 4,
  language: "en-US",
};

describe("device description", () => {
  it("describes an old Android phone and passes the server's own parser", async () => {
    const device = await collectDevice(s8);
    expect(device).toMatchObject({
      deviceClass: "mobile",
      displayMode: "browser",
      screen: "360x740",
      dpr: 4,
      cores: 8,
      memoryGb: 4,
      language: "en-US",
      os: "Android",
      osVersion: "8",
      model: "SM-G955F",
    });
    expect(parseTelemetryDevice(device)).toEqual(device);
  });

  it("reads Windows 11 from the platform version, which Windows reports as 10 otherwise", async () => {
    const win = (platformVersion: string): DeviceEnv => ({
      userAgentData: {
        mobile: false,
        platform: "Windows",
        getHighEntropyValues: () => Promise.resolve({ platformVersion, model: "" }),
      },
      screenWidth: 1920,
      screenHeight: 1080,
    });
    expect((await collectDevice(win("15.0.0"))).osVersion).toBe("11");
    expect((await collectDevice(win("10.0.0"))).osVersion).toBe("10");
    expect((await collectDevice(win("10.0.0"))).model).toBeUndefined();
  });

  it("sends no system name when the high-entropy values are not available", async () => {
    const device = await collectDevice({
      userAgentData: { mobile: false, platform: "Windows" },
      screenWidth: 1280,
      screenHeight: 720,
    });
    expect(device.os).toBeUndefined();
    expect(device.osVersion).toBeUndefined();
    const failing = await collectDevice({
      userAgentData: {
        platform: "macOS",
        getHighEntropyValues: () => Promise.reject(new Error("denied")),
      },
      screenWidth: 1280,
      screenHeight: 720,
    });
    expect(failing.os).toBeUndefined();
  });

  it("gives up waiting for slow high-entropy values", async () => {
    const device = await collectDevice({
      userAgentData: { platform: "Android", getHighEntropyValues: () => new Promise(() => {}) },
      screenWidth: 400,
      screenHeight: 800,
      coarsePointer: true,
      withTimeout: () => Promise.resolve(undefined),
    });
    expect(device.os).toBeUndefined();
    expect(device.deviceClass).toBe("mobile");
  });

  it("tells a tablet from a phone and a desktop, and an iPad that says it is a Mac", () => {
    expect(deviceClassOf({ coarsePointer: true, screenWidth: 820, screenHeight: 1180 })).toBe(
      "tablet",
    );
    expect(
      deviceClassOf({
        maxTouchPoints: 5,
        screenWidth: 1024,
        screenHeight: 768,
        userAgentData: undefined,
      }),
    ).toBe("tablet");
    expect(deviceClassOf({ coarsePointer: true, screenWidth: 390, screenHeight: 844 })).toBe(
      "mobile",
    );
    expect(deviceClassOf({ screenWidth: 1920, screenHeight: 1080 })).toBe("desktop");
    expect(deviceClassOf({ maxTouchPoints: 1, screenWidth: 1920, screenHeight: 1080 })).toBe(
      "desktop",
    );
    expect(deviceClassOf({})).toBe("unknown");
  });

  it("buckets sizes and counts so a device is not pinpointed", () => {
    expect(screenBucket(412, 915)).toBe("420x920");
    expect(screenBucket(915, 412)).toBe("420x920");
    expect(screenBucket(0, 100)).toBeUndefined();
    expect(coreBucket(5)).toBe(4);
    expect(coreBucket(20)).toBe(16);
    expect(coreBucket(64)).toBe(32);
    expect(coreBucket(0)).toBeUndefined();
  });

  it("knows how the page was opened", () => {
    expect(displayModeOf({ protocol: "file:" })).toBe("single-file");
    expect(displayModeOf({ protocol: "https:", standalone: true })).toBe("pwa");
    expect(displayModeOf({ protocol: "https:" })).toBe("browser");
  });

  it("drops fields that are not usable and never throws", async () => {
    const device = await collectDevice({
      screenWidth: Number.NaN,
      devicePixelRatio: -1,
      hardwareConcurrency: Number.POSITIVE_INFINITY,
      deviceMemory: 0,
      language: "é".repeat(60),
    });
    expect(device).toEqual({ deviceClass: "unknown", displayMode: "browser" });
  });
});
