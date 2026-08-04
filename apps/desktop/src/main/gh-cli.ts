// Pull Requests backend: GitHub CLI (`gh`) calls from the main process,
// mirroring the VS Code "GitHub Pull Requests" extension's default queries.
// gh owns auth (keyring) — no tokens ever touch this process.
import { execFile } from 'node:child_process';

export interface GhPrChecks {
  total: number;
  passing: number;
  failing: number;
  pending: number;
}

export interface GhPrEntry {
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
  checks: GhPrChecks;
}

export interface GhPrCreateInput {
  base: string;
  head: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export interface GhPrCategory {
  key: string;
  label: string;
  prs: GhPrEntry[];
}

export interface GhPrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface GhPrTimelineItem {
  kind: 'comment' | 'review';
  author: string;
  body: string;
  /** Review verdict (APPROVED / CHANGES_REQUESTED / COMMENTED); '' for comments. */
  state: string;
  createdAt: string;
}

export interface GhPrReviewer {
  login: string;
  /** Latest review state, or PENDING for an unanswered review request. */
  state: string;
}

export interface GhPrDetail extends GhPrEntry {
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: GhPrFile[];
  mergeable: string;
  mergeStateStatus: string;
  createdAt: string;
  labels: string[];
  timeline: GhPrTimelineItem[];
  reviewers: GhPrReviewer[];
}

const LIST_FIELDS =
  'number,title,author,headRefName,baseRefName,isDraft,state,url,updatedAt,reviewDecision,statusCheckRollup';
const DETAIL_FIELDS = `${LIST_FIELDS},body,additions,deletions,changedFiles,files,mergeable,mergeStateStatus,createdAt,labels,comments,reviews,reviewRequests`;

// The VS Code extension's default PR tree categories. "Local Pull Request
// Branches" is assembled renderer-side from All Open, matching the extension.
export const PR_CATEGORIES: ReadonlyArray<{ key: string; label: string; search: string }> = [
  { key: 'copilot', label: 'Copilot on My Behalf', search: 'is:open author:copilot assignee:@me' },
  { key: 'review-requested', label: 'Waiting For My Review', search: 'is:open review-requested:@me' },
  { key: 'created', label: 'Created By Me', search: 'is:open author:@me' },
  { key: 'all', label: 'All Open', search: 'is:open' },
];

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('gh', args, {
      cwd,
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 16_000_000,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_PAGER: 'cat',
        CLICOLOR: '0',
      },
    }, (error: (Error & { code?: unknown }) | null, stdout, stderr) => {
      if (!error) {
        resolvePromise(String(stdout));
        return;
      }
      if (error.code === 'ENOENT') {
        reject(new Error('GitHub CLI (gh) is not installed. Install it from https://cli.github.com and run `gh auth login`.'));
        return;
      }
      reject(new Error(String(stderr || error.message).trim()));
    });
  });
}

export function requiredPrNumber(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 10_000_000) {
    throw new TypeError('A pull request number is required.');
  }
  return numberValue;
}

function summarizeChecks(rollup: unknown): GhPrChecks {
  const checks: GhPrChecks = { total: 0, passing: 0, failing: 0, pending: 0 };
  if (!Array.isArray(rollup)) return checks;
  for (const item of rollup) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const conclusion = String(record.conclusion ?? record.state ?? '').toUpperCase();
    checks.total += 1;
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) checks.passing += 1;
    else if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE'].includes(conclusion)) {
      checks.failing += 1;
    } else checks.pending += 1;
  }
  return checks;
}

function toEntry(record: Record<string, unknown>): GhPrEntry {
  const author = record.author as Record<string, unknown> | undefined;
  return {
    number: Number(record.number) || 0,
    title: String(record.title ?? ''),
    author: String(author?.login ?? ''),
    headRefName: String(record.headRefName ?? ''),
    baseRefName: String(record.baseRefName ?? ''),
    isDraft: record.isDraft === true,
    state: String(record.state ?? ''),
    url: String(record.url ?? ''),
    updatedAt: String(record.updatedAt ?? ''),
    reviewDecision: String(record.reviewDecision ?? ''),
    checks: summarizeChecks(record.statusCheckRollup),
  };
}

