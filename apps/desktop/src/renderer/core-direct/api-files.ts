import type { DesktopApi, SessionSnapshot } from '../../shared/contract.ts';
import type { DesktopHostExtras, DirectKey } from '../../shared/desktop-api-split.ts';
import { createOperationLane } from '../../shared/core-lanes/desktop-operation-route.ts';
import type { DesktopSectionsPush } from '../../shared/contract-sections.ts';
import { isSshConnectionWindow } from '../desktop-connection.ts';
import type { DirectContext } from './context.ts';
import type { RendererWindow } from './renderer-connection.ts';
import { sessionLanesOf } from './api-sessions.ts';
import { withDirectErrors } from './errors.ts';
import { hostPlatform } from './host-platform.ts';

export type FilesApi = Pick<DesktopApi, DirectKey<'files'>>;

export interface FilesApiOptions {
  /** The Electron host's file preview (`previewProjectFile`: a `mixdog-media` URL the main process serves by range); defaults to window.mixdogDesktopHost. */
  host?: Pick<DesktopApi, 'previewProjectFile'> & Partial<Pick<DesktopHostExtras, 'previewConvertedDocument'>>;
}

/** Node's `path.isAbsolute` on the PC (a Windows host also takes the POSIX form). */
const isAbsolutePath = (path: string): boolean => /^([\\/]|[A-Za-z]:[\\/])/.test(path);
/** Code points one window of a file read answers. A file is at most 10 MiB, so a text of up to 2 Mi code points comes in one call and
 *  the largest file in five, where windows of 80 000 took 125. The core writes an answer of any size whole when nothing else of the
 *  connection is waiting, and a read is one call after another, so a window larger than the 512 KiB control reserve is no burden. */
const READ_WINDOW_CHARS = 2_097_152;
const hasToken = (token: unknown): token is string => typeof token === 'string' && token !== '';

type FileTarget = { root: string; rel: string; accessToken?: string };

