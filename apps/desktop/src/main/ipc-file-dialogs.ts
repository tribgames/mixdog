// Native file/folder pickers and the local-file reads the renderer may ask for.
import type { App, BrowserWindow, Dialog } from 'electron';
import { randomBytes } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, isAbsolute as pathIsAbsolute, resolve as resolvePath } from 'node:path';
import { DESKTOP_IPC, type DesktopWorkspace } from '../shared/contract';
import type { DesktopService } from './desktop-service-contract';
import { createDialogFolderMemory } from './dialog-folder-memory';
import { absoluteLocalPath, readLocalFileAbs } from './local-files';
import type { IpcHandle as Handle } from './ipc';
import { requiredSaveSource, requiredString, requiredWorkspaceFolders, sanitizedFileName } from './ipc-validation';
import type { ConnectionKind } from './connections/contract';
import { remotePickerRequired } from './connections/feature-gates';
import { absoluteServerPath } from './server-file-access';
import { writeUserFile } from './user-file-write';

interface FileDialogIpcOptions {
  window: BrowserWindow;
  app: Partial<Pick<App, 'getPath'>>;
  /** A server (`ssh`) window: its folders live on the server, not this PC. */
  connectionKind?: ConnectionKind;
  dialog: Pick<Dialog, 'showOpenDialog'> & Partial<Pick<Dialog, 'showSaveDialog'>>;
  host: Pick<DesktopService, 'addProject' | 'projectDirectory'>;
  handle: Handle;
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
  nativeT: (key: string) => string;
  describeLocalPaths: (value: unknown) => Promise<unknown[]>;
}

const SAVE_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024;
const SAVE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** Streams an http(s) URL into `file` under a byte cap and a deadline; a
 *  failed or aborted download leaves no partial file behind. */
