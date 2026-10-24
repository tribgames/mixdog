// Rows of the composer's `@` file palette: a "Recent" group (files this
// conversation mentioned, then files changed in git) above the project search
// results, all ranked and highlighted by the shared file-match rule.
import { compareFileMatches, matchFile, normalizeFileQuery, type FileMatch } from '../shared/file-match';
import type { DesktopGitStatus } from '../shared/contract';
import { runtimeIsWindows } from './explorer-logic';

export const RECENT_MENTION_LIMIT = 5;

/** One comparison key for a project-relative path across mentions, git rows
 *  and search results: Windows file names ignore case. */
export function fileKey(path: string, windows: boolean = runtimeIsWindows): string {
  return windows ? path.toLowerCase() : path;
}

export interface MentionItem {
  path: string;
  group: 'recent' | 'project';
  /** Why a Recent row is there. */
  source?: 'mentioned' | 'changed';
  /** Matched characters to highlight; null when nothing was typed. */
  match: FileMatch | null;
}

function folderPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function foldDrive(value: string): string {
  return /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
}

/** `path` made relative to the project, or null when it lies outside it. */
function insideProject(projectScope: string, path: string): string | null {
  const project = folderPath(projectScope);
  return foldDrive(path).startsWith(`${foldDrive(project)}/`) ? path.slice(project.length + 1) : null;
}

/** Candidate files named as `@path` in the user's messages, newest first,
 *  relative to the project, `\` read as `/`. Only tokens ending in `/` (folders)
 *  are skipped here; whether a candidate is a file is the project's to say
 *  (`verifiedMentionedFiles`). */
export function mentionedFilePaths(
  messages: ReadonlyArray<{ text: string }>,
  projectScope: string,
  windows: boolean = runtimeIsWindows
): string[] {
  const found = new Map<string, string>();
  for (const message of [...messages].reverse()) {
    const tokens = [...message.text.matchAll(/(?:^|[\s([{"'])@([^\s@]+)/g)].map((match) =>
      match[1].replace(/\\/g, '/').replace(/[.,;:!?)\]}"']+$/, '')
    );
    for (const token of tokens.reverse()) {
      if (!token || token.endsWith('/')) continue;
      const normalized = token.replace(/^\.\//, '');
      const relative = /^(?:[a-z]:\/|\/)/i.test(normalized) ? insideProject(projectScope, normalized) : normalized;
      if (relative && !/(^|\/)\.\.(\/|$)/.test(relative) && !found.has(fileKey(relative, windows))) {
        found.set(fileKey(relative, windows), relative);
      }
    }
  }
  return [...found.values()];
}

/** The candidates that are files of the project, in the same order. `stat`
 *  rejects for a path that is not there and says `directory` for a folder. */
export async function verifiedMentionedFiles(
  candidates: readonly string[],
  stat: (path: string) => Promise<{ directory?: boolean } | null | undefined>
): Promise<string[]> {
  const checked = await Promise.all(
    candidates.map((path) => stat(path).then((info) => (info?.directory === true ? null : path), () => null))
  );
  return checked.filter((path): path is string => path !== null);
}

/** Files git reports changed (untracked included, deleted ones left out),
 *  relative to the project; `status.files` paths are relative to the
 *  repository root. */
export function changedFilePaths(status: DesktopGitStatus | null | undefined, projectScope: string): string[] {
  if (!status?.repository) return [];
  const root = folderPath(status.root);
  const found = new Set<string>();
  for (const file of status.files) {
    if (file.index === 'D' || file.worktree === 'D' || file.path.endsWith('/')) continue;
    const relative = insideProject(projectScope, `${root}/${file.path}`);
    if (relative) found.add(relative);
  }
  return [...found];
}

/** The palette's rows in display order: up to five Recent rows (filtered and
 *  ranked by the query when one is typed), then the search results that are
 *  not already shown there. */
export function mentionItems({
  mentioned,
  changed,
  results,
  query,
  windows = runtimeIsWindows,
}: {
  mentioned: readonly string[];
  changed: readonly string[];
  results: readonly string[];
  query: string;
  windows?: boolean;
}): MentionItem[] {
  const typed = Boolean(normalizeFileQuery(query));
  const mentionedKeys = new Set(mentioned.map((path) => fileKey(path, windows)));
  const recent = [
    ...mentioned.map((path) => ({ path, source: 'mentioned' as const })),
    ...changed
      .filter((path) => !mentionedKeys.has(fileKey(path, windows)))
      .map((path) => ({ path, source: 'changed' as const })),
  ].flatMap((row): MentionItem[] => {
    const match = typed ? matchFile(row.path, query) : null;
    return typed && !match ? [] : [{ ...row, group: 'recent', match }];
  });
  if (typed) {
    recent.sort((left, right) =>
      compareFileMatches({ ...left, match: left.match! }, { ...right, match: right.match! })
    );
  }
  const top = recent.slice(0, RECENT_MENTION_LIMIT);
  const taken = new Set(top.map((row) => fileKey(row.path, windows)));
  return [
    ...top,
    ...results
      .filter((path) => !taken.has(fileKey(path, windows)))
      .map((path): MentionItem => ({ path, group: 'project', match: typed ? matchFile(path, query) : null })),
  ];
}
