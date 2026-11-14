// The "Projects, files, editor, LSP" half of DesktopApi (DIRECT_KEYS.files) composed in the renderer over this window's
// core connection. Each key sends what main's IPC handler sent for the same call (ipc-projects.ts, ipc-project-files.ts,
// ipc-file-dialogs.ts): the shared service lane for the project methods and the operation lane for the file operations, so
// the method names, params and replies are the ones the IPC path had. The input checks are the core's now; what stays is what
// changed the call: a Project path becomes its folder first (the core trusts a window's folder), a path that is no Project
// answers as its own folder (a standalone root), and a one-file access token goes to the core with the project path and the
// relative path so the core redeems it.
import type { DesktopApi, SessionSnapshot } from '../../shared/contract.ts';
import type { DirectKey } from '../../shared/desktop-api-split.ts';
import { createOperationLane } from '../../shared/core-lanes/desktop-operation-route.ts';
import { createServiceLane } from '../../shared/core-lanes/service-route.ts';
import type { DesktopSectionsPush } from '../../shared/contract-sections.ts';
import type { DirectContext } from './context.ts';
import { withDirectErrors } from './errors.ts';

export type FilesApi = Pick<DesktopApi, DirectKey<'files'>>;

/** The URL form of the desktop media lane (preload mediaUrl): a file lease the core minted for a preview. */
const mediaAssetUrl = (assetId: string): string => `mixdog-media://asset/${encodeURIComponent(assetId)}?variant=original`;
/** Raw bytes asked per `projectFs/previewRange` (the core allows 4 MiB). */
const PREVIEW_CHUNK_BYTES = 2 * 1024 * 1024;
/** PDF blobs a window keeps: the oldest is revoked past this. */
const PDF_BLOB_LIMIT = 48;
/** Node's `path.isAbsolute` on the PC (a Windows host also takes the POSIX form). */
const isAbsolutePath = (path: string): boolean => /^([\\/]|[A-Za-z]:[\\/])/.test(path);
const hasToken = (token: unknown): token is string => typeof token === 'string' && token !== '';

