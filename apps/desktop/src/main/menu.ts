import { Menu, type MenuItemConstructorOptions } from 'electron';

export function nativeMenuTemplate(development: boolean): MenuItemConstructorOptions[] {
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
        { role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
        { role: 'zoomIn', accelerator: 'CmdOrCtrl+Plus' },
        { role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
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

export function installNativeMenu(development: boolean): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(nativeMenuTemplate(development)));
}
