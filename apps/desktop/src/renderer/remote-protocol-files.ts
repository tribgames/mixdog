// The phone's "Files and editor" and "Project list" calls (Node's `listProjects` ... `writeProjectFile`, `searchProjectFiles`,
// `lspRequest`, `previewProjectFile`), answered over the protocol. Each equals what Node's remote methods gave the page
// (b6f10295a: remote-methods.ts `workspaceRemoteMethods` / `projectEntryRemoteMethods` / `editorRemoteMethods`,
// remote-file-preview.ts, remote-local-page.ts): the same argument checks and texts (shared/remote-files-arguments.ts), the same
// answer and the same failure, with the error's `code` Node put on the frame. The replay in apps/mobile compares them with the
// recording. The connection's one call queue (remote-protocol-queue.ts) orders them, entered by the router (remote-shim-protocol.ts)
// for every adapter alike, as Node's was: nothing here queues.
import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import { requiredString } from '../shared/remote-arguments';
import {
  fileSearchLimit,
  hostDirectoryPath,
  lspDocumentInput,
  lspRequestInput,
  projectDisplayName,
  relativePaths,
  textFileContent,
  textFileEncoding,
  workspaceFolders,
  workspaceSearchOptions,
  workspaceTextWrites,
} from '../shared/remote-files-arguments';
import type { NodeCall, PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';

type Client = ProtocolClient<SessionFold>;
type Params = Record<string, unknown>;

const DESKTOP_UNAVAILABLE = 'The desktop app is unavailable on this connection.';
// 60 000 code points are at most 360 000 bytes on the wire (a control character escapes to six), under a connection's 512 KiB per answer.
const READ_WINDOW_CHARS = 60_000;
const FILE_CHANGED = 'File changed on disk. Reload or keep your edits before saving.';

/** What a domain failure was to Node's page: the error's text, and its `code` when Node's error had one (a system error's
 *  `ENOENT`, `PROJECT_UNAVAILABLE`, ...). The core names those codes in capitals; its own reasons are camel case. A call that needs the
 *  PC's window while none is connected is Node's "unavailable" TypeError. */
function failure(error: unknown): unknown {
  const data = (error as { detail?: { data?: Record<string, unknown> } } | null)?.detail?.data;
  if (!data) return error;
  if (data.reason === 'capabilityUnavailable' && data.capability === 'desktopHost') return new TypeError(DESKTOP_UNAVAILABLE);
  // A refused argument names its sentence (Node's TypeError text); a stale save is Node's one sentence for it.
  if (data.reason === 'invalidParams' && typeof data.expected === 'string' && data.expected) return new TypeError(data.expected);
  if (data.reason === 'preconditionFailed') return new Error(FILE_CHANGED);
  if (data.reason !== 'domainError') return error;
  const text = data.message;
  if (typeof text !== 'string' || !text) return error;
  // A folder that does not exist: the core gives the path as the caller wrote it, which is all the OS error names.
  if (data.code === 'pathMissing') return Object.assign(new Error(`ENOENT: no such file or directory, realpath '${text}'`), { code: 'ENOENT' });
  const rebuilt: Error & { code?: string } = new Error(text);
  // The preview worker's refusals are plain Errors in Node; their code only routes the text through the core.
  const plainInNode = data.code === 'NO_PREVIEW_FOR_TYPE' || data.code === 'NOT_A_FILE' || data.code === 'PATH_OUTSIDE_PROJECT' || data.code === 'HOST_COMMAND_FAILED';
  if (!plainInNode && typeof data.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(data.code)) rebuilt.code = data.code;
  return rebuilt;
}

const rpc = async (host: PhoneProtocolHost, method: string, params: Params): Promise<any> => {
  try {
    // `nodeErrors` (projectFs calls only; the other methods' params are closed): this is the phone's call, so an entry beyond its project is
    // answered as Node's plain `Error`, not the core's permission refusal.
    return await (host.client().call as (m: string, p: unknown) => Promise<unknown>)(method, method.startsWith('projectFs/') ? { ...params, nodeErrors: true } : params);
  } catch (error) {
    throw failure(error);
  }
};

/** `remoteFileTarget`: a one-file permission names the file by its token (the core redeems it), else a project and a path in it. */
function fileTarget(projectPath: unknown, relPath: unknown, accessToken: unknown): Params {
  if (typeof accessToken === 'string' && accessToken.length > 0) {
    const token = requiredString(accessToken, 'file access token', 128);
    return { root: requiredString(projectPath, 'projectPath'), rel: requiredString(relPath, 'relPath'), accessToken: token };
  }
  return { root: requiredString(projectPath, 'projectPath'), rel: requiredString(relPath, 'relPath', 4_096) };
}

const void_ = async (promise: Promise<unknown>): Promise<null> => {
  await promise;
  return null;
};

/** The folder and name of a granted file (Node's `remoteFileTarget`: `root` is the granted file's folder, `rel` its name). */
async function grantedPlace(host: PhoneProtocolHost, target: Params): Promise<{ root: string; rel: string }> {
  const { path } = (await rpc(host, 'projectFs/entryPath', target)) as { path: string };
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return { root: path.slice(0, cut), rel: path.slice(cut + 1) };
}

let nextSearch = 1;

async function searchFiles(host: PhoneProtocolHost, root: string, query: string, limit: number, ignored: boolean, directories: boolean): Promise<string[]> {
  const client: Client = host.client();
  const sessionId = `phone-search-${nextSearch++}`;
  let files: string[] = [];
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => (finish = resolve));
  const off = client.on((event) => {
    if (event.type !== 'notification') return;
    const { method, params } = event.notification as { method: string; params?: { sessionId?: string; query?: string; files?: Array<{ path: string; matchType: string }> } };
    if (params?.sessionId !== sessionId) return;
    // A folder's path ends with a slash, as Node's file search names it.
    if (method === 'search/updated' && params.query === query) files = (params.files ?? []).map((row) => (row.matchType === 'directory' ? `${row.path}/` : row.path));
    else if (method === 'search/completed' && params.query === query) finish();
  });
  try {
    await rpc(host, 'search/start', { sessionId, roots: [root], limit, includeIgnored: ignored, includeDirectories: directories });
    try {
      await rpc(host, 'search/update', { sessionId, query });
      await completed;
    } finally {
      await rpc(host, 'search/stop', { sessionId }).catch(() => undefined);
    }
  } finally {
    off();
  }
  return files;
}

