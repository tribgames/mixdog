// Git, GitHub CLI, LibreOffice status, git status/branches/log/stash, pull requests and commits.

/** Extensions → Built-in: system Git dependency used by the first-party tool. */
export interface DesktopGitCliStatus {
  installed: boolean;
  version?: string;
}

/** Extensions → Office: LibreOffice dependency behind document rendering and
 *  workbook recalculation, installed by the Office card's Install step. */
export interface DesktopLibreOfficeStatus {
  installed: boolean;
  version?: string;
}

/** Settings → Git: GitHub CLI presence and auth, probed through gh itself. */
export interface DesktopGithubCliStatus {
  installed: boolean;
  version?: string;
  authenticated: boolean;
  login?: string;
}

export type DesktopGithubCliLoginState = 'pending' | 'code' | 'success' | 'error';

/** One `gh auth login --web` device flow (Providers OAuth grammar): the
 *  renderer polls this while `pending`/`code` and stops on a terminal state. */
export interface DesktopGithubCliLoginFlow {
  flowId: string;
  state: DesktopGithubCliLoginState;
  /** The one-time device code, once gh prints it. */
  code?: string;
  /** Device-activation URL (github.com/login/device). */
  url?: string;
  message?: string;
  login?: string;
}

/** The signed-in GitHub account (gh api user); the identity source of truth
 *  for git's user.name/user.email. `email` falls back to the account's
 *  noreply address when no public email is set (the default). */
export interface DesktopGithubCliAccount {
  login: string;
  name: string;
  email: string;
}

export const DESKTOP_GIT_GLOBAL_CONFIG_KEYS = ['user.name', 'user.email', 'init.defaultBranch'] as const;

export type DesktopGitGlobalConfigKey = (typeof DESKTOP_GIT_GLOBAL_CONFIG_KEYS)[number];

/** Settings → Git: the global git identity/defaults (`git config --global`). */
export interface DesktopGitGlobalConfig {
  name: string;
  email: string;
  defaultBranch: string;
}

export interface DesktopGitFile {
  path: string;
  oldPath?: string;
  index: string;
  worktree: string;
  untracked: boolean;
  conflicted: boolean;
  stagedAdditions: number;
  stagedDeletions: number;
  unstagedAdditions: number;
  unstagedDeletions: number;
  additions: number;
  deletions: number;
}

export interface DesktopGitStatus {
  repository: boolean;
  branch: string;
  detached: boolean;
  unborn: boolean;
  upstream: boolean;
  upstreamName: string;
  remote: boolean;
  /** Primary remote URL (origin preferred) for hosted-review/PR links. */
  remoteUrl?: string;
  ahead: number;
  behind: number;
  operation: '' | 'merge' | 'rebase' | 'cherry-pick' | 'revert';
  files: DesktopGitFile[];
}

export interface DesktopGitStatusOptions {
  /** Reuse the last accepted line totals when the status shape is unchanged. */
  reuseLineStats?: boolean;
  /** Return repository and changed-file state without computing line totals. */
  skipLineStats?: boolean;
}

export interface DesktopGitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string;
  /** Branch tip committer date (ISO-8601); absent when git omitted it. */
  lastCommitAt?: string;
  /** Branch tip age in git's relative grammar ("16 days ago"). */
  lastCommitRelative?: string;
  /** Commits this branch has that the current branch lacks, when computable. */
  ahead?: number;
  /** Commits the current branch has that this branch lacks, when computable. */
  behind?: number;
}

export interface DesktopGitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  when: string;
  author: string;
  authoredAt: string;
  pushed: boolean;
  parents: string[];
  refs: string[];
  /**
   * Decorations split per KIND so the history menu can tell a tag from a
   * branch. Optional: an older host still answers with `refs` only.
   */
  tags?: string[];
  branches?: string[];
  remotes?: string[];
}

/**
 * `.gitignore` rule shape: one repository-rooted literal path (`file`, the
 * default) or the unanchored `*<ext>` rule behind "Ignore all <ext> files".
 */
export type DesktopGitIgnoreScope = 'file' | 'extension';

export interface DesktopGitStashEntry {
  ref: string;
  message: string;
  when: string;
}

/** GitHub CLI-backed pull request rows. */
export interface DesktopPullRequestChecks {
  total: number;
  passing: number;
  failing: number;
  pending: number;
}

export interface DesktopPullRequestEntry {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  state: string;
  url: string;
  updatedAt: string;
  reviewDecision: string;
  checks: DesktopPullRequestChecks;
}

export interface DesktopPullRequestCreateInput {
  base: string;
  head: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export interface DesktopPullRequestCategory {
  key: string;
  label: string;
  prs: DesktopPullRequestEntry[];
}

export interface DesktopPullRequestFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface DesktopPullRequestTimelineItem {
  kind: 'comment' | 'review';
  author: string;
  body: string;
  state: string;
  createdAt: string;
}

export interface DesktopPullRequestReviewer {
  login: string;
  state: string;
}

export interface DesktopPullRequestDetail extends DesktopPullRequestEntry {
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: DesktopPullRequestFile[];
  mergeable: string;
  mergeStateStatus: string;
  createdAt: string;
  labels: string[];
  timeline: DesktopPullRequestTimelineItem[];
  reviewers: DesktopPullRequestReviewer[];
}

export interface DesktopGitCommitFile {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface DesktopGitCommitDetails {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  email: string;
  authoredAt: string;
  parents: string[];
  files: DesktopGitCommitFile[];
}