function requiredCreateText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string.`);
  const text = value.trim();
  if (!text || text.length > maximum) throw new TypeError(`${name} is invalid.`);
  return text;
}

export function buildGhPrCreateArgs(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Pull request input is required.');
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(['base', 'head', 'title', 'body', 'draft']);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new TypeError('Pull request input contains an unsupported field.');
  }
  const base = requiredCreateText(input.base, 'base branch', 512);
  const head = requiredCreateText(input.head, 'head branch', 512);
  const title = requiredCreateText(input.title, 'pull request title', 1024);
  if (input.body !== undefined && typeof input.body !== 'string') {
    throw new TypeError('pull request body must be a string.');
  }
  if (input.draft !== undefined && typeof input.draft !== 'boolean') {
    throw new TypeError('pull request draft must be a boolean.');
  }
  const body = input.body ?? '';
  if (body.length > 100_000) throw new TypeError('pull request body is invalid.');
  if (base.toLocaleLowerCase() === head.toLocaleLowerCase()) {
    throw new TypeError('Base branch must differ from the head branch.');
  }
  return [
    'pr', 'create',
    '--base', base,
    '--head', head,
    '--title', title,
    '--body', body,
    ...(input.draft === true ? ['--draft'] : []),
  ];
}

export async function ghPrDefaultBranch(cwd: string): Promise<string> {
  const branch = (await run(cwd, [
    'repo', 'view',
    '--json', 'defaultBranchRef',
    '--jq', '.defaultBranchRef.name',
  ])).trim();
  return requiredCreateText(branch, 'default branch', 512);
}

export async function ghPrCreate(cwd: string, value: unknown): Promise<GhPrEntry> {
  const output = await run(cwd, buildGhPrCreateArgs(value));
  const number = /\/pull\/(\d+)(?:\b|\/)/.exec(output)?.[1];
  const raw = await run(cwd, [
    'pr', 'view',
    ...(number ? [number] : []),
    '--json', LIST_FIELDS,
  ]);
  return toEntry(JSON.parse(raw) as Record<string, unknown>);
}

export async function ghPrList(cwd: string): Promise<GhPrCategory[]> {
  const lists = await Promise.all(PR_CATEGORIES.map(async (category) => {
    let raw = '';
    try {
      raw = await run(cwd, [
        'pr', 'list',
        '--search', category.search,
        '--limit', category.key === 'all' ? '50' : '25',
        '--json', LIST_FIELDS,
      ]);
    } catch (error) {
      // GitHub Enterprise instances and repositories without Copilot can
      // reject the built-in Copilot query. The upstream extension treats that
      // optional category as empty instead of failing the complete PR tree.
      if (category.key !== 'copilot') throw error;
    }
    const parsed: unknown = JSON.parse(raw || '[]');
    const prs = Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object').map(toEntry)
      : [];
    return { key: category.key, label: category.label, prs };
  }));
  return lists;
}

function loginOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  return String(record.login ?? record.name ?? '');
}

function buildTimeline(record: Record<string, unknown>): GhPrTimelineItem[] {
  const items: GhPrTimelineItem[] = [];
  if (Array.isArray(record.comments)) {
    for (const comment of record.comments as Array<Record<string, unknown>>) {
      const body = String(comment?.body ?? '').trim();
      if (!body) continue;
      items.push({
        kind: 'comment',
        author: loginOf(comment?.author),
        body,
        state: '',
        createdAt: String(comment?.createdAt ?? ''),
      });
    }
  }
  if (Array.isArray(record.reviews)) {
    for (const review of record.reviews as Array<Record<string, unknown>>) {
      const state = String(review?.state ?? '');
      const body = String(review?.body ?? '').trim();
      // Bodiless COMMENTED reviews are inline-thread carriers — noise here.
      if (!body && state === 'COMMENTED') continue;
      items.push({
        kind: 'review',
        author: loginOf(review?.author),
        body,
        state,
        createdAt: String(review?.submittedAt ?? review?.createdAt ?? ''),
      });
    }
  }
  return items.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

function buildReviewers(record: Record<string, unknown>): GhPrReviewer[] {
  const byLogin = new Map<string, string>();
  if (Array.isArray(record.reviews)) {
    for (const review of record.reviews as Array<Record<string, unknown>>) {
      const login = loginOf(review?.author);
      const state = String(review?.state ?? '');
      if (!login || !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'].includes(state)) continue;
      // Later reviews win: APPROVED after CHANGES_REQUESTED supersedes.
      byLogin.set(login, state);
    }
  }
  if (Array.isArray(record.reviewRequests)) {
    for (const request of record.reviewRequests as Array<Record<string, unknown>>) {
      const login = loginOf(request);
      if (login) byLogin.set(login, 'PENDING');
    }
  }
  return [...byLogin.entries()].map(([login, state]) => ({ login, state }));
}

export async function ghPrView(cwd: string, value: unknown): Promise<GhPrDetail> {
  const number = requiredPrNumber(value);
  const raw = await run(cwd, ['pr', 'view', String(number), '--json', DETAIL_FIELDS]);
  const record = JSON.parse(raw) as Record<string, unknown>;
  const files = Array.isArray(record.files)
    ? (record.files as Array<Record<string, unknown>>).map((file) => ({
        path: String(file.path ?? ''),
        additions: Number(file.additions) || 0,
        deletions: Number(file.deletions) || 0,
      })).filter((file) => file.path)
    : [];
  const labels = Array.isArray(record.labels)
    ? (record.labels as Array<Record<string, unknown>>).map((label) => String(label.name ?? '')).filter(Boolean)
    : [];
  return {
    ...toEntry(record),
    body: String(record.body ?? ''),
    additions: Number(record.additions) || 0,
    deletions: Number(record.deletions) || 0,
    changedFiles: Number(record.changedFiles) || 0,
    files,
    mergeable: String(record.mergeable ?? ''),
    mergeStateStatus: String(record.mergeStateStatus ?? ''),
    createdAt: String(record.createdAt ?? ''),
    labels,
    timeline: buildTimeline(record),
    reviewers: buildReviewers(record),
  };
}

export function ghPrCheckout(cwd: string, value: unknown): Promise<string> {
  return run(cwd, ['pr', 'checkout', String(requiredPrNumber(value))]);
}

const MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);

export function ghPrMerge(cwd: string, value: unknown, method: unknown): Promise<string> {
  const mergeMethod = String(method ?? 'merge');
  if (!MERGE_METHODS.has(mergeMethod)) throw new TypeError('A valid merge method is required.');
  return run(cwd, ['pr', 'merge', String(requiredPrNumber(value)), `--${mergeMethod}`]);
}

export function ghPrDiff(cwd: string, value: unknown): Promise<string> {
  return run(cwd, ['pr', 'diff', String(requiredPrNumber(value))]);
}
