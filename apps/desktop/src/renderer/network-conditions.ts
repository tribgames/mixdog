import { isRemoteHostRenderer } from './remote-ui-projection';

type NetworkInformation = { saveData?: boolean; effectiveType?: string };

type ConnectionQuality = 'metered' | 'slow' | 'normal';

/** True for the relay-served web app; false inside the Electron shell. */
export function isRemoteSurface(): boolean {
  return isRemoteHostRenderer();
}

/** `metered` — data saver on, or a 2G-class link.
 *  `slow` — 3G-class: usable, but a background megabyte is felt.
 *  `normal` — everything else, including browsers without the API. */
export function connectionQuality(): ConnectionQuality {
  try {
    const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
    if (!connection) return 'normal';
    if (connection.saveData === true) return 'metered';
    const effective = String(connection.effectiveType || '');
    if (/(^|-)2g$/i.test(effective)) return 'metered';
    if (/(^|-)3g$/i.test(effective)) return 'slow';
    return 'normal';
  } catch {
    return 'normal';
  }
}
