export function isRemoteBrowserRenderer(): boolean {
  return typeof navigator !== "undefined" && !/Electron/i.test(navigator.userAgent);
}
