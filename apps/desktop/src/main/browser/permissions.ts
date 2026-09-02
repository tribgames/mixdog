import type { Session } from 'electron';

type BrowserPermissionSession = Pick<
  Session,
  | 'setDevicePermissionHandler'
  | 'setPermissionCheckHandler'
  | 'setPermissionRequestHandler'
>;

/**
 * Browser Use can emulate page context through CDP without granting a site
 * access to real microphones, cameras, location, or attached devices.
 */
export function lockDownBrowserPermissions(session: BrowserPermissionSession): void {
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.setDevicePermissionHandler(() => false);
}

export function clearBrowserPermissionHandlers(session: BrowserPermissionSession): void {
  session.setPermissionCheckHandler(null);
  session.setPermissionRequestHandler(null);
  session.setDevicePermissionHandler(null);
}
