// The file handlers that stay in main: a project page's local URL and the in-app preview of a file (both register what the
// `mixdog-media` and local-page schemes serve in this process), and, in a server window, the uploads, downloads and trash probe.
// Reading, writing, listing, searching, the editor backups, the entries, the language servers and the code graph are requests of
// the window's own core connection.
import { isAbsolute } from 'node:path';
import type { Shell } from 'electron';
import { DESKTOP_IPC } from '../shared/contract';
import type { DesktopService } from './desktop-service-contract';
import { registerFilePreview } from './file-preview';
import { coreLocalPages } from './core-local-pages';
import { windowIdFor } from './core-port/window-ids';
import { projectEntryPathIn } from './project-entry-path';
import { requiredString } from './ipc-validation';
import type { IpcHandle as Handle } from './ipc';
import { registerServerFileIpc } from './ipc-server-files';
import type { ServerFiles } from './server-file-access';

type GrantedFile = {
  root: string;
  rel: string;
  absolute: string;
};

interface ProjectFileIpcOptions {
  handle: Handle;
  host: Pick<DesktopService, 'projectDirectory'>;
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
  shell: Pick<Shell, 'openPath'>;
  grantedFile: (accessToken: unknown, projectPath: unknown, relPath: unknown) => Promise<GrantedFile>;
  /** A server (ssh) window: its files are read, previewed and deleted on the
   *  server through the daemon, never through this PC's filesystem. */
  server?: ServerFiles | null;
}

export function registerProjectFileIpc({
  handle,
  host,
  invokeDesktopOperation,
  shell,
  grantedFile,
  server = null,
}: ProjectFileIpcOptions): void {
  // A path that is not a registered Project but is an existing folder answers every file call as its own root, wherever it is: a
  // chat link to it opens it like a Project's, and the path alone re-establishes that root. Nothing is remembered or granted. A
  // registered Project always keeps the host's route: the host is tried first, and only when it refuses does the core classify the
  // path (standaloneRoot: null for a registered Project, a missing path or a file). A failing core call is an error, not "no
  // Projects". A server window never gets this: its folders are the server's.
  const standaloneFolder = async (projectPath: string): Promise<string | null> => {
    if (server || !isAbsolute(projectPath)) return null;
    return invokeDesktopOperation<string | null>('standaloneRoot', [projectPath]);
  };
  const projectRoot = async (projectPath: string): Promise<string> => {
    try {
      return await host.projectDirectory(projectPath);
    } catch (error) {
      const folder = await standaloneFolder(projectPath);
      if (!folder) throw error;
      return folder;
    }
  };
  const editorFileTarget = async (
    projectPath: unknown,
    relPath: unknown,
    accessToken: unknown
  ): Promise<{ root: string; rel: string }> => {
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      return { root: granted.root, rel: granted.rel };
    }
    return {
      root: await projectRoot(requiredString(projectPath, 'projectPath')),
      rel: requiredString(relPath, 'relPath', 4_096),
    };
  };

  handle(DESKTOP_IPC.localPageUrl, async (event, projectPath, relPath, accessToken) => {
    const project = requiredString(projectPath, 'projectPath');
    const rel = requiredString(relPath, 'relPath', 4_096);
    const owner = event.sender;
    // The window's core id, never its webContents id (Electron reuses those).
    const ownerId = windowIdFor(owner);
    // A supplied grant stays file-only: the core redeems it (an invalid or
    // expired token never falls back to the project). Without one, the page
    // is served from the folder it was opened in, Project or not.
    if (accessToken !== undefined && accessToken !== '') {
      const token = requiredString(accessToken, 'file access token', 128);
      return coreLocalPages().url(project, rel, { accessToken: token, owner, ownerId });
    }
    return coreLocalPages().url(await projectRoot(project), rel, { owner, ownerId });
  });
  handle(DESKTOP_IPC.previewProjectFile, async (_event, projectPath, relPath, accessToken) => {
    if (server) {
      const target = await editorFileTarget(projectPath, relPath, accessToken);
      const info = await invokeDesktopOperation<{ mtimeMs: number; size: number }>('statProjectFileIn', [
        target.root,
        target.rel,
      ]);
      const preview = server.previews.register(target.root, target.rel, `${info.mtimeMs}:${info.size}`);
      if (!preview) throw new Error('This file type does not support an in-app preview.');
      return { ...preview, ...info };
    }
    let file: string;
    let info: { mtimeMs: number; size: number };
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      file = granted.absolute;
      info = await invokeDesktopOperation('statProjectFileIn', [granted.root, granted.rel]);
    } else {
      const cleanProject = requiredString(projectPath, 'projectPath');
      const cleanRel = requiredString(relPath, 'relPath');
      const root = await projectRoot(cleanProject);
      file = projectEntryPathIn(root, cleanRel);
      info = await invokeDesktopOperation('statProjectFileIn', [root, cleanRel]);
    }
    const preview = registerFilePreview(file, `${info.mtimeMs}:${info.size}`);
    if (!preview) throw new Error('This file type does not support an in-app preview.');
    return { ...preview, ...info };
  });
  if (server) {
    registerServerFileIpc({
      handle,
      server,
      invokeDesktopOperation,
      fileTarget: editorFileTarget,
      projectDirectory: (project) => host.projectDirectory(project),
      shell,
    });
  }
}
