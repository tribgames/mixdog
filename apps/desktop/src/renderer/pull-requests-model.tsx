// Pull request list/detail model: labels, icons, views, filters, diff
// splitting and branch naming shared by the pane and the editor.
import { GitMerge, GitPullRequestArrow, GitPullRequestDraft, Github } from 'lucide-react';
import type { DesktopPullRequestCategory, DesktopPullRequestEntry } from '../shared/contract';
import { t } from './i18n';
import type { ScmStatusKind } from './ScmStatusIcon';

/** The base a new pull request targets when the remote names none. */
export function preferredBaseBranch(names: string[]): string {
  if (names.includes('main')) return 'main';
  if (names.includes('master')) return 'master';
  return names[0] ?? 'main';
}

export function checksState(checks: { failing: number; pending: number }): 'failing' | 'pending' | 'passing' {
  if (checks.failing > 0) return 'failing';
  if (checks.pending > 0) return 'pending';
  return 'passing';
}

export function pullRequestStateLabel(pr: { isDraft: boolean; state: string }): string {
  if (pr.isDraft) return t('Draft');
  if (pr.state === 'OPEN') return t('Open');
  if (pr.state === 'MERGED') return t('Merged');
  return t('Closed');
}

export function reviewerStateLabel(state: string): string {
  if (state === 'APPROVED') return t('Approved');
  if (state === 'CHANGES_REQUESTED') return t('Requested changes');
  if (state === 'COMMENTED') return t('Commented');
  return t('Review pending');
}

export function reviewDecisionTone(decision: string): 'passing' | 'failing' | 'pending' {
  if (decision === 'APPROVED') return 'passing';
  if (decision === 'CHANGES_REQUESTED') return 'failing';
  return 'pending';
}

export function reviewDecisionLabel(decision: string): string {
  if (decision === 'APPROVED') return t('Approved');
  if (decision === 'CHANGES_REQUESTED') return t('Changes requested');
  return t('Review required');
}

type MergeMethod = 'merge' | 'squash' | 'rebase';

export function mergeActionLabel(method: MergeMethod): string {
  if (method === 'merge') return t('Merge');
  if (method === 'squash') return t('Squash and merge');
  return t('Rebase and merge');
}

export function mergeButtonLabel(method: MergeMethod): string {
  if (method === 'merge') return t('Merge');
  if (method === 'squash') return t('Squash');
  return t('Rebase');
}

export function createSubmitLabel(creating: boolean, prUrl: string, createDraft: boolean): string {
  if (creating) return t('Creating…');
  if (!prUrl) return t('Push & Create PR');
  return createDraft ? t('Create draft PR') : t('Create PR');
}

export type PullRequestViewMode = 'overview' | 'changes';
export type PullRequestListView = 'open' | 'mine' | 'review';
export type PullRequestOpenHandler = (
  projectPath: string,
  pullRequest: DesktopPullRequestEntry,
  mode: PullRequestViewMode,
  toSide?: boolean
) => void;

export const PULL_REQUEST_LIST_VIEWS: readonly PullRequestListView[] = ['open', 'mine', 'review'];
export const PULL_REQUEST_DETAIL_TABS = ['conversation', 'checks', 'files'] as const;
export type PullRequestDetailTab = (typeof PULL_REQUEST_DETAIL_TABS)[number];

/** Split one `gh pr diff` payload into per-file unified patches. */
export function splitPrDiff(diff: string): Map<string, string> {
  const patches = new Map<string, string>();
  const lines = String(diff ?? '').split('\n');
  let path = '';
  let buffer: string[] = [];
  const flush = () => {
    if (path && buffer.length) patches.set(path, buffer.join('\n'));
  };
  for (const line of lines) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      flush();
      path = header[2];
      buffer = [line];
      continue;
    }
    if (path) buffer.push(line);
  }
  flush();
  return patches;
}

export function relativeAge(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 2_592_000) return `${Math.round(seconds / 86_400)}d`;
  return `${Math.round(seconds / 2_592_000)}mo`;
}

/** The PR payload carries no per-file status (contract: DesktopPullRequestFile
 *  is path + counts), so the changed-file rows read their status kind off the
 *  unified patch header the list already holds — `new file mode` /
 *  `deleted file mode` / `rename from` / `copy from`. Without that header the
 *  file is a MODIFICATION; the +/- totals are never guessed from. */
