// Native file/folder pickers and the local-file reads the renderer may ask for.
import type { App, BrowserWindow, Dialog } from 'electron';
import { isAbsolute as pathIsAbsolute, resolve as resolvePath } from 'node:path';
import { DESKTOP_IPC, type DesktopWorkspace } from '../shared/contract';
import type { DesktopService } from './desktop-service-contract';
import { absoluteLocalPath, readLocalFileAbs } from './local-files';
import type { IpcHandle as Handle } from './ipc';
import { requiredString, requiredWorkspaceFolders } from './ipc-validation';

interface FileDialogIpcOptions {
  window: BrowserWindow;
  app: Partial<Pick<App, 'getPath'>>;
  dialog: Pick<Dialog, 'showOpenDialog'> & Partial<Pick<Dialog, 'showSaveDialog'>>;
  host: Pick<DesktopService, 'addProject' | 'projectDirectory'>;
  handle: Handle;
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
  nativeT: (key: string) => string;
  describeLocalPaths: (value: unknown) => Promise<unknown[]>;
}

export function registerFileDialogIpc({
  window,
  app,
  dialog,
  host,
  handle,
  invokeDesktopOperation,
  nativeT,
  describeLocalPaths,
}: FileDialogIpcOptions): void {
  const defaultPathOption = (defaultPath: unknown) =>
    typeof defaultPath === 'string' && pathIsAbsolute(defaultPath) ? { defaultPath } : {};

  handle(DESKTOP_IPC.chooseProject, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: nativeT('Choose a Mixdog project folder'),
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle(DESKTOP_IPC.resolveLocalPaths, (_event, paths) => describeLocalPaths(paths));
  handle(DESKTOP_IPC.readLocalFile, (_event, rawPath) => readLocalFileAbs(rawPath));
  // Project file refresh is daemon-owned and refcounted there.
  handle(DESKTOP_IPC.folderWatch, (_event, dirRaw, recursive) => {
    const dir = absoluteLocalPath(dirRaw);
    return invokeDesktopOperation('folderWatch', [dir, recursive === true]);
  });
  handle(DESKTOP_IPC.folderUnwatch, (_event, dirRaw, recursive) => {
    const dir = absoluteLocalPath(dirRaw);
    return invokeDesktopOperation('folderUnwatch', [dir, recursive === true]);
  });
  handle(DESKTOP_IPC.chooseFile, async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog(window, {
      title: nativeT('Open file'),
      ...defaultPathOption(defaultPath),
      properties: ['openFile'],
    });
    const file = result.canceled ? '' : resolvePath(result.filePaths[0] || '');
    if (!file) return null;
    return (await describeLocalPaths([file]))[0] ?? null;
  });
  handle(DESKTOP_IPC.chooseFiles, async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog(window, {
      title: nativeT('Open files'),
      ...defaultPathOption(defaultPath),
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return describeLocalPaths(result.filePaths.map((file) => resolvePath(file)));
  });
  handle(DESKTOP_IPC.chooseWorkspace, async () => {
    const result = await dialog.showOpenDialog(window, {
      // User-facing product noun is Project; `.code-workspace` stays as the
      // on-disk format name only.
      title: nativeT('Open Project File'),
      properties: ['openFile'],
      filters: [{ name: nativeT('Project file'), extensions: ['code-workspace'] }],
    });
    const file = result.canceled ? '' : result.filePaths[0] || '';
    if (!file) return null;
    const workspace = await invokeDesktopOperation<DesktopWorkspace>('readWorkspaceFile', [file]);
    for (const folder of workspace.folders) await host.addProject(folder.path);
    return workspace;
  });
  handle(DESKTOP_IPC.saveWorkspace, async (_event, workspaceFile, rawFolders) => {
    const folders = requiredWorkspaceFolders(rawFolders);
    let file = typeof workspaceFile === 'string' && workspaceFile.trim() ? resolvePath(workspaceFile) : '';
    if (!file) {
      if (typeof dialog.showSaveDialog !== 'function') {
        throw new Error('The Project file save dialog is unavailable.');
      }
      const result = await dialog.showSaveDialog(window, {
        title: nativeT('Save Project File As'),
        defaultPath: 'project.code-workspace',
        filters: [{ name: nativeT('Project file'), extensions: ['code-workspace'] }],
      });
      if (result.canceled || !result.filePath) return null;
      file = result.filePath;
    }
    return invokeDesktopOperation('writeWorkspaceFile', [file, folders]);
  });
  handle(DESKTOP_IPC.readEditorSettings, async (_event, projectPath, relPath, workspaceFile) => {
    const project = requiredString(projectPath, 'projectPath');
    const root = await host.projectDirectory(project);
    const workspace =
      typeof workspaceFile === 'string' && workspaceFile.trim() ? resolvePath(workspaceFile) : undefined;
    const userDataPath = typeof app.getPath === 'function' ? app.getPath('userData') : '';
    const cleanRel = requiredString(relPath, 'relPath', 4_096);
    return invokeDesktopOperation('readScopedEditorSettings', [userDataPath, root, cleanRel, workspace]);
  });
}