export const adapter: PhoneProtocolAdapter = {
  group: 'files',
  calls: {
    // ── the project list ──
    listProjects: async (_params, host) =>
      ((await rpc(host, 'project/list', {})).projects as Array<{ name: string; path: string; alias: string | null }>).map(({ name, path, alias }) => ({
        name,
        path,
        alias,
      })),
    addProject: ([projectPath], host) => {
      const path = requiredString(projectPath, 'projectPath');
      return void_(rpc(host, 'project/create', { path }));
    },
    renameProject: ([projectPath, alias], host) => {
      const path = requiredString(projectPath, 'projectPath');
      const display = projectDisplayName(alias);
      return void_(rpc(host, 'project/update', { path, alias: display }));
    },
    removeProject: ([projectPath], host) => {
      const path = requiredString(projectPath, 'projectPath');
      return (async () => {
        // The core's delete is idempotent; Node's registry refuses a project that is not registered.
        const { removed } = (await rpc(host, 'project/delete', { path })) as { removed: boolean };
        if (!removed) throw Object.assign(new Error('Project is not available.'), { code: 'PROJECT_UNAVAILABLE' });
      })();
    },
    listHostDirectories: ([path], host) => {
      const checked = hostDirectoryPath(path);
      return rpc(host, 'projectFs/browseDirs', { path: checked });
    },
    listProjectDir: ([projectPath, relDir], host) => {
      const root = requiredString(projectPath, 'projectPath');
      return rpc(host, 'projectFs/listDir', { root, rel: typeof relDir === 'string' ? relDir : '' });
    },
    // ── files ──
    readProjectFile: ([projectPath, relPath, accessToken], host) => {
      const target = fileTarget(projectPath, relPath, accessToken);
      return (async () => {
        // One answer carries at most 512 KiB, a file up to 10 MiB: the text comes a window at a time and is joined. The first window reads
        // the file once and names that read (`readId`); the windows after it come from the same read, so the join is one version of the file.
        let answer = (await rpc(host, 'projectFs/readText', { ...target, authorized: true, maxChars: READ_WINDOW_CHARS })) as Params;
        let content = String(answer.content);
        while (typeof answer.nextChar === 'number') {
          answer = (await rpc(host, 'projectFs/readText', {
            ...target,
            authorized: true,
            readId: answer.readId,
            fromChar: answer.nextChar,
            maxChars: READ_WINDOW_CHARS,
          })) as Params;
          content += String(answer.content);
        }
        const { nextChar: _end, readId: _read, ...whole } = answer;
        return { ...whole, content };
      })();
    },
    statProjectFile: ([projectPath, relPath, accessToken], host) => {
      const target = fileTarget(projectPath, relPath, accessToken);
      return rpc(host, 'projectFs/stat', target);
    },
    writeProjectFile: ([projectPath, relPath, content, expectedContent, accessToken, encoding], host) => {
      const text = textFileContent(content, 'file content');
      const expected = textFileContent(expectedContent, 'expected file content');
      const fileEncoding = textFileEncoding(encoding);
      const target = fileTarget(projectPath, relPath, accessToken);
      return rpc(host, 'projectFs/writeText', { ...target, content: text, expectedContent: expected, ...(fileEncoding ? { encoding: fileEncoding } : {}) });
    },
    createProjectEntry: ([projectPath, relDir, name, dir], host) => {
      const root = requiredString(projectPath, 'projectPath');
      const entryName = requiredString(name, 'name');
      return void_(rpc(host, 'projectFs/create', { root, relDir: typeof relDir === 'string' ? relDir : '', name: entryName, directory: dir === true }));
    },
    renameProjectEntry: ([projectPath, relPath, newName], host) => {
      const root = requiredString(projectPath, 'projectPath');
      const rel = requiredString(relPath, 'relPath');
      const name = requiredString(newName, 'newName');
      return void_(rpc(host, 'projectFs/rename', { root, rel, newName: name }));
    },
    moveProjectEntry: ([projectPath, relPath, targetDirRel], host) => {
      const root = requiredString(projectPath, 'projectPath');
      const rel = requiredString(relPath, 'relPath');
      return void_(rpc(host, 'projectFs/move', { root, rel, targetDirRel: typeof targetDirRel === 'string' ? targetDirRel : '' }));
    },
    copyProjectEntry: ([projectPath, relPath, targetDirRel], host) => {
      const root = requiredString(projectPath, 'projectPath');
      const rel = requiredString(relPath, 'relPath');
      return rpc(host, 'projectFs/copy', { root, rel, targetDirRel: typeof targetDirRel === 'string' ? targetDirRel : '' });
    },
    // The OS trash is the PC window's: the core confines the path, then asks the window.
    trashProjectEntry: ([projectPath, relPath], host) => {
      const root = requiredString(projectPath, 'projectPath');
      const rel = requiredString(relPath, 'relPath');
      return void_(rpc(host, 'projectFs/trash', { root, rel, viaHost: true }));
    },
    // ── the editor's own storage ──
    readEditorSettings: ([projectPath, relPath, workspaceFile], host) => {
      const root = requiredString(projectPath, 'projectPath');
      const workspace = typeof workspaceFile === 'string' && workspaceFile.trim() ? workspaceFile : undefined;
      const rel = requiredString(relPath, 'relPath', 4_096);
      return rpc(host, 'projectFs/readEditorSettings', { root, rel, ...(workspace === undefined ? {} : { workspaceFile: workspace }) });
    },
    readEditorBackup: ([projectPath, relPath, accessToken], host) => {
      const target = fileTarget(projectPath, relPath, accessToken);
      return (async () => {
        const { path } = await rpc(host, 'projectFs/entryPath', target);
        return rpc(host, 'projectFs/backup/read', { sourcePath: path });
      })();
    },
    writeEditorBackup: ([projectPath, relPath, content, expectedContent, accessToken], host) => {
      const target = fileTarget(projectPath, relPath, accessToken);
      const text = textFileContent(content, 'file content');
      const expected = textFileContent(expectedContent, 'expected file content');
      return (async () => {
        const { path } = await rpc(host, 'projectFs/entryPath', target);
        return rpc(host, 'projectFs/backup/write', { sourcePath: path, content: text, expectedContent: expected });
      })();
    },
    deleteEditorBackup: ([projectPath, relPath, accessToken], host) => {
      const target = fileTarget(projectPath, relPath, accessToken);
      return (async () => {
        const { path } = await rpc(host, 'projectFs/entryPath', target);
        await rpc(host, 'projectFs/backup/delete', { sourcePath: path });
        return null;
      })();
    },
    saveWorkspace: ([workspaceFile, rawFolders], host) => {
      const folders = workspaceFolders(rawFolders);
      if (!(typeof workspaceFile === 'string' && workspaceFile.trim())) {
        throw new Error('Choosing a workspace file is available in the desktop app only.');
      }
      return rpc(host, 'projectFs/workspaceFile/write', { workspaceFile, folders });
    },
    codeGraphQuery: ([projectPath, mode, symbol], host) => {
      if (mode !== 'find_symbol' && mode !== 'references' && mode !== 'symbols') throw new TypeError('mode is invalid.');
      const path = requiredString(projectPath, 'projectPath');
      const query = requiredString(symbol, 'symbol');
      return rpc(host, 'project/codeGraph', { path, mode, query });
    },
    // ── search ──
    searchWorkspaceText: ([projectPath, rawOptions], host) => {
      const root = requiredString(projectPath, 'projectPath');
      const options = workspaceSearchOptions(rawOptions);
      return rpc(host, 'projectFs/searchText', { root, options });
    },
    replaceWorkspaceText: ([projectPath, rawOptions, replacement, relPaths], host) => {
      const root = requiredString(projectPath, 'projectPath');
      if (typeof replacement !== 'string' || replacement.length > 1_000_000) throw new TypeError('Replacement text is invalid.');
      const files = relPaths === undefined ? undefined : relativePaths(relPaths);
      const options = workspaceSearchOptions(rawOptions);
      return rpc(host, 'projectFs/replaceText', { root, options, replacement, ...(files ? { relPaths: files } : {}) });
    },
    searchProjectFiles: (params, host) => {
      const [project, query, limit, includeIgnored, includeDirectories] = params;
      if (typeof query !== 'string' || query.length > 1_024) throw new TypeError('query is invalid.');
      const root = requiredString(project, 'projectIdOrWorkspaceId');
      const count = fileSearchLimit(limit);
      return searchFiles(host, root, query, count, includeIgnored === true, includeDirectories === true);
    },
    // ── the language servers ──
    lspDocument: ([rawInput], host) => {
      const input = lspDocumentInput(rawInput);
      return rpc(host, 'lsp/document', { projectPath: input.projectPath, root: input.projectPath, document: input });
    },
    lspRequest: ([rawInput], host) => {
      const input = lspRequestInput(rawInput);
      return rpc(host, 'lsp/request', {
          projectPath: input.projectPath,
          root: input.projectPath,
          request: { relPath: input.relPath, languageId: input.languageId, method: input.method, params: input.params },
        });
    },
    lspApplyWorkspaceEdit: ([projectPath, rawWrites], host) => {
      const root = requiredString(projectPath, 'projectPath');
      const files = workspaceTextWrites(rawWrites);
      return void_(rpc(host, 'projectFs/writeTextBatch', { root, files }));
    },
    // ── previews ──
    previewProjectFile: ([projectPath, relPath, accessToken], host) => {
      const target = fileTarget(projectPath, relPath, accessToken);
      return rpc(host, 'projectFs/previewFile', target);
    },
    previewProjectFileRange: ([projectPath, relPath, accessToken, offset, length], host) => {
      // Arguments are checked before any path work.
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new TypeError('offset is invalid.');
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1 || length > 4 * 1024 * 1024) {
        throw new TypeError('length is invalid.');
      }
      const target = fileTarget(projectPath, relPath, accessToken);
      return rpc(host, 'projectFs/previewRange', { ...target, offset, length });
    },
    previewDocumentPages: ([projectPath, relPath, accessToken, options], host) => {
      const target = fileTarget(projectPath, relPath, accessToken);
      const request = options && typeof options === 'object' ? (options as { pages?: unknown; maxWidth?: unknown; password?: unknown }) : {};
      return (async () => {
        // A one-file permission names a file outside every project: the conversion runs on that file's own folder.
        const place = target.accessToken === undefined ? { root: target.root, rel: target.rel } : await grantedPlace(host, target);
        return rpc(host, 'document/previewPages', {
          ...place,
          options:
            request.password === undefined
              ? { pages: request.pages, maxWidth: request.maxWidth }
              : { pages: request.pages, maxWidth: request.maxWidth, password: request.password },
        });
      })();
    },
    captureFileSnapshot: ([projectPath, relPath, accessToken], host) => {
      const target = fileTarget(projectPath, relPath, accessToken);
      return rpc(host, 'projectFs/captureSnapshot', target);
    },
    localPageUrl: ([projectPath, relPath, accessToken], host) => {
      const target = fileTarget(projectPath, relPath, accessToken);
      return rpc(host, 'projectFs/localPageUrl', target);
    },
  },
};