export async function downloadToFile(
  url: string,
  file: string,
  { maxBytes = SAVE_DOWNLOAD_MAX_BYTES, timeoutMs = SAVE_DOWNLOAD_TIMEOUT_MS } = {}
): Promise<void> {
  // A short sibling name: appending to a long destination name could exceed
  // the filesystem's per-component limit. Not dot-prefixed: Windows cloud-sync
  // folders (Naver MYBOX, #138) refuse to create such names.
  const temp = join(dirname(file), `mixdog-tmp-${randomBytes(8).toString('hex')}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Download timed out.')), timeoutMs);
  // Only a temp file this call created is ever removed: a pre-existing file
  // of the same name is never opened for writing (`wx`) nor deleted.
  let created = false;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxBytes) throw new Error('Download is too large.');
    let received = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) callback(new Error('Download is too large.'));
        else callback(null, chunk);
      },
    });
    const handle = await open(temp, 'wx');
    created = true;
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      limit,
      // Flushed before the rename publishes it, so a crash cannot leave the
      // destination holding a NUL-filled download.
      handle.createWriteStream({ flush: true }),
      { signal: controller.signal }
    );
    await rename(temp, file);
  } catch (error) {
    if (created) await rm(temp, { force: true }).catch(() => undefined);
    throw controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}

export function registerFileDialogIpc({
  window,
  app,
  connectionKind = 'local',
  dialog,
  host,
  handle,
  invokeDesktopOperation,
  nativeT,
  describeLocalPaths,
}: FileDialogIpcOptions): void {
  const { startIn, remember } = createDialogFolderMemory();
  const defaultPathOption = (defaultPath: unknown) =>
    typeof defaultPath === 'string' && pathIsAbsolute(defaultPath) ? { defaultPath } : startIn();

  const watchedDirectory = connectionKind === 'ssh' ? absoluteServerPath : absoluteLocalPath;

  handle(DESKTOP_IPC.chooseProject, async () => {
    // This PC's folder dialog cannot pick a folder on the server.
    if (connectionKind === 'ssh') throw remotePickerRequired();
    const result = await dialog.showOpenDialog(window, {
      title: nativeT('Choose a Mixdog project folder'),
      ...startIn(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (remember(result.filePaths[0]) ?? null);
  });
  handle(DESKTOP_IPC.saveFileAs, async (_event, source, suggestedName) => {
    const target = requiredSaveSource(source);
    if (typeof dialog.showSaveDialog !== 'function') throw new Error('The save dialog is unavailable.');
    const result = await dialog.showSaveDialog(window, {
      title: target.kind === 'data' ? nativeT('Save as') : nativeT('Save link as'),
      ...startIn(sanitizedFileName(suggestedName)),
    });
    if (result.canceled || !remember(result.filePath)) return false;
    if (target.kind === 'data') {
      await writeUserFile(result.filePath, target.bytes);
      return true;
    }
    await downloadToFile(target.url, result.filePath);
    return true;
  });
  // A server window's "local" paths (its file tree, agent output links) are
  // the server's: they are described and read there by the daemon.
  handle(DESKTOP_IPC.resolveLocalPaths, (_event, paths) => describeLocalPaths(paths));
  handle(DESKTOP_IPC.readLocalFile, (_event, rawPath) =>
    connectionKind === 'ssh'
      ? invokeDesktopOperation('readLocalFileAbs', [absoluteServerPath(rawPath)])
      : readLocalFileAbs(rawPath)
  );
  // Project file refresh is daemon-owned and refcounted there.
  handle(DESKTOP_IPC.folderWatch, (_event, dirRaw, recursive) => {
    const dir = watchedDirectory(dirRaw);
    return invokeDesktopOperation('folderWatch', [dir, recursive === true]);
  });
  handle(DESKTOP_IPC.folderUnwatch, (_event, dirRaw, recursive) => {
    const dir = watchedDirectory(dirRaw);
    return invokeDesktopOperation('folderUnwatch', [dir, recursive === true]);
  });
  // The folder picker of a server window: the daemon (on the server) lists its
  // own directories and rejects a path that is not absolute there.
  handle(DESKTOP_IPC.listServerDirectories, (_event, path, includeHidden) =>
    invokeDesktopOperation('listServerDirectories', [path, includeHidden === true])
  );
  handle(DESKTOP_IPC.chooseFile, async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog(window, {
      title: nativeT('Open file'),
      ...defaultPathOption(defaultPath),
      properties: ['openFile'],
    });
    const file = result.canceled ? '' : remember(resolvePath(result.filePaths[0] || ''));
    if (!file) return null;
    return (await describeLocalPaths([file]))[0] ?? null;
  });
  handle(DESKTOP_IPC.chooseConversationImportFile, async () => {
    // Importing reads this PC's Codex / Claude Code files; a server window has none.
    if (connectionKind === 'ssh') throw new Error(nativeT('Importing conversations is available only on this PC.'));
    const result = await dialog.showOpenDialog(window, {
      title: nativeT('Choose a conversation file'),
      ...startIn(),
      properties: ['openFile'],
      filters: [{ name: nativeT('Conversation file'), extensions: ['jsonl', 'zst'] }],
    });
    return result.canceled ? null : remember(resolvePath(result.filePaths[0] || '')) || null;
  });
  handle(DESKTOP_IPC.chooseFiles, async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog(window, {
      title: nativeT('Open files'),
      ...defaultPathOption(defaultPath),
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    remember(result.filePaths[0]);
    return describeLocalPaths(result.filePaths.map((file) => resolvePath(file)));
  });
  handle(DESKTOP_IPC.chooseWorkspace, async () => {
    const result = await dialog.showOpenDialog(window, {
      // User-facing product noun is Project; `.code-workspace` stays as the
      // on-disk format name only.
      title: nativeT('Open Project File'),
      ...startIn(),
      properties: ['openFile'],
      filters: [{ name: nativeT('Project file'), extensions: ['code-workspace'] }],
    });
    const file = result.canceled ? '' : remember(result.filePaths[0] || '');
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
        ...startIn('project.code-workspace'),
        filters: [{ name: nativeT('Project file'), extensions: ['code-workspace'] }],
      });
      if (result.canceled || !remember(result.filePath)) return null;
      file = result.filePath;
    }
    return invokeDesktopOperation('writeWorkspaceFile', [file, folders]);
  });
  const userDataDir = () => (typeof app.getPath === 'function' ? app.getPath('userData') : '');
  handle(DESKTOP_IPC.readMarkdownDefaultView, () => invokeDesktopOperation('readMarkdownDefaultView', [userDataDir()]));
  handle(DESKTOP_IPC.writeMarkdownDefaultView, (_event, view) =>
    invokeDesktopOperation('writeMarkdownDefaultView', [userDataDir(), view])
  );
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
