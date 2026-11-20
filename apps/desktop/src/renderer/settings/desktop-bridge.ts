import type { DesktopApi } from '../../shared/contract';

/** The preload bridge, absent in the web shell and in tests; `T` narrows it to the slice a caller uses. */
export function desktopBridge<T = DesktopApi>(): T | undefined {
  return (window as unknown as { mixdogDesktop?: T }).mixdogDesktop;
}

/** Opens `url` in the system browser; a host without the call, or a refusal, is ignored. */
export function openExternalUrl(url: string): void {
  openExternalOn(desktopBridge(), url);
}

/** Opens `url` through a bridge captured earlier; nothing happens when there was none. */
export function openExternalOn(host: Partial<Pick<DesktopApi, 'openExternal'>> | undefined, url: string): void {
  void host?.openExternal?.(url).catch(() => undefined);
}