function bytesFromBase64(data: string): Uint8Array {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

const hostPlatform = (): 'win32' | 'darwin' | 'linux' => {
  const name = typeof navigator === 'object' ? String(navigator.platform ?? '') : '';
  return /^win/i.test(name) ? 'win32' : /^mac/i.test(name) ? 'darwin' : 'linux';
};

type FileTarget = { root: string; rel: string; accessToken?: string };

export function createFilesApi(ctx: DirectContext): FilesApi {
  const folderListeners = new Set<(dir: string) => void>();
  const diagnosticListeners = new Set<(event: never) => void>();
  const statusListeners = new Set<(event: never) => void>();

  const remoteSessionId = (): string | undefined => {
    const held = ctx.connection.snapshot().entries.find((e) => e.section === 'hostState' && e.key === 'remoteSession');
    const id = (held?.value as { sessionId?: unknown } | null | undefined)?.sessionId;
    return typeof id === 'string' ? id : undefined;
  };
  const service = createServiceLane({
    protocol: ctx.connection,
    snapshot: () => ({ remoteSessionId: remoteSessionId() }) as unknown as SessionSnapshot,
  });
  const operations = createOperationLane({
    platform: hostPlatform(),
    protocol: ctx.connection,
    host: {
      hostName: () => '',
      emitDesktopEvent(name, value) {
        if (name === 'folder-changed') for (const listener of [...folderListeners]) listener(String(value ?? ''));
      },
    },
  });

  const svc = <T = never>(method: string, args: unknown[]): Promise<T> => service.call<T>(method, args);
  const op = <T = never>(name: string, args: unknown[]): Promise<T> => operations.invoke(name, args) as Promise<T>;
  /** One key's work, its failure shown as the IPC path showed it. */
  const direct = <T>(run: () => Promise<T>): Promise<T> => withDirectErrors(Promise.resolve().then(run));
  const serverWindow = (): boolean => ctx.window()?.role?.startsWith('server:') === true;

  // A path that is not a registered Project but is an existing folder answers every file call as its own root. A Project
  // always keeps the first route; only when it refuses does the core classify the path. A server window never gets this:
  // its folders are the server's.
  const standaloneFolder = async (project: string): Promise<string | null> =>
    serverWindow() || !isAbsolutePath(project) ? null : op<string | null>('standaloneRoot', [project]);
  const onRoot = async <T>(
    project: string,
    inProject: () => Promise<T>,
    inFolder: (folder: string) => Promise<T>
  ): Promise<T> => {
    try {
      return await inProject();
    } catch (error) {
      const folder = await standaloneFolder(project);
      if (!folder) throw error;
      return inFolder(folder);
    }
  };
  const projectRoot = (project: string): Promise<string> =>
    onRoot(
      project,
      () => svc<string>('projectDirectory', [project]),
      async (folder) => folder
    );
  const projectFolder = (project: string): Promise<string> => svc<string>('projectDirectory', [project]);
  /** A Project and a path in it as the core takes them: a token names the file (the core redeems it), else the folder. */
  const fileTarget = async (project: string, rel: string, accessToken: unknown): Promise<FileTarget> =>
    hasToken(accessToken) ? { root: project, rel, accessToken } : { root: await projectRoot(project), rel };
  /** The folder and name a document conversion runs in: a granted file's own folder, else the Project's. */
  const documentPlace = async (project: string, rel: string, accessToken: unknown): Promise<{ root: string; rel: string }> => {
    if (!hasToken(accessToken)) return { root: await projectRoot(project), rel };
    const { path } = (await ctx.call('projectFs/entryPath', { root: project, rel, accessToken })) as { path: string };
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return { root: path.slice(0, cut), rel: path.slice(cut + 1) };
  };
  const entryPath = async (project: string, rel: string, accessToken: unknown): Promise<string> =>
    ((await ctx.call('projectFs/entryPath', await fileTarget(project, rel, accessToken))) as { path: string }).path;
  const announceProjectsChanged = <T>(result: T): T => {
    void op('notifySettingsChanged', ['desktop']).catch(() => undefined);
    return result;
  };

  // A PDF's bytes are read in ranges and held as a blob URL: nothing in the page can open a file lease for a document.
  const pdfBlobs = new Map<string, string>();
  const pdfUrl = async (target: FileTarget, version: string): Promise<string> => {
    const key = `${target.root}\0${target.rel}\0${target.accessToken ?? ''}\0${version}`;
    const held = pdfBlobs.get(key);
    if (held) {
      pdfBlobs.delete(key);
      pdfBlobs.set(key, held);
      return held;
    }
    const parts: Uint8Array[] = [];
    let offset = 0;
    let size = Number.POSITIVE_INFINITY;
    while (offset < size) {
      const range = (await ctx.call('projectFs/previewRange', { ...target, offset, length: PREVIEW_CHUNK_BYTES })) as {
        data: string;
        size: number;
      };
      size = range.size;
      const bytes = bytesFromBase64(range.data);
      if (!bytes.length) break;
      parts.push(bytes);
      offset += bytes.length;
    }
    const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: 'application/pdf' }));
    pdfBlobs.set(key, url);
    while (pdfBlobs.size > PDF_BLOB_LIMIT) {
      const [oldest, oldUrl] = pdfBlobs.entries().next().value as [string, string];
      pdfBlobs.delete(oldest);
      URL.revokeObjectURL(oldUrl);
    }
    return url;
  };

  // The language servers publish on the feed `lsp:<project>`; a project's feed is followed from its first document or request.
  const lspFollowed = new Set<string>();
  const lspWindow = {
    push(push: DesktopSectionsPush): void {
      if (push.kind !== 'sections') return;
      for (const { section, entry } of push.changes) {
        if (!entry) continue;
        const listeners = section === 'lspDiagnostics' ? diagnosticListeners : section === 'lspStatus' ? statusListeners : null;
        if (listeners) for (const listener of [...listeners]) listener(entry.value as never);
      }
    },
    notification(): void {},
    loginFeedLost(): void {},
  };
  const followLsp = async (project: string): Promise<void> => {
    if (lspFollowed.has(project)) return;
    lspFollowed.add(project);
    try {
      // A feed the core does not hold yet is followed again by the next call.
      if ((await ctx.connection.watchFeed(lspWindow, `lsp:${project}`)).absent) lspFollowed.delete(project);
    } catch {
      lspFollowed.delete(project);
    }
  };

  const api: FilesApi = {
    readEditorSettings: (projectPath, relPath, workspaceFile) =>
      direct(async () => {
        const root = await projectFolder(projectPath);
        const workspace = typeof workspaceFile === 'string' && workspaceFile.trim() ? workspaceFile : undefined;
        return op('readScopedEditorSettings', [null, root, relPath, workspace]);
      }),
    startProject: (projectPath) => direct(() => svc('startProject', [projectPath])),
    startProjectTask: (projectPath) => direct(() => svc('startProjectTask', [projectPath])),
    startTask: () => direct(() => svc('startTask', [])),
    listProjects: () => direct(() => svc('listProjects', [])),
    addProject: (projectPath) => direct(async () => announceProjectsChanged(await svc('addProject', [projectPath]))),
    renameProject: (projectPath, alias) =>
      direct(async () => announceProjectsChanged(await svc('renameProject', [projectPath, alias]))),
    removeProject: (projectPath) => direct(async () => announceProjectsChanged(await svc('removeProject', [projectPath]))),
    searchWorkspaceText: (projectPath, options) =>
      direct(async () => op('searchWorkspaceTextIn', [await projectFolder(projectPath), options])),
    replaceWorkspaceText: (projectPath, options, replacement, relPaths) =>
      direct(async () => op('replaceWorkspaceTextIn', [await projectFolder(projectPath), options, replacement, relPaths])),
    // The @ palette (the only caller listing folders) is one search at a time per window: its next keystroke supersedes
    // the previous one. The connection is this window's, so the key needs no window id.
    searchProjectFiles: (projectIdOrWorkspaceId, query, limit, includeIgnored, includeDirectories) =>
      direct(() =>
        svc('searchProjectFiles', [
          projectIdOrWorkspaceId,
          query,
          limit ?? 50,
          includeIgnored === true,
          includeDirectories === true,
          includeDirectories === true ? 'mention' : undefined,
        ])
      ),
    libreOfficeStatus: (refresh) => direct(() => op('libreOfficeStatus', [refresh === true])),
    installLibreOffice: () => direct(() => op('installLibreOffice', [])),
    githubStarStatus: () => direct(() => op('githubStarStatus', [])),
    starGithub: () => direct(() => op('starGithub', [])),
    submitFeedback: (input) => direct(() => ctx.call('feedback/upload', { input }) as Promise<never>),

    listProjectDir: (projectPath, relDir) => {
      const rel = typeof relDir === 'string' ? relDir : '';
      return direct(() =>
        onRoot(
          projectPath,
          () => svc('listProjectDir', [projectPath, rel]),
          (folder) => op('listProjectDirIn', [folder, rel])
        )
      );
    },
    previewProjectFile: (projectPath, relPath, accessToken) =>
      direct(async () => {
        const target = await fileTarget(projectPath, relPath, accessToken);
        const preview = (await ctx.call('projectFs/previewFile', target)) as {
          kind: 'image' | 'pdf' | 'audio' | 'video';
          mime: string;
          mtimeMs: number;
          size: number;
          mediaAssetId?: string;
        };
        const { mediaAssetId, ...info } = preview;
        const url = mediaAssetId ? mediaAssetUrl(mediaAssetId) : await pdfUrl(target, `${info.mtimeMs}:${info.size}`);
        return { url, ...info };
      }),
    captureFileSnapshot: (projectPath, relPath, accessToken) =>
      direct(async () => {
        // A server window's files live on the server, out of this PC's reach.
        if (serverWindow()) throw new Error('Snapshots are not available for server files.');
        return ctx.call('projectFs/captureSnapshot', await fileTarget(projectPath, relPath, accessToken)) as Promise<never>;
      }),
    previewDocumentFile: (projectPath, relPath, accessToken) =>
      direct(async () => {
        const place = await documentPlace(projectPath, relPath, accessToken);
        const converted = (await op('documentPreviewIn', [place.root, place.rel])) as {
          path: string;
          format: string;
          mtimeMs: number;
          size: number;
        };
        // The converted PDF sits in the core's cache: its folder and name are what the range reads take.
        const cut = Math.max(converted.path.lastIndexOf('/'), converted.path.lastIndexOf('\\'));
        const url = await pdfUrl(
          { root: converted.path.slice(0, cut), rel: converted.path.slice(cut + 1) },
          `${converted.mtimeMs}:${converted.size}`
        );
        return { url, kind: 'pdf' as const, mime: 'application/pdf', format: converted.format, mtimeMs: converted.mtimeMs, size: converted.size };
      }),
    previewDocumentPages: (projectPath, relPath, accessToken, options) =>
      direct(async () => {
        const place = await documentPlace(projectPath, relPath, accessToken);
        return op('documentPreviewPagesIn', [place.root, place.rel, options ?? {}]);
      }),
    readEditorBackup: (projectPath, relPath, accessToken) =>
      direct(async () => op('readEditorBackup', [null, await entryPath(projectPath, relPath, accessToken)])),
    writeEditorBackup: (projectPath, relPath, content, expectedContent, accessToken) =>
      direct(async () =>
        op('writeEditorBackup', [null, await entryPath(projectPath, relPath, accessToken), content, expectedContent])
      ),
    deleteEditorBackup: (projectPath, relPath, accessToken) =>
      direct(async () => {
        await op('deleteEditorBackup', [null, await entryPath(projectPath, relPath, accessToken)]);
      }),
    statProjectFile: (projectPath, relPath, accessToken) =>
      direct(() =>
        hasToken(accessToken)
          ? (ctx.call('projectFs/stat', { root: projectPath, rel: relPath, accessToken }) as Promise<never>)
          : onRoot(
              projectPath,
              async () => svc('statProjectFile', [projectPath, relPath]),
              (folder) => op('statProjectFileIn', [folder, relPath])
            )
      ),
    createProjectEntry: (projectPath, relDir, name, dir) => {
      const dirRel = typeof relDir === 'string' ? relDir : '';
      return direct(() =>
        onRoot(
          projectPath,
          () => svc('createProjectEntry', [projectPath, dirRel, name, dir === true]),
          (folder) => op('createProjectEntryIn', [folder, dirRel, name, dir === true])
        )
      );
    },
    renameProjectEntry: (projectPath, relPath, newName) =>
      direct(() =>
        onRoot(
          projectPath,
          () => svc('renameProjectEntry', [projectPath, relPath, newName]),
          (folder) => op('renameProjectEntryIn', [folder, relPath, newName])
        )
      ),
    trashProjectEntry: (projectPath, relPath, options) =>
      direct(async () => {
        if (serverWindow()) {
          // The server's trash, or - only when the renderer asked for it after saying so - a permanent delete. This PC's
          // recycle bin is never used.
          const permanent = (options as { permanent?: unknown } | undefined)?.permanent === true;
          await op('serverTrashEntry', [await projectFolder(projectPath), relPath, permanent]);
          return;
        }
        // The core confines the path and claims it, then asks this window's process to move it to the OS trash.
        await op('trashProjectEntryIn', [await projectRoot(projectPath), relPath]);
      }),
    moveProjectEntry: (projectPath, relPath, targetDirRel) => {
      const target = typeof targetDirRel === 'string' ? targetDirRel : '';
      return direct(() =>
        onRoot(
          projectPath,
          () => svc('moveProjectEntry', [projectPath, relPath, target]),
          (folder) => op('moveProjectEntryIn', [folder, relPath, target])
        )
      );
    },
    copyProjectEntry: (projectPath, relPath, targetDirRel) => {
      const target = typeof targetDirRel === 'string' ? targetDirRel : '';
      return direct(() =>
        onRoot(
          projectPath,
          () => svc('copyProjectEntry', [projectPath, relPath, target]),
          (folder) => op('copyProjectEntryIn', [folder, relPath, target])
        )
      );
    },
    codeGraphQuery: (projectPath, mode, symbol) => direct(() => svc('codeGraphQuery', [projectPath, mode, symbol])),
    lspDocument: (input) =>
      direct(async () => {
        const state = await op('lspDocument', [input.projectPath, await projectFolder(input.projectPath), input]);
        void followLsp(input.projectPath);
        return state;
      }),
    lspRequest: (input) =>
      direct(async () => {
        const root = await projectFolder(input.projectPath);
        const result = await op('lspRequest', [
          input.projectPath,
          root,
          input.relPath,
          input.languageId,
          input.method,
          input.params ?? {},
        ]);
        void followLsp(input.projectPath);
        return result;
      }),
    lspApplyWorkspaceEdit: (projectPath, writes) =>
      direct(async () => op('writeProjectTextFilesIn', [await projectFolder(projectPath), writes])),
    projectRecovery: (projectPath, input) =>
      direct(async () => {
        const root = await svc<string>('projectRecoveryDirectory', [projectPath]);
        return op('projectRecoveryIn', [root, input]);
      }),
    readProjectFile: (projectPath, relPath, accessToken) =>
      direct(() =>
        hasToken(accessToken)
          ? (ctx.call('projectFs/readText', { root: projectPath, rel: relPath, accessToken }) as Promise<never>)
          : onRoot(
              projectPath,
              () => svc('readProjectTextFile', [projectPath, relPath]),
              (folder) => op('readProjectTextFileIn', [folder, relPath])
            )
      ),
    writeProjectFile: (projectPath, relPath, content, expectedContent, accessToken, encoding) =>
      direct(() => {
        const fileEncoding = encoding ?? undefined;
        if (hasToken(accessToken)) {
          return ctx.call('projectFs/writeText', {
            root: projectPath,
            rel: relPath,
            content,
            expectedContent,
            accessToken,
            ...(fileEncoding === undefined ? {} : { encoding: fileEncoding }),
          }) as Promise<never>;
        }
        return onRoot(
          projectPath,
          () => svc('writeProjectTextFile', [projectPath, relPath, content, expectedContent, fileEncoding]),
          (folder) => op('writeProjectTextFileIn', [folder, relPath, content, expectedContent, fileEncoding])
        );
      }),
    readLocalFile: (path) => direct(() => op('readLocalFileAbs', [path])),
    folderWatch: (dir, recursive) => direct(async () => void (await op('folderWatch', [dir, recursive === true]))),
    folderUnwatch: (dir, recursive) => direct(async () => void (await op('folderUnwatch', [dir, recursive === true]))),
    subscribeFolderChanges: (listener) => {
      folderListeners.add(listener);
      return () => {
        folderListeners.delete(listener);
      };
    },
    subscribeLspDiagnostics: (listener) => {
      diagnosticListeners.add(listener as (event: never) => void);
      return () => {
        diagnosticListeners.delete(listener as (event: never) => void);
      };
    },
    subscribeLspStatus: (listener) => {
      statusListeners.add(listener as (event: never) => void);
      return () => {
        statusListeners.delete(listener as (event: never) => void);
      };
    },
  };
  return api;
}
