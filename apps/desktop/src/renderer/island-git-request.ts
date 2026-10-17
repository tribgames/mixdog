import { useCallback, useRef } from 'react';
import type { DesktopGitRequestContext, DesktopGitStatus, DesktopGithubCliStatus } from '../shared/contract-git';
import type { DesktopPromptContent, DesktopSubmitOptions } from '../shared/contract';
import { nextComposerSubmissionId } from './composer-draft';
import { t } from './i18n';
import type { SessionDiffRow } from './session-diff-model';
import { sessionChangesSourceLabel, useSessionChanges, type SessionChangesSource } from './session-changes-store';

export type IslandGitAction = 'pr' | 'commit-push' | 'commit';

/** Leads the transcript text of a request: the user bubble is drawn as a card
 *  and the invisible marks keep the plain text readable on other surfaces. */
const MARK = '\u2063';
const REQUEST_PATTERN = new RegExp(`^${MARK}git-request:(pr|commit-push|commit)${MARK}([^\\n]*)(?:\\n([^\\n]*))?`);
const MAX_LISTED_FILES = 200;

export function islandGitActionLabel(action: IslandGitAction): string {
  if (action === 'pr') return t('Create PR');
  if (action === 'commit-push') return t('Commit · push');
  return t('Commit');
}

export interface IslandGitRequestInput {
  action: IslandGitAction;
  source: SessionChangesSource;
  rows: readonly Pick<SessionDiffRow, 'path' | 'status' | 'additions' | 'deletions'>[];
  status: Pick<
    DesktopGitStatus,
    'branch' | 'detached' | 'upstream' | 'upstreamName' | 'ahead' | 'behind' | 'remoteUrl'
  >;
  defaultBranch: string;
  gh: Pick<DesktopGithubCliStatus, 'installed' | 'authenticated' | 'login'> | null;
  /** Main-process reads; null when they could not be gathered. */
  context?: DesktopGitRequestContext | null;
}

/** Whether the branch-vs-base reads apply, and against what. */
export function islandGitBaseRef(
  action: IslandGitAction,
  status: Pick<DesktopGitStatus, 'branch' | 'detached'>,
  defaultBranch: string
): string {
  if (!defaultBranch || status.detached) return '';
  return action === 'pr' || status.branch !== defaultBranch ? `origin/${defaultBranch}` : '';
}

const TOTAL_PATCH_LIMIT = 24_000;
const FILE_PATCH_LIMIT = 4_000;
const SUMMARIZED_PATH =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$|\.lock$|\.min\.(js|css)$|\.map$|\.snap$|(^|\/)(dist|build|generated)\/|\.generated\./i;

/** The listed files' patches within the caps: binary, lock and generated
 *  files collapse to one line, long ones are cut and marked. */
function patchBlock(rows: IslandGitRequestInput['rows'], files: DesktopGitRequestContext['files']): string[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const out: string[] = [];
  let budget = TOTAL_PATCH_LIMIT;
  for (const row of rows) {
    const counts = `+${row.additions} -${row.deletions}`;
    const file = byPath.get(row.path);
    if (!file) continue;
    if (SUMMARIZED_PATH.test(row.path.replace(/\\/g, '/')) || /^Binary files /m.test(file.patch)) {
      out.push(`### ${row.path}: summarized (binary, lockfile or generated), ${counts}`);
      continue;
    }
    if (!file.patch.trim()) {
      out.push(`### ${row.path}: no diff against HEAD`);
      continue;
    }
    const allowed = Math.min(FILE_PATCH_LIMIT, budget);
    if (allowed <= 0) {
      out.push(`### ${row.path}: omitted (patch budget used), ${counts}; read its diff if needed`);
      continue;
    }
    const cut = file.truncated || file.patch.length > allowed;
    const patch = cut ? file.patch.slice(0, allowed) : file.patch;
    budget -= patch.length;
    out.push(`### ${row.path}`, '```diff', patch.trimEnd(), '```');
    if (cut) out.push(`(truncated above, ${counts}; read this file's diff if you need the rest)`);
  }
  return out;
}

