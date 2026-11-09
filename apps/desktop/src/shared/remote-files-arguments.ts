// The argument checks Node's remote methods ran on the Files and editor calls before they reached the desktop (ipc-validation.ts,
// host-directories.ts at b6f10295a), with the same error texts. The phone's adapter makes them before it sends a protocol request.
import { DESKTOP_LSP_REQUEST_METHODS } from './contract-workspace';
import { requiredString } from './remote-arguments';

const MAX_TEXT_FILE_LENGTH = 4_194_304;
const HOST_DIRECTORY_PATH_MAX = 32_768;

const hasControlCharacter = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

/** Windows and POSIX both: a drive with a separator, a UNC share or a rooted path. */
export const isAbsoluteHostPath = (path: string): boolean => /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path);

export function projectDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('alias must be a string.');
  const text = value.trim();
  if (text.length > 120 || hasControlCharacter(text)) throw new TypeError('alias is invalid.');
  return text;
}

/** `validatedHostDirectoryPath`: an empty path is the host user's home, which only the host knows (sent as ''). */
export function hostDirectoryPath(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('path must be a string.');
  if (value.length > HOST_DIRECTORY_PATH_MAX) throw new TypeError('path is too long.');
  const path = value.trim();
  if (!path) return '';
  if (path.includes('\0')) throw new TypeError('path is invalid.');
  if (/^[\\/]{2}[?.][\\/]/.test(path)) throw new TypeError('path is invalid.');
  if (!isAbsoluteHostPath(path)) throw new TypeError('path must be absolute.');
  return path;
}

export function fileSearchLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 200) throw new TypeError('limit is invalid.');
  return value as number;
}

export function textFileContent(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT_FILE_LENGTH) throw new TypeError(`${name} is invalid.`);
  return value;
}

export type TextFileEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be';
export function textFileEncoding(value: unknown): TextFileEncoding | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'utf8' || value === 'utf8bom' || value === 'utf16le' || value === 'utf16be') return value;
  throw new TypeError('file encoding is invalid.');
}

const allowedKeys = (input: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void => {
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError(`${name} contains an unsupported field.`);
};
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

const WORKSPACE_SEARCH_KEYS = new Set(['query', 'include', 'exclude', 'matchCase', 'wholeWord', 'regex', 'maxResults']);
export interface WorkspaceSearchOptions {
  query: string;
  include?: string;
  exclude?: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  maxResults: number;
}
export function workspaceSearchOptions(value: unknown): WorkspaceSearchOptions {
  if (!plainObject(value)) throw new TypeError('Workspace search options are invalid.');
  allowedKeys(value, WORKSPACE_SEARCH_KEYS, 'Workspace search options');
  const limit = value.maxResults === undefined ? 2_000 : value.maxResults;
  const query = requiredString(value.query, 'search query', 4_096);
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 5_000) throw new TypeError('maxResults is invalid.');
  return {
    query,
    ...(typeof value.include === 'string' ? { include: value.include.slice(0, 4_096) } : {}),
    ...(typeof value.exclude === 'string' ? { exclude: value.exclude.slice(0, 4_096) } : {}),
    matchCase: value.matchCase === true,
    wholeWord: value.wholeWord === true,
    regex: value.regex === true,
    maxResults: limit as number,
  };
}

/** `requiredGitPaths`: the project-relative paths a replace is limited to. */
export function relativePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) throw new TypeError('git paths are invalid.');
  return value.map((item) => {
    const path = requiredString(item, 'git path', 4_096);
    if (isAbsoluteHostPath(path) || path.includes('\0') || path.replace(/\\/g, '/').split('/').some((part) => part === '..')) {
      throw new TypeError('git path is invalid.');
    }
    return path;
  });
}

const LSP_DOCUMENT_KEYS = new Set(['kind', 'projectPath', 'relPath', 'languageId', 'version', 'content']);
const LSP_REQUEST_KEYS = new Set(['projectPath', 'relPath', 'languageId', 'method', 'params']);
const LSP_METHODS: ReadonlySet<string> = new Set(DESKTOP_LSP_REQUEST_METHODS);

export function lspDocumentInput(value: unknown) {
  if (!plainObject(value)) throw new TypeError('LSP document input is invalid.');
  allowedKeys(value, LSP_DOCUMENT_KEYS, 'LSP document input');
  if (value.kind !== 'open' && value.kind !== 'change' && value.kind !== 'save' && value.kind !== 'close') {
    throw new TypeError('LSP document kind is invalid.');
  }
  if (!Number.isInteger(value.version) || Number(value.version) < 0) throw new TypeError('LSP document version is invalid.');
  if (value.content !== undefined && (typeof value.content !== 'string' || value.content.length > MAX_TEXT_FILE_LENGTH)) {
    throw new TypeError('LSP document content is invalid.');
  }
  return {
    kind: value.kind,
    projectPath: requiredString(value.projectPath, 'projectPath'),
    relPath: requiredString(value.relPath, 'relPath', 4_096),
    languageId: requiredString(value.languageId, 'languageId', 64),
    version: Number(value.version),
    ...(typeof value.content === 'string' ? { content: value.content } : {}),
  };
}

export function lspRequestInput(value: unknown) {
  if (!plainObject(value)) throw new TypeError('LSP request input is invalid.');
  allowedKeys(value, LSP_REQUEST_KEYS, 'LSP request input');
  const method = requiredString(value.method, 'LSP method', 128);
  if (!LSP_METHODS.has(method)) throw new TypeError('LSP method is unavailable.');
  const params = value.params === undefined ? {} : value.params;
  if (!plainObject(params)) throw new TypeError('LSP params are invalid.');
  return {
    projectPath: requiredString(value.projectPath, 'projectPath'),
    relPath: requiredString(value.relPath, 'relPath', 4_096),
    languageId: requiredString(value.languageId, 'languageId', 64),
    method,
    params,
  };
}

const WORKSPACE_WRITE_KEYS = new Set(['relPath', 'content', 'expectedContent']);
export function workspaceTextWrites(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new TypeError('Workspace edit files are invalid.');
  return value.map((row) => {
    if (!plainObject(row)) throw new TypeError('Workspace edit file is invalid.');
    allowedKeys(row, WORKSPACE_WRITE_KEYS, 'Workspace edit file');
    if (
      typeof row.content !== 'string' ||
      row.content.length > MAX_TEXT_FILE_LENGTH ||
      typeof row.expectedContent !== 'string' ||
      row.expectedContent.length > MAX_TEXT_FILE_LENGTH
    ) {
      throw new TypeError('Workspace edit file content is invalid.');
    }
    return { relPath: requiredString(row.relPath, 'relPath', 4_096), content: row.content, expectedContent: row.expectedContent };
  });
}

/** `requiredWorkspaceFolders`, up to the path's resolution against the host's working folder, which the host does. */
export function workspaceFolders(value: unknown): Array<{ path: string; name?: string }> {
  if (!Array.isArray(value) || value.length > 64) throw new TypeError('Workspace folders are invalid.');
  const seen = new Set<string>();
  return value.map((row) => {
    if (!plainObject(row)) throw new TypeError('Workspace folder is invalid.');
    const path = requiredString(row.path, 'workspace folder path', 16_384);
    if (!isAbsoluteHostPath(path)) throw new TypeError('Workspace folder path must be absolute.');
    const key = path.toLocaleLowerCase();
    if (seen.has(key)) throw new TypeError('Workspace folders must be unique.');
    seen.add(key);
    return { path, ...(typeof row.name === 'string' && row.name.trim() ? { name: row.name.trim().slice(0, 200) } : {}) };
  });
}