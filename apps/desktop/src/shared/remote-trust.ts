/** The `browser` a second PC's Mixdog desktop window reports in its pairing
 *  claim. It only labels the approval prompt. */
export const MIXDOG_DESKTOP_CLIENT_BROWSER = 'Mixdog Desktop';

/** The `browser` the Mixdog phone app (native shell) reports in its claim. */
export const MIXDOG_APP_CLIENT_BROWSER = 'Mixdog App';

export type RemoteClientKind = 'app' | 'pc' | 'browser';

/** What kind of device a paired client is, from the label it reported. */
export function remoteClientKind(browser: string): RemoteClientKind {
  if (browser === MIXDOG_DESKTOP_CLIENT_BROWSER) return 'pc';
  if (browser === MIXDOG_APP_CLIENT_BROWSER) return 'app';
  return 'browser';
}