function contextBlocks(input: IslandGitRequestInput): string[] {
  const ctx = input.context;
  if (!ctx) return [];
  const blocks = [
    '',
    'git status --short --branch:',
    ctx.statusShort.trimEnd() || '(clean)',
    '',
    'git diff HEAD --stat:',
    ctx.diffStat.trimEnd() || '(none)',
    '',
    'Patches of the listed files:',
    ...patchBlock(input.rows, ctx.files),
  ];
  if (ctx.branchCommits || ctx.branchDiffStat) {
    blocks.push(
      '',
      'Commits on this branch not in the base (git log --oneline base..HEAD):',
      ctx.branchCommits.trimEnd() || '(none)',
      '',
      'git diff base...HEAD --stat:',
      ctx.branchDiffStat.trimEnd() || '(none)'
    );
  }
  blocks.push(
    '',
    'Recent commit subjects (style sample):',
    ...(ctx.recentSubjects.length ? ctx.recentSubjects.map((s) => `- ${s}`) : ['(none)']),
    '',
    `Pull request for the current branch: ${
      ctx.pr
        ? `#${ctx.pr.number} "${ctx.pr.title}" ${ctx.pr.url} (${ctx.pr.state}, base ${ctx.pr.baseRefName})`
        : 'none'
    }`
  );
  return blocks;
}

export interface IslandGitRequest {
  label: string;
  meta: string;
  /** What the transcript shows: marks + label, then meta. */
  displayText: string;
  /** What the model receives: context and instructions. */
  content: string;
}

/** The card's label and meta from a user message's transcript text. */
export function parseIslandGitRequestText(
  text: string
): { action: IslandGitAction; label: string; meta: string } | null {
  const match = REQUEST_PATTERN.exec(String(text || ''));
  if (!match) return null;
  return { action: match[1] as IslandGitAction, label: match[2].trim(), meta: (match[3] || '').trim() };
}

function ghLine(gh: IslandGitRequestInput['gh']): string {
  if (!gh) return 'unknown';
  if (!gh.installed) return 'not installed';
  return gh.authenticated ? `authenticated${gh.login ? ` as ${gh.login}` : ''}` : 'installed, not authenticated';
}

function instructionsFor(action: IslandGitAction, input: IslandGitRequestInput): string[] {
  const common = [
    'Split the changes into commits by work unit (one coherent purpose per commit).',
    'Leave temp, probe and scratch files out; only commit files that belong to the listed scope.',
    "Follow this repository's commit message style (see the recent subjects above).",
    'If the repository has a check for generated files (for example shipped history), regenerate what these changes require before committing.',
  ];
  if (action === 'commit') return [...common, 'Do not push.', 'Reply briefly with the commits you made.'];
  if (action === 'commit-push') {
    return [
      ...common,
      input.status.upstream
        ? 'Then push to the current branch.'
        : 'Then push to the current branch, setting its upstream (`git push -u`).',
      'Reply briefly with the commits and where they were pushed.',
    ];
  }
  const onDefault = !input.status.detached && input.status.branch === input.defaultBranch;
  return [
    ...common,
    onDefault || input.status.detached
      ? `The current ${input.status.detached ? 'HEAD is detached' : 'branch is the default branch'}: create a new, descriptively named branch before committing.`
      : 'Commit on the current branch.',
    'Push with upstream (`git push -u`).',
    `Open a pull request against ${input.defaultBranch || 'the default branch'} (use \`gh pr create\`). Write the title and body from this conversation's context. Reply with the PR link.`,
  ];
}

