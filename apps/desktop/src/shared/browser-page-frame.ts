import type { DesktopBrowserPageFrame, DesktopBrowserPageResample } from './contract';

/** Distinguish "ask again for the current page" from real pixels. Both the pane
 * and the harnesses read display frames, so the check lives beside the two
 * surfaces that share the contract rather than in either one. */
export function browserPageResample(
  value: DesktopBrowserPageFrame | DesktopBrowserPageResample
): value is DesktopBrowserPageResample {
  return (value as DesktopBrowserPageResample).resample === true;
}
