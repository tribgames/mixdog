import type { DesktopConnectionIdentity } from '../shared/contract';

/** The daemon connection this Electron window drives (preload-provided);
 *  null on remote surfaces (phone, browser, another PC's window). */
export function desktopConnection(): DesktopConnectionIdentity | null {
  return (typeof window !== 'undefined' && window.mixdogDesktop?.connection) || null;
}

/** A server (ssh) window: features that act on this PC (Computer Use, the
 *  browser pane, phone access, this PC's files) are not offered here. */
export function isSshConnectionWindow(): boolean {
  return desktopConnection()?.kind === 'ssh';
}