export function buildIslandGitRequest(input: IslandGitRequestInput): IslandGitRequest {
  const label = islandGitActionLabel(input.action);
  const meta = `${sessionChangesSourceLabel(input.source)} · ${t('Files {{count}}', { count: input.rows.length })}`;
  const listed = input.rows.slice(0, MAX_LISTED_FILES).map((row) => {
    const counts = `+${row.additions} -${row.deletions}`;
    return `- ${row.status || 'M'} ${row.path} (${counts})`;
  });
  if (input.rows.length > listed.length) listed.push(`- …and ${input.rows.length - listed.length} more`);
  const { status } = input;
  const content = [
    `Island Git request: ${input.action}. The user pressed "${label}"; carry it out end to end.`,
    '',
    'Context (already gathered; do not rediscover it):',
    `- Changes source: ${input.source}`,
    `- Branch: ${status.detached ? '(detached HEAD)' : status.branch}`,
    `- Upstream: ${status.upstream ? status.upstreamName : 'none'}; ahead ${status.ahead}, behind ${status.behind}`,
    `- Default/base branch: ${input.defaultBranch || 'unknown'}`,
    `- Remote: ${status.remoteUrl || 'none'}`,
    `- GitHub CLI: ${ghLine(input.gh)}`,
    `- Scope, ${input.rows.length} file(s) of the shown source:`,
    ...listed,
    ...contextBlocks(input),
    '',
    'Instructions:',
    ...(input.context
      ? [
          "- This context is current — do not re-run git status/diff/log or gh pr view; use only git and gh; read a file's diff only if it was truncated above.",
        ]
      : []),
    ...instructionsFor(input.action, input).map((line) => `- ${line}`),
  ].join('\n');
  return { label, meta, displayText: `${MARK}git-request:${input.action}${MARK}${label}\n${meta}`, content };
}

export interface IslandGitRequestDeps {
  host: {
    gitStatus?(cwd: string): Promise<DesktopGitStatus>;
    ghPrDefaultBranch?(cwd: string): Promise<string>;
    githubCliStatus?(): Promise<DesktopGithubCliStatus>;
    gitRequestContext?(cwd: string, input: { paths: string[]; base: string }): Promise<DesktopGitRequestContext>;
    submitToSession(sessionId: string, prompt: DesktopPromptContent, options?: DesktopSubmitOptions): Promise<boolean>;
  };
  sessionId: string;
  cwd: string;
  action: IslandGitAction;
  source: SessionChangesSource;
  rows: IslandGitRequestInput['rows'];
}

/** Gathers what the app knows and sends it through the session's normal
 *  submit path, so a running turn queues it like a typed message. */
export async function sendIslandGitRequest(deps: IslandGitRequestDeps): Promise<boolean> {
  const { host, cwd } = deps;
  const [status, defaultBranch, gh] = await Promise.all([
    host.gitStatus?.(cwd),
    host.ghPrDefaultBranch?.(cwd).catch(() => ''),
    host.githubCliStatus?.().catch(() => null),
  ]);
  if (!status?.repository) return false;
  const context =
    (await host
      .gitRequestContext?.(cwd, {
        paths: deps.rows.map((row) => row.path),
        base: islandGitBaseRef(deps.action, status, defaultBranch || ''),
      })
      .catch(() => null)) ?? null;
  const request = buildIslandGitRequest({
    action: deps.action,
    source: deps.source,
    rows: deps.rows,
    status,
    defaultBranch: defaultBranch || '',
    gh: gh ?? null,
    context,
  });
  return host.submitToSession(deps.sessionId, request.content, {
    id: nextComposerSubmissionId(),
    displayText: request.displayText,
  });
}

export function useIslandGitRequest(input: { sessionId: string; cwd: string }): {
  /** False when the session cannot take a request (no session, not a git repo). */
  ready: boolean;
  request(action: IslandGitAction): void;
} {
  const { sessionId, cwd } = input;
  const changes = useSessionChanges({ cwd, sessionId, active: true });
  const latest = useRef({ source: changes.source, rows: changes.rows });
  latest.current = { source: changes.source, rows: changes.rows };
  const ready = Boolean(sessionId) && Boolean(cwd) && changes.repository;
  const request = useCallback(
    (action: IslandGitAction) => {
      const host = window.mixdogDesktop;
      if (!host || !sessionId || !cwd) return;
      sendIslandGitRequest({ host, sessionId, cwd, action, ...latest.current }).catch((error) => {
        console.error('Island Git request failed', error);
      });
    },
    [sessionId, cwd]
  );
  return { ready, request };
}
