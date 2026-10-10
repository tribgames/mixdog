/** Single source of truth: this renderer drives a remote host through the
 *  shim installed by `remote-shim.ts` (`window.mixdogRemoteServer`). It is
 *  independent of the user agent, so a second PC's Electron app counts too. */
export function isRemoteHostRenderer(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer);
}

/** Running inside Electron (title bar caption strip and other native chrome),
 *  regardless of whether it drives a remote host. */
export function isElectronRenderer(): boolean {
  return typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent);
}

/** This renderer is the host's own native window: Electron, local host. */
export function isNativeDesktopWindow(): boolean {
  return !isRemoteHostRenderer() && Boolean(window.mixdogDesktop?.bootContext?.bootId);
}

/** UA-based "plain browser" check; only phone-layout decisions and browser
 *  image handling use it. Remote capability decisions use isRemoteHostRenderer. */
export function isRemoteBrowserRenderer(): boolean {
  return typeof navigator !== 'undefined' && !/Electron/i.test(navigator.userAgent);
}
