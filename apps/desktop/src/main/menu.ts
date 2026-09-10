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
        ? [...fileItems, { role: 'close', label: nativeT('Close window'), accelerator: 'CmdOrCtrl+Shift+W' }]
        // Ctrl+Q belongs to the focused workspace tab. Keep explicit menu
        // quit available without registering an accelerator ahead of React.
        : [...fileItems, { role: 'quit', label: nativeT('Quit Mixdog'), registerAccelerator: false }],
    },
    {
      label: nativeT('Edit'),
      submenu: [
        { role: 'undo', label: nativeT('Undo') }, { role: 'redo', label: nativeT('Redo') }, { type: 'separator' },
        { role: 'cut', label: nativeT('Cut') }, { role: 'copy', label: nativeT('Copy') },
        { role: 'paste', label: nativeT('Paste') }, { role: 'selectAll', label: nativeT('Select All') },
      ],
    },
    {
      label: nativeT('View'),
      submenu: [
        ...(development ? [
          { role: 'reload' as const, label: nativeT('Reload') },
          { role: 'forceReload' as const, label: nativeT('Force Reload') },
        ] : []),
        ...(zoom ? [
          { label: nativeT('Actual Size'), accelerator: 'CmdOrCtrl+0', click: zoom.reset },
          { label: nativeT('Zoom In'), accelerator: 'CmdOrCtrl+Plus', click: zoom.zoomIn },
          { label: nativeT('Zoom Out'), accelerator: 'CmdOrCtrl+-', click: zoom.zoomOut },
        ] : [
          { role: 'resetZoom' as const, label: nativeT('Actual Size'), accelerator: 'CmdOrCtrl+0' },
          { role: 'zoomIn' as const, label: nativeT('Zoom In'), accelerator: 'CmdOrCtrl+Plus' },
          { role: 'zoomOut' as const, label: nativeT('Zoom Out'), accelerator: 'CmdOrCtrl+-' },
        ]),
        { type: 'separator' },
        { role: 'togglefullscreen', label: nativeT('Toggle Full Screen'), accelerator: process.platform === 'darwin' ? 'Ctrl+Cmd+F' : 'F11' },
      ],
    },
    {
      label: nativeT('Window'),
      submenu: [
        { role: 'minimize', label: nativeT('Minimize'), accelerator: 'CmdOrCtrl+M' },
        { role: 'close', label: nativeT('Close window'), accelerator: process.platform === 'darwin' ? 'CmdOrCtrl+Shift+W' : undefined },
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
