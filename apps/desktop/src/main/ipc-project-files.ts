import { isAbsolute, posix } from 'node:path';
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
  /** A server window's upload coordinator (its connection's, shared with the other windows of that server). */
  uploads?: Parameters<typeof registerServerFileIpc>[0]['uploads'] | null;
}

const NO_UPLOADS: Parameters<typeof registerServerFileIpc>[0]['uploads'] = {
  begin: () => Promise.reject(new Error('The server connection is not available.')),
  write: () => Promise.reject(new Error('The server connection is not available.')),
  commit: () => Promise.reject(new Error('The server connection is not available.')),
  abort: () => false,
  releaseOwner: () => undefined,
};

/** Returns the window's teardown (its server uploads are cancelled). */
export function registerProjectFileIpc({
  handle,
  host,
  invokeDesktopOperation,
  shell,
  grantedFile,
  server = null,
  uploads = null,
}: ProjectFileIpcOptions): () => void {
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

  // A converted document's PDF sits in the server's cache folder, which is no Project: where no Project answers, an absolute path of the
  // server is its own folder (as a standalone folder is on this PC), so the preview is served from it by range like any other.
  const serverPreviewTarget = async (
    projectPath: unknown,
    relPath: unknown,
    accessToken: unknown
  ): Promise<{ root: string; rel: string }> => {
    try {
      return await editorFileTarget(projectPath, relPath, accessToken);
    } catch (error) {
      const hasToken = typeof accessToken === 'string' && accessToken !== '';
      if (hasToken || typeof projectPath !== 'string' || !/^([\\/]|[A-Za-z]:[\\/])/.test(projectPath)) throw error;
      return { root: projectPath, rel: requiredString(relPath, 'relPath', 4_096) };
    }
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
      const target = await serverPreviewTarget(projectPath, relPath, accessToken);
      const info = await invokeDesktopOperation<{ mtimeMs: number; size: number }>('statProjectFileIn', [
        target.root,
        target.rel,
      ]);
      const preview = server.previews.register(target.root, target.rel, `${info.mtimeMs}:${info.size}`);
      if (!preview) throw new Error('This file type does not support an in-app preview.');
      return { ...preview, ...info };
    }
    let file: string;
    let root: string;
    let info: { mtimeMs: number; size: number };
    if (typeof accessToken === 'string' && accessToken) {
      const granted = await grantedFile(accessToken, projectPath, relPath);
      file = granted.absolute;
      root = granted.root;
      info = await invokeDesktopOperation('statProjectFileIn', [granted.root, granted.rel]);
    } else {
      const cleanProject = requiredString(projectPath, 'projectPath');
      const cleanRel = requiredString(relPath, 'relPath');
      root = await projectRoot(cleanProject);
      file = projectEntryPathIn(root, cleanRel);
      info = await invokeDesktopOperation('statProjectFileIn', [root, cleanRel]);
    }
    const preview = registerFilePreview(file, `${info.mtimeMs}:${info.size}`, { root });
    if (!preview) throw new Error('This file type does not support an in-app preview.');
    return { ...preview, ...info };
  });
  // The converted PDF is a product of the core's bounded cache. The main process owns the conversion so the registration can
  // convert the same source again when the cache evicted the file: the viewer's URL keeps working.
  handle(DESKTOP_IPC.previewDocumentFile, async (_event, projectPath, relPath, accessToken) => {
    const target = await editorFileTarget(projectPath, relPath, accessToken);
    const convert = () =>
      invokeDesktopOperation<{ path: string; format: string; mtimeMs: number; size: number }>('documentPreviewIn', [
        target.root,
        target.rel,
      ]);
    const converted = await convert();
    const version = `${converted.mtimeMs}:${converted.size}`;
    // On a server the converted PDF sits in the daemon's cache there.
    const preview = server
      ? server.previews.register(posix.dirname(converted.path), posix.basename(converted.path), version, {
          regenerate: convert,
        })
      : registerFilePreview(converted.path, version, { regenerate: convert });
    if (!preview) throw new Error('The converted document preview is unavailable.');
    return {
      url: preview.url,
      kind: 'pdf' as const,
      mime: preview.mime,
      format: converted.format,
      mtimeMs: converted.mtimeMs,
      size: converted.size,
    };
  });
  if (!server) return () => undefined;
  return registerServerFileIpc({
    handle,
    server,
    uploads: uploads ?? NO_UPLOADS,
    invokeDesktopOperation,
    fileTarget: editorFileTarget,
    projectDirectory: (project) => host.projectDirectory(project),
    shell,
  });
}
