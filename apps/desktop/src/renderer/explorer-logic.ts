// VS Code Explorer grammar, ported from C:\Project\refs\vscode —
// fileActions.ts validateFileName/getWellFormedFileName, base/common/
// extpath.ts isValidBasename, explorerViewer.ts FileSorter (default order),
// and the paste-collision naming from fileImportExport. Pure logic module:
// unit-tested directly by renderer.test.mjs.

export interface ExplorerNameProblem {
  content: string;
  severity: 'error' | 'warning';
}

const WINDOWS_INVALID_FILE_CHARS = /[\\/:*?"<>|]/;
const UNIX_INVALID_FILE_CHARS = /[/]/;
const WINDOWS_FORBIDDEN_NAMES = /^(con|prn|aux|clock\$|nul|lpt[0-9]|com[0-9])(\.(.*?))?$/i;

const runtimeIsWindows: boolean = typeof navigator === 'object'
  && Boolean((navigator as { platform?: string }).platform)
  ? /win/i.test(String((navigator as { platform?: string }).platform))
  : (globalThis as { process?: { platform?: string } }).process?.platform === 'win32';

/** fileActions.ts getWellFormedFileName: trim tabs, drop trailing slashes. */
export function wellFormedExplorerName(name: string): string {
  if (!name) return '';
  return String(name)
    .replace(/^\t+|\t+$/g, '')
    .replace(/[\\/]+$/, '');
}

/** extpath.ts isValidBasename. */
export function isValidExplorerBasename(name: string, windows: boolean = runtimeIsWindows): boolean {
  if (!name || /^\s+$/.test(name)) return false;
  const invalid = windows ? WINDOWS_INVALID_FILE_CHARS : UNIX_INVALID_FILE_CHARS;
  if (invalid.test(name)) return false;
  if (windows && WINDOWS_FORBIDDEN_NAMES.test(name)) return false;
  if (name === '.' || name === '..') return false;
  if (windows && name[name.length - 1] === '.') return false;
  if (windows && name.length !== name.trim().length) return false;
  if (name.length > 255) return false;
  return true;
}

/** fileActions.ts validateFileName: null = valid; warning never blocks. */
export function validateExplorerName(input: {
  name: string;
  originalName?: string;
  siblings?: readonly string[];
  /** New File/Folder accepts "a/b/c" nested segments; rename does not. */
  allowSegments?: boolean;
  windows?: boolean;
}): ExplorerNameProblem | null {
  const {
    originalName = '',
    siblings = [],
    allowSegments = false,
    windows = runtimeIsWindows,
  } = input;
  const name = wellFormedExplorerName(input.name);
  if (!name || name.length === 0 || /^\s+$/.test(name)) {
    return { content: 'A file or folder name must be provided.', severity: 'error' };
  }
  if (name[0] === '/' || name[0] === '\\') {
    return { content: 'A file or folder name cannot start with a slash.', severity: 'error' };
  }
  const segments = name.split(/[\\/]/).filter(Boolean);
  if (!allowSegments && segments.length > 1) {
    return { content: 'The name must not contain path separators.', severity: 'error' };
  }
  // Duplicate guard only for a plain single-segment name; nested creation
  // reuses existing folders on purpose (VS Code getChild misses on slashes).
  if (segments.length === 1 && name.toLowerCase() !== originalName.toLowerCase()) {
    const taken = new Set(siblings.map((sibling) => sibling.toLowerCase()));
    if (taken.has(name.toLowerCase())) {
      return {
        content: `A file or folder ${trimLongName(name)} already exists at this location. Please choose a different name.`,
        severity: 'error',
      };
    }
  }
  if (segments.some((segment) => !isValidExplorerBasename(segment, windows))) {
    return {
      content: `The name ${trimLongName(name)} is not valid as a file or folder name. Please choose a different name.`,
      severity: 'error',
    };
  }
  if (segments.some((segment) => /^\s|\s$/.test(segment))) {
    return { content: 'Leading or trailing whitespace detected in file or folder name.', severity: 'warning' };
  }
  return null;
}

function trimLongName(name: string): string {
  return name.length > 255 ? `${name.slice(0, 255)}...` : name;
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** comparers.ts compareFileNames: numeric-aware, case-insensitive first. */
export function compareExplorerNames(a: string, b: string): number {
  const result = nameCollator.compare(a, b);
  if (result !== 0) return result;
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface ExplorerSortableEntry {
  name: string;
  dir: boolean;
}

/** explorerViewer.ts FileSorter 'default': directories first, then names. */
export function sortExplorerEntries<T extends ExplorerSortableEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => a.dir === b.dir
    ? compareExplorerNames(a.name, b.name)
    : a.dir ? -1 : 1);
}

/** List type-ahead: next row whose name starts with the buffer, wrapping. */
export function explorerTypeAheadIndex(
  names: readonly string[],
  fromIndex: number,
  query: string,
): number {
  const lowered = query.toLowerCase();
  if (!lowered || names.length === 0) return -1;
  for (let step = 0; step <= names.length; step += 1) {
    const index = ((fromIndex + step) % names.length + names.length) % names.length;
    if (step === 0 && index === fromIndex && query.length > 1) {
      // Multi-char buffers may match the focused row itself.
      if (names[index].toLowerCase().startsWith(lowered)) return index;
      continue;
    }
    if (step === 0) continue;
    if (names[index].toLowerCase().startsWith(lowered)) return index;
  }
  return -1;
}

/** fileImportExport paste grammar: "name copy", then "name copy 2", ... */
export function explorerPasteName(
  name: string,
  dir: boolean,
  takenLowercase: ReadonlySet<string>,
): string {
  if (!takenLowercase.has(name.toLowerCase())) return name;
  const dot = dir ? -1 : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  let counter = 0;
  while (takenLowercase.has(candidate.toLowerCase())) {
    counter += 1;
    candidate = counter === 1 ? `${stem} copy${extension}` : `${stem} copy ${counter}${extension}`;
  }
  return candidate;
}