export function createFilesApi(ctx: DirectContext, options: FilesApiOptions = {}): FilesApi {
  const folderListeners = new Set<(dir: string) => void>();
  const diagnosticListeners = new Set<(event: never) => void>();
  const statusListeners = new Set<(event: never) => void>();

  // The window's one service lane and shell state (api-sessions): a start call's blank snapshot reaches `subscribeState`
  // listeners as main's startShell published it.
  const { service, shell } = sessionLanesOf(ctx);
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
  /** A start call: the blank snapshot it answers is also the window's shell snapshot. */
  const startShell = async (method: string, args: unknown[]): Promise<SessionSnapshot> => {
    const snapshot = await svc<SessionSnapshot>(method, args);
    shell.publish(snapshot);
    return snapshot;
  };
  const op = <T = never>(name: string, args: unknown[]): Promise<T> => operations.invoke(name, args) as Promise<T>;
  /** One key's work, its failure shown as the IPC path showed it. */
  const direct = <T>(run: () => Promise<T>): Promise<T> => withDirectErrors(Promise.resolve().then(run));
  // A server (ssh) window, as main's handlers knew it (their `server` files): the preload's connection identity.
  const serverWindow = (): boolean => isSshConnectionWindow();
  // The core's search sessions are shared by every connection (a second `search/start` of an id in use is refused, a
  // consumer's search supersedes that consumer's others): this window's searches carry a key of their own, as main's
  // `mention:<webContents id>` was.
  const searchKey = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join(
    ''
  );

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
  /** One answer of `projectFs/readText` carries at most 512 KiB while a file may be up to 10 MiB: the text comes a window at a time and is
   *  joined. The first window reads the file once and names that read (`readId`); the windows after it come from the same read, so the
   *  join is one version of the file. */
  const readWindows = async (target: FileTarget): Promise<Record<string, unknown>> => {
    let answer = (await ctx.call('projectFs/readText', { ...target, maxChars: READ_WINDOW_CHARS })) as Record<
      string,
      unknown
    >;
    let content = String(answer.content);
    while (typeof answer.nextChar === 'number') {
      answer = (await ctx.call('projectFs/readText', {
        ...target,
        readId: answer.readId,
        fromChar: answer.nextChar,
        maxChars: READ_WINDOW_CHARS,
      })) as Record<string, unknown>;
      content += String(answer.content);
    }
    const { nextChar: _end, readId: _read, ...whole } = answer;
    return { ...whole, content };
  };
  /** A Project and a path in it as the core takes them: a token names the file (the core redeems it), else the folder. */
  const fileTarget = async (project: string, rel: string, accessToken: unknown): Promise<FileTarget> =>
    hasToken(accessToken) ? { root: project, rel, accessToken } : { root: await projectRoot(project), rel };
  /** The folder and name a document conversion runs in: a granted file's own folder, else the Project's. */
  const documentPlace = async (
    project: string,
    rel: string,
    accessToken: unknown
  ): Promise<{ root: string; rel: string }> => {
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

  const hostPreview = (): FilesApiOptions['host'] =>
    options.host ?? (globalThis as { mixdogDesktopHost?: FilesApiOptions['host'] }).mixdogDesktopHost;

  // The language servers publish on the feed `lsp:<project>`; a project's feed is followed from its first document or request.
  let nextLspFollowToken = 0;
  const lspFollowed = new Map<string, { token: number; window: RendererWindow }>();
  const lspLiveLanguages = new Map<string, Map<string, Set<string>>>();
  const WINDOWS_PATH_SHAPE = /^(?:[A-Za-z]:[\\/]|(?:\\\\|\/\/)[^\\/])/;
  const normalizeProjectKey = (path: string): string => {
    if (!path) return '';
    if (WINDOWS_PATH_SHAPE.test(path)) {
      const slashed = path.replace(/\\/g, '/');
      if (/^[A-Za-z]:\/+$/.test(slashed)) return `${slashed.slice(0, 2).toLowerCase()}/`;
      return slashed.replace(/\/+$/, '').toLowerCase();
    }
    if (/^\/+$/.test(path)) return '/';
    return path.replace(/\/+$/, '');
  };
  const isSameOrUnderProject = (root: string, candidate: string): boolean => {
    const r = normalizeProjectKey(root);
    const c = normalizeProjectKey(candidate);
    if (!r) return false;
    if (r === '/') return c.startsWith('/') && !c.startsWith('//');
    const prefix = r.endsWith('/') ? r : `${r}/`;
    return c === r || c.startsWith(prefix);
  };
  const removeLiveStatusKey = (project: string, languageId: string, statusKey: string): boolean => {
    const languages = lspLiveLanguages.get(project);
    const keys = languages?.get(languageId);
    if (!keys?.delete(statusKey)) return false;
    if (keys.size === 0) languages?.delete(languageId);
    if (languages?.size === 0) lspLiveLanguages.delete(project);
    return true;
  };
  const createLspWindow = (project: string): RendererWindow => {
    const diagnosticsMeta = new Map<string, { projectPath: string; relPath: string; uri: string; server: string }>();
    const window: RendererWindow = {
      push(push: DesktopSectionsPush): void {
        if (push.kind !== 'sections') return;
        let shouldCheckUnfollow = false;
        for (const { section, key, entry } of push.changes) {
          if (section !== 'lspDiagnostics' && section !== 'lspStatus') continue;
          if (!entry) {
            if (section === 'lspDiagnostics' && typeof key === 'string' && key) {
              const previous = diagnosticsMeta.get(key);
              if (previous) {
                diagnosticsMeta.delete(key);
                const cleared = { ...previous, diagnostics: [] };
                for (const listener of [...diagnosticListeners]) listener(cleared as never);
              }
            } else if (section === 'lspStatus' && typeof key === 'string' && key) {
              const sep = key.indexOf('\0');
              const languageId = sep >= 0 ? key.slice(0, sep) : key;
              if (removeLiveStatusKey(project, languageId, key)) {
                shouldCheckUnfollow = true;
              }
            }
            continue;
          }
          if (section === 'lspDiagnostics') {
            const value = entry.value as {
              projectPath?: unknown;
              relPath?: unknown;
              uri?: unknown;
              server?: unknown;
              diagnostics?: unknown;
            } | null;
            if (typeof key === 'string' && key) {
              if (Array.isArray(value?.diagnostics) && value.diagnostics.length > 0) {
                diagnosticsMeta.set(key, {
                  projectPath: typeof value.projectPath === 'string' && value.projectPath ? value.projectPath : project,
                  relPath: typeof value.relPath === 'string' ? value.relPath : '',
                  uri: typeof value.uri === 'string' && value.uri ? value.uri : key,
                  server: typeof value.server === 'string' ? value.server : '',
                });
              } else {
                diagnosticsMeta.delete(key);
              }
            }
            for (const listener of [...diagnosticListeners]) listener(entry.value as never);
            continue;
          }
          const status = entry.value as {
            projectPath?: unknown;
            languageId?: unknown;
            status?: unknown;
          } | null;
          if (typeof status?.languageId === 'string' && status.languageId) {
            const statusKey = typeof key === 'string' && key ? key : status.languageId;
            if (status.status === 'stopped') {
              const languages = lspLiveLanguages.get(project);
              languages?.delete(status.languageId);
              if (languages?.size === 0) lspLiveLanguages.delete(project);
              shouldCheckUnfollow = true;
            } else if (status.status === 'ready' || status.status === 'starting') {
              let languages = lspLiveLanguages.get(project);
              if (!languages) {
                languages = new Map();
                lspLiveLanguages.set(project, languages);
              }
              let keys = languages.get(status.languageId);
              if (!keys) {
                keys = new Set();
                languages.set(status.languageId, keys);
              }
              keys.add(statusKey);
            } else {
              removeLiveStatusKey(project, status.languageId, statusKey);
            }
          }
          for (const listener of [...statusListeners]) listener(entry.value as never);
        }
        if (shouldCheckUnfollow && (lspLiveLanguages.get(project)?.size ?? 0) === 0) unfollowLsp(project);
      },
      notification(): void {},
      loginFeedLost(): void {},
      feedLost(): void {
        if (lspFollowed.get(project)?.window === window) {
          lspFollowed.delete(project);
          lspLiveLanguages.delete(project);
        }
      },
    };
    return window;
  };
  const unfollowLsp = (project: string): void => {
    lspLiveLanguages.delete(project);
    const entry = lspFollowed.get(project);
    if (!entry) return;
    lspFollowed.delete(project);
    void ctx.connection.unwatchFeed(entry.window, `lsp:${project}`).catch(() => undefined);
  };
  const unfollowLspUnder = (root: string): void => {
    for (const project of [...lspFollowed.keys()]) {
      if (isSameOrUnderProject(root, project)) unfollowLsp(project);
    }
  };
  const readProjectPaths = (): Map<string, string> | null => {
    const raw = ctx.connection.protocolClient()?.store.section('projects', null)?.value;
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { projects?: unknown }).projects)
        ? (raw as { projects: unknown[] }).projects
        : null;
    if (!list) return null;
    const paths = new Map<string, string>();
    for (const item of list) {
      const path = item && typeof item === 'object' ? (item as { path?: unknown }).path : null;
      if (typeof path === 'string' && path) paths.set(normalizeProjectKey(path), path);
    }
    return paths;
  };
  let knownProjects = readProjectPaths();
  ctx.connection.onStoreChange((change) => {
    if (change.type !== 'appSnapshot' && !(change.type === 'section' && change.section === 'projects')) return;
    const next = readProjectPaths();
    if (knownProjects && next) {
      for (const [key, path] of knownProjects) {
        if (!next.has(key)) unfollowLspUnder(path);
      }
    }
    if (next) knownProjects = next;
  });
  const followLsp = async (project: string, options?: { refresh?: boolean }): Promise<void> => {
    const refresh = options?.refresh === true;
    const existing = lspFollowed.get(project);
    if (!refresh && existing) return;
    const token = ++nextLspFollowToken;
    const window = existing?.window ?? createLspWindow(project);
    lspFollowed.set(project, { token, window });
    try {
      // A feed the core does not hold yet is followed again by the next call.
      const { absent } = await ctx.connection.watchFeed(
        window,
        `lsp:${project}`,
        refresh ? { refresh: true } : undefined
      );
      if (absent) {
        if (lspFollowed.get(project)?.token === token) {
          lspFollowed.delete(project);
          lspLiveLanguages.delete(project);
        }
      } else if (lspFollowed.get(project)?.token !== token && !lspFollowed.has(project)) {
        void ctx.connection.unwatchFeed(window, `lsp:${project}`).catch(() => undefined);
      }
    } catch {
      if (lspFollowed.get(project)?.token === token) {
        lspFollowed.delete(project);
        lspLiveLanguages.delete(project);
      }
    }
  };

  const api: FilesApi = {
    readEditorSettings: (projectPath, relPath, workspaceFile) =>
      direct(async () => {
        const root = await projectFolder(projectPath);
        const workspace = typeof workspaceFile === 'string' && workspaceFile.trim() ? workspaceFile : undefined;
        return op('readScopedEditorSettings', [null, root, relPath, workspace]);
      }),
    startProject: (projectPath) => direct(() => startShell('startProject', [projectPath])),
    startProjectTask: (projectPath) => direct(() => startShell('startProjectTask', [projectPath])),
    startTask: () => direct(() => startShell('startTask', [])),
    listProjects: () => direct(() => svc('listProjects', [])),
    addProject: (projectPath) => direct(async () => announceProjectsChanged(await svc('addProject', [projectPath]))),
    renameProject: (projectPath, alias) =>
      direct(async () => announceProjectsChanged(await svc('renameProject', [projectPath, alias]))),
    removeProject: (projectPath) =>
      direct(async () => {
        const result = await svc('removeProject', [projectPath]);
        unfollowLspUnder(projectPath);
        return announceProjectsChanged(result);
      }),
    searchWorkspaceText: (projectPath, options) =>
      direct(async () => op('searchWorkspaceTextIn', [await projectFolder(projectPath), options])),
    replaceWorkspaceText: (projectPath, options, replacement, relPaths) =>
      direct(async () =>
        op('replaceWorkspaceTextIn', [await projectFolder(projectPath), options, replacement, relPaths])
      ),
    // The @ palette (the only caller listing folders) is one search at a time per window: its next keystroke supersedes
    // the previous one. Every other search of this window has its own session too.
    searchProjectFiles: (projectIdOrWorkspaceId, query, limit, includeIgnored, includeDirectories) =>
      direct(() =>
        svc('searchProjectFiles', [
          projectIdOrWorkspaceId,
          query,
          limit ?? 50,
          includeIgnored === true,
          includeDirectories === true,
          includeDirectories === true ? `mention:${searchKey}` : `files:${searchKey}`,
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
    captureFileSnapshot: (projectPath, relPath, accessToken) =>
      direct(async () => {
        // A server window's files live on the server, out of this PC's reach.
        if (serverWindow()) throw new Error('Snapshots are not available for server files.');
        return ctx.call(
          'projectFs/captureSnapshot',
          await fileTarget(projectPath, relPath, accessToken)
        ) as Promise<never>;
      }),
    previewDocumentFile: (projectPath, relPath, accessToken) =>
      direct(async () => {
        // The main process converts and registers the PDF with its source, so a PDF the core's cache evicted is converted again.
        const convert = hostPreview()?.previewConvertedDocument;
        if (!convert) throw new Error('This window cannot show a document preview.');
        return convert(projectPath, relPath, hasToken(accessToken) ? accessToken : undefined);
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
        void followLsp(input.projectPath, input.kind === 'open' ? { refresh: true } : undefined);
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
          ? (readWindows({ root: projectPath, rel: relPath, accessToken }) as Promise<never>)
          : onRoot(
              projectPath,
              async () => readWindows({ root: await projectFolder(projectPath), rel: relPath }) as Promise<never>,
              async (folder) => readWindows({ root: folder, rel: relPath }) as Promise<never>
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
