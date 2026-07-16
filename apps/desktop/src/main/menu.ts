import { Menu, type MenuItemConstructorOptions } from 'electron';

export interface NativeZoomActions {
  reset(): void;
  zoomIn(): void;
  zoomOut(): void;
}

export function nativeMenuTemplate(
  development: boolean,
  zoom?: NativeZoomActions,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  if (process.platform === 'darwin') {
    template.push({ role: 'appMenu' });
  }
  template.push(
    {
      label: 'File',
      submenu: process.platform === 'darwin'
        ? [{ role: 'close', accelerator: 'CmdOrCtrl+W' }]
        : [{ role: 'quit', accelerator: 'CmdOrCtrl+Q' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...(development ? [{ role: 'reload' as const }, { role: 'forceReload' as const }] : []),
        ...(zoom ? [
          { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: zoom.reset },
          { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: zoom.zoomIn },
          { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: zoom.zoomOut },
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
      label: 'Window',
      submenu: [{ role: 'minimize', accelerator: 'CmdOrCtrl+M' }, { role: 'close' }],
    },
  );
  return template;
}

export function installNativeMenu(development: boolean, zoom?: NativeZoomActions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(nativeMenuTemplate(development, zoom)));
}
