export const APP_VERSION: string = __APP_VERSION__;

/** Writes the build's version into the main menu footer. */
export function showAppVersion(): void {
  const el = document.getElementById("appVersion");
  if (el) el.textContent = `v${APP_VERSION}`;
}