export function prFileStatusKind(patch: string | undefined): ScmStatusKind {
  const header = (patch ?? '').split('@@')[0];
  if (/^new file mode /m.test(header)) return 'new';
  if (/^deleted file mode /m.test(header)) return 'deleted';
  if (/^rename from /m.test(header)) return 'renamed';
  if (/^copy from /m.test(header)) return 'copied';
  return 'modified';
}

export function StateIcon({ pr }: { pr: DesktopPullRequestEntry }) {
  if (pr.isDraft) return <GitPullRequestDraft size={14} className="dock-pr-state-draft" aria-hidden="true" />;
  if (pr.state === 'MERGED') return <GitMerge size={14} className="dock-pr-state-merged" aria-hidden="true" />;
  return (
    <GitPullRequestArrow
      size={14}
      className={pr.state === 'CLOSED' ? 'dock-pr-state-closed' : 'dock-pr-state-open'}
      aria-hidden="true"
    />
  );
}

export function AuthorIcon({ login }: { login: string }) {
  return (
    <span className="dock-pr-avatar" aria-hidden="true">
      <Github size={14} />
      {login && (
        <img
          src={`https://github.com/${encodeURIComponent(login)}.png?size=32`}
          alt=""
          onError={(event) => event.currentTarget.remove()}
        />
      )}
    </span>
  );
}

function buildPullRequestCategories(
  categories: readonly DesktopPullRequestCategory[],
  localBranchNames: ReadonlySet<string>
): DesktopPullRequestCategory[] {
  const source = categories.filter((category) => category.key !== 'local');
  const all = source.find((category) => category.key === 'all')?.prs ?? [];
  const local = {
    key: 'local',
    label: 'Local Pull Request Branches',
    prs: all.filter((pr) => localBranchNames.has(pr.headRefName)),
  };
  const copilotIndex = source.findIndex((category) => category.key === 'copilot');
  // Renderer HMR can temporarily talk to an older desktop main process, and
  // older Enterprise hosts may omit the optional Copilot query altogether.
  // Keep the current extension's visible category grammar stable in both.
  if (copilotIndex < 0) {
    return [{ key: 'copilot', label: 'Copilot on My Behalf', prs: [] }, local, ...source];
  }
  return [...source.slice(0, copilotIndex + 1), local, ...source.slice(copilotIndex + 1)];
}

function dedupePullRequests(entries: readonly DesktopPullRequestEntry[]): DesktopPullRequestEntry[] {
  const seen = new Set<number>();
  return entries.filter((entry) => {
    if (seen.has(entry.number)) return false;
    seen.add(entry.number);
    return true;
  });
}

export function buildPullRequestViews(
  categories: readonly DesktopPullRequestCategory[],
  localBranchNames: ReadonlySet<string>
): Record<PullRequestListView, DesktopPullRequestEntry[]> {
  const display = buildPullRequestCategories(categories, localBranchNames);
  const byKey = new Map(display.map((category) => [category.key, category.prs] as const));
  const fallbackOpen = dedupePullRequests(display.flatMap((category) => category.prs));
  return {
    open: dedupePullRequests(byKey.get('all') ?? fallbackOpen),
    mine: dedupePullRequests([
      ...(byKey.get('created') ?? []),
      ...(byKey.get('local') ?? []),
      ...(byKey.get('copilot') ?? []),
    ]),
    review: dedupePullRequests(byKey.get('review-requested') ?? []),
  };
}

export function pullRequestMatchesFilter(entry: DesktopPullRequestEntry, rawFilter: string): boolean {
  const filter = rawFilter.trim().toLocaleLowerCase();
  if (!filter) return true;
  return [
    `#${entry.number}`,
    String(entry.number),
    entry.title,
    entry.author,
    entry.headRefName,
    entry.baseRefName,
  ].some((value) => value.toLocaleLowerCase().includes(filter));
}

export function pullRequestsWebUrl(repositoryUrl: string): string {
  const base = repositoryUrl.replace(/\/+$/, '');
  if (!base) return '';
  return /gitlab/i.test(base) ? `${base}/-/merge_requests` : `${base}/pulls`;
}

export function titleFromBranch(branch: string): string {
  const leaf = branch.split('/').filter(Boolean).at(-1) ?? branch;
  const text = leaf
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? `${text[0].toLocaleUpperCase()}${text.slice(1)}` : '';
}
