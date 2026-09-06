import { Menu, type MenuItemConstructorOptions } from 'electron';
import { nativeT } from './native-i18n';

export interface NativeZoomActions {
  reset(): void;
  zoomIn(): void;
  zoomOut(): void;
}

export interface NativeMenuExtras {
  /** Opens the phone pairing window (starts the remote legs on demand). */
  showRemoteAccess?: () => void;
}

function nativeMenuTemplate(
  development: boolean,
  zoom?: NativeZoomActions,
  extras?: NativeMenuExtras,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  if (process.platform === 'darwin') {
    template.push({ role: 'appMenu' });
  }
  const fileItems: MenuItemConstructorOptions[] = [];
  if (extras?.showRemoteAccess) {
    fileItems.push(
      // The Windows shell is frameless (no visible menu bar), so the
      // accelerator IS the entry point there; macOS shows the item too.
      { label: nativeT('Remote Access…'), accelerator: 'CmdOrCtrl+Shift+R', click: extras.showRemoteAccess },
      { type: 'separator' },
    );
  }
  template.push(
    {
      label: nativeT('File'),
      submenu: process.platform === 'darwin'
        ? [...fileItems, { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' }]
        // Ctrl+Q belongs to the focused workspace tab. Keep explicit menu
        // quit available without registering an accelerator ahead of React.
        : [...fileItems, { role: 'quit', registerAccelerator: false }],
    },
    {
      label: nativeT('Edit'),
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: nativeT('View'),
      submenu: [
        ...(development ? [{ role: 'reload' as const }, { role: 'forceReload' as const }] : []),
        ...(zoom ? [
          { label: nativeT('Actual Size'), accelerator: 'CmdOrCtrl+0', click: zoom.reset },
          { label: nativeT('Zoom In'), accelerator: 'CmdOrCtrl+Plus', click: zoom.zoomIn },
          { label: nativeT('Zoom Out'), accelerator: 'CmdOrCtrl+-', click: zoom.zoomOut },
        ] : [
          { role: 'resetZoom' as const, accelerator: 'CmdOrCtrl+0' },
          { role: 'zoomIn' as const, accelerator: 'CmdOrCtrl+Plus' },
          { role: 'zoomOut' as const, accelerator: 'CmdOrCtrl+-' },
        ]),
        { type: 'separator' },
        { role: 'togglefullscreen', accelerator: process.platform === 'darwin' ? 'Ctrl+Cmd+F' : 'F11' },
      ],
    },
    {
      label: nativeT('Window'),
      submenu: [
        { role: 'minimize', accelerator: 'CmdOrCtrl+M' },
        { role: 'close', accelerator: process.platform === 'darwin' ? 'CmdOrCtrl+Shift+W' : undefined },
      ],
    },
  );
  return template;
}

export function installNativeMenu(
  development: boolean,
  zoom?: NativeZoomActions,
  extras?: NativeMenuExtras,
): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(nativeMenuTemplate(development, zoom, extras)));
}
