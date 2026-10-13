import { parseUnifiedDiff } from './renderer-logic.mjs';

type SessionDiffFile = {
  /** Root + path identity; two roots may show the same relative name. */
  id?: unknown;
  /** The file lies outside the worktree root. */
  outside?: unknown;
  path?: unknown;
  oldPath?: unknown;
  status?: unknown;
  additions?: unknown;
  deletions?: unknown;
  binary?: unknown;
  /** Why a recorded file has no diff (e.g. it lies outside the worktree). */
  reason?: unknown;
  /** A legacy record that measured nothing: counts may be completed elsewhere. */
  unmeasured?: boolean;
};

export type SessionDiffResult = {
  supported?: boolean;
  authoritative?: boolean;
  /** The runtime vouches for this as the session's complete net change set:
   *  nothing from the transcript may add or resurrect a file. */
  complete?: boolean;
  patch?: unknown;
  patchTruncated?: boolean;
  reason?: unknown;
  files?: SessionDiffFile[];
};

type SessionDiffPart = ReturnType<typeof parseUnifiedDiff>[number];

export type SessionDiffRow = {
  /** Unique per file (root + path); the key for dedupe and selection. */
  id: string;
  path: string;
  /** Outside the project: recorded by an absolute path. */
  outside: boolean;
  oldPath: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Set only when the file has no diff to show. */
  reason: string;
  unmeasured: boolean;
  parts: SessionDiffPart[];
};

function cleanPath(value: unknown): string {
  return String(value || '').replace(/\\/g, '/');
}

/** A path recorded absolute: a file outside the project. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

function partPath(part: SessionDiffPart): string {
  // parseUnifiedDiff already removed the header's a/ b/ prefix, once.
  const next = cleanPath(part.newFile?.fileName);
  if (next && next !== '/dev/null') return next;
  const previous = cleanPath(part.oldFile?.fileName);
  return previous === '/dev/null' ? '' : previous;
}

function sumPartStats(parts: readonly SessionDiffPart[]): { additions: number; deletions: number } {
  return parts.reduce(
    (total, part) => {
      const stats = partStats(part);
      total.additions += stats.additions;
      total.deletions += stats.deletions;
      return total;
    },
    { additions: 0, deletions: 0 }
  );
}

function partStats(part: SessionDiffPart): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of part.hunks.join('\n').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

function parsePatchParts(patch: string): SessionDiffPart[] {
  if (!patch) return [];
  try {
    return parseUnifiedDiff(patch);
  } catch {
    return [];
  }
}

/** The slice of a session review patch that belongs to ONE file (its parts
 *  re-joined as a unified diff), or "" when the patch has no part for it. */
export function sessionDiffFilePatch(patch: string, rel: string): string {
  const target = cleanPath(rel);
  if (!target) return '';
  return parsePatchParts(patch)
    .filter(
      (part) =>
        partPath(part) === target ||
        (cleanPath(part.oldFile?.fileName) === target && cleanPath(part.newFile?.fileName) === '/dev/null')
    )
    .map((part) => part.patch)
    .join('\n');
}

export function buildSessionDiffRows(result: SessionDiffResult | null): SessionDiffRow[] {
  const patch = typeof result?.patch === 'string' ? result.patch : '';
  const partsByPath = new Map<string, SessionDiffPart[]>();
  for (const part of parsePatchParts(patch)) {
    const path = partPath(part);
    if (!path) continue;
    const parts = partsByPath.get(path) || [];
    parts.push(part);
    partsByPath.set(path, parts);
  }
  const rows: SessionDiffRow[] = [];
  const seen = new Set<string>();
  for (const file of Array.isArray(result?.files) ? result.files : []) {
    const path = cleanPath(file?.path);
    const id = cleanPath(file?.id) || path;
    if (!path || seen.has(id)) continue;
    seen.add(id);
    const oldPath = cleanPath(file?.oldPath);
    const parts = partsByPath.get(path) || (oldPath ? partsByPath.get(oldPath) : undefined) || [];
    const measured = sumPartStats(parts);
    rows.push({
      id,
      path,
      outside: typeof file?.outside === 'boolean' ? file.outside : isAbsolutePath(path),
      oldPath,
      status: String(file?.status || parts[0]?.status || 'M').toUpperCase(),
      additions: typeof file?.additions === 'number' ? file.additions : measured.additions,
      deletions: typeof file?.deletions === 'number' ? file.deletions : measured.deletions,
      binary: file?.binary === true || parts.some((part) => part.status === 'binary'),
      reason: parts.length === 0 && typeof file?.reason === 'string' ? file.reason : '',
      unmeasured: file?.unmeasured === true,
      parts,
    });
  }
  const listedPaths = new Set(rows.map((row) => row.path));
  for (const [path, parts] of partsByPath) {
    if (listedPaths.has(path)) continue;
    const measured = sumPartStats(parts);
    rows.push({
      id: path,
      path,
      outside: isAbsolutePath(path),
      oldPath: '',
      status: String(parts[0]?.status || 'M').toUpperCase(),
      additions: measured.additions,
      deletions: measured.deletions,
      binary: parts.some((part) => part.status === 'binary'),
      reason: '',
      unmeasured: false,
      parts,
    });
  }
  return rows;
}
