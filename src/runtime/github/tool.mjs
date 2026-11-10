import { DEFAULT_GITHUB_HOSTNAME, GITHUB_ACTIONS } from './contract.mjs';
import { executeGithubRequest } from './client.mjs';
import { GITHUB_OUTPUT_MAX_BYTES } from '../shared/tool-output-limit.mjs';
import { persistToolResultArtifactSync } from '../agent/orchestrator/session/tool-result-offload.mjs';
import { normalizeOutputPath } from '../agent/orchestrator/tools/builtin/path-utils.mjs';

// Model-facing reduction only; executeGithubRequest (also used by Desktop)
// keeps the raw REST response, and the agent's copy is preserved as `raw`.
// html_url is the one page link the model can hand to a user; the asset,
// status and check links are the only other URLs not derivable from ids.
const KEPT_URL_KEYS = new Set(['html_url', 'browser_download_url', 'target_url', 'details_url']);
const DROPPED_KEYS = new Set([
  'url',
  'node_id',
  '_links',
  'gravatar_id',
  'performed_via_github_app',
  'author_association',
  'sub_issues_summary',
  'issue_dependencies_summary',
]);
const USER_KEYS = new Set([
  'user',
  'owner',
  'assignee',
  'merged_by',
  'actor',
  'triggering_actor',
  'author',
  'uploader',
  'sender',
  'closed_by',
  'creator',
]);
const USER_LIST_KEYS = new Set(['assignees', 'requested_reviewers']);
const MIN_CLAMPED_STRING = 200;

function userLogin(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.login !== 'string') return undefined;
  return value.type && value.type !== 'User' ? `${value.login} (${value.type})` : value.login;
}

// Nested repositories collapse only where GitHub embeds them: PR head/base,
// workflow runs, and notifications. A primary repository payload is never keyed.
function isNestedRepository(key, parentKey) {
  return key === 'head_repository' || key === 'repository' || (key === 'repo' && ['head', 'base'].includes(parentKey));
}

function reduceGithubData(value, key, parentKey) {
  if (Array.isArray(value)) {
    return value.map((item) => (USER_LIST_KEYS.has(key) && userLogin(item)) || reduceGithubData(item, undefined, key));
  }
  if (!value || typeof value !== 'object') return value;
  if (USER_KEYS.has(key) && userLogin(value)) return userLogin(value);
  if (isNestedRepository(key, parentKey) && typeof value.full_name === 'string') return value.full_name;
  const reduced = {};
  for (const [name, item] of Object.entries(value)) {
    if (DROPPED_KEYS.has(name) || name.endsWith('node_id') || (name.endsWith('_url') && !KEPT_URL_KEYS.has(name))) {
      continue;
    }
    // Numbered objects (issues, PRs, milestones) are addressed by number; their id is noise.
    if (name === 'id' && typeof value.number === 'number') continue;
    if (name === 'reactions' && isEmptyReactions(item)) continue;
    reduced[name] = reduceGithubData(item, name, key);
  }
  return reduced;
}

function isEmptyReactions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item !== 'number' || item === 0);
}

const EXCERPT_MAX = 140;
const day = (value) => (typeof value === 'string' ? value.slice(0, 10) : undefined);
const login = (value) => userLogin(value) ?? (typeof value === 'string' ? value : undefined);

function excerpt(body) {
  if (typeof body !== 'string') return undefined;
  const text = body.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1)}…` : text;
}

function labelNames(labels) {
  const names = (Array.isArray(labels) ? labels : [])
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter(Boolean);
  return names.length ? names : undefined;
}

// Compact per-row projections for *.list actions: only what picks the next item
// to open. Undefined fields are dropped by JSON.stringify.
const LIST_PROJECTORS = {
  'issue.list': (item) => ({
    number: item.number,
    title: item.title,
    state: item.state,
    author: login(item.user),
    updated: day(item.updated_at),
    labels: labelNames(item.labels),
    comments: item.comments || undefined,
    excerpt: excerpt(item.body),
  }),
  'pr.list': (item) => ({
    number: item.number,
    title: item.title,
    state: item.merged_at ? 'merged' : item.state,
    draft: item.draft || undefined,
    author: login(item.user),
    updated: day(item.updated_at),
    head: item.head?.ref,
    base: item.base?.ref,
    labels: labelNames(item.labels),
    excerpt: excerpt(item.body),
  }),
  'repo.list': (item) => ({
    name: item.full_name,
    description: excerpt(item.description),
    visibility: item.visibility || (item.private ? 'private' : 'public'),
    language: item.language || undefined,
    fork: item.fork || undefined,
    archived: item.archived || undefined,
    updated: day(item.pushed_at || item.updated_at),
  }),
  'run.list': (item) => ({
    id: item.id,
    name: item.display_title || item.name,
    workflow: item.name,
    status: item.status,
    conclusion: item.conclusion || undefined,
    branch: item.head_branch,
    event: item.event,
    actor: login(item.actor),
    updated: day(item.updated_at),
  }),
  'release.list': (item) => ({
    id: item.id,
    tag: item.tag_name,
    name: item.name || undefined,
    draft: item.draft || undefined,
    prerelease: item.prerelease || undefined,
    author: login(item.author),
    published: day(item.published_at || item.created_at),
  }),
  'notification.list': (item) => ({
    id: item.id,
    unread: item.unread,
    reason: item.reason,
    type: item.subject?.type,
    title: item.subject?.title,
    number: Number(/\/(?:issues|pulls)\/(\d+)$/.exec(item.subject?.url || '')?.[1]) || undefined,
    repo: typeof item.repository === 'string' ? item.repository : item.repository?.full_name,
    updated: day(item.updated_at),
  }),
  'workflow.list': (item) => ({ id: item.id, name: item.name, path: item.path, state: item.state }),
};

function projectList(action, data) {
  const project = LIST_PROJECTORS[action];
  return project && Array.isArray(data) ? data.map(project) : undefined;
}

const BODY_MAX = 1500;

function bodyText(body) {
  if (typeof body !== 'string') return undefined;
  const text = body.replace(/\r\n/g, '\n').trim();
  if (!text) return undefined;
  if (text.length <= BODY_MAX) return text;
  const cut = /[\ud800-\udbff]/.test(text[BODY_MAX - 1]) ? BODY_MAX - 1 : BODY_MAX;
  return `${text.slice(0, cut)}… ${text.length - cut} more chars in raw`;
}

function logins(list) {
  const names = (Array.isArray(list) ? list : []).map(login).filter(Boolean);
  return names.length ? names : undefined;
}

const stamp = (value) => (typeof value === 'string' ? value : undefined);
const repoName = (repo) => (typeof repo === 'string' ? repo : repo?.full_name);

// Single-item projections: the decision fields of one issue/PR. Nulls that
// mean "not yet" (open PR closed_at) are dropped; `mergeable`/`mergeable_state`
// stay as returned because null there means GitHub is still computing.
const VIEW_PROJECTORS = {
  'pr.view': (pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.draft,
    merged: pr.merged,
    mergeable: pr.mergeable,
    mergeable_state: pr.mergeable_state,
    user: login(pr.user),
    labels: labelNames(pr.labels),
    assignees: logins(pr.assignees),
    requested_reviewers: logins(pr.requested_reviewers),
    head: pr.head && { ref: pr.head.ref, sha: pr.head.sha, repo: repoName(pr.head.repo) },
    base: pr.base && { ref: pr.base.ref, sha: pr.base.sha },
    commits: pr.commits,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    comments: pr.comments,
    review_comments: pr.review_comments,
    html_url: pr.html_url,
    created_at: stamp(pr.created_at),
    updated_at: stamp(pr.updated_at),
    closed_at: stamp(pr.closed_at),
    merged_at: stamp(pr.merged_at),
    body: bodyText(pr.body),
  }),
  'issue.view': (issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    state_reason: issue.state_reason || undefined,
    user: login(issue.user),
    labels: labelNames(issue.labels),
    assignees: logins(issue.assignees),
    milestone: issue.milestone?.title,
    comments: issue.comments,
    html_url: issue.html_url,
    created_at: stamp(issue.created_at),
    updated_at: stamp(issue.updated_at),
    closed_at: stamp(issue.closed_at),
    body: bodyText(issue.body),
  }),
};

function projectView(action, data) {
  const project = VIEW_PROJECTORS[action];
  return project && data && typeof data === 'object' && !Array.isArray(data) ? project(data) : undefined;
}

// Rows whose excerpt/description was shortened ("…") need raw for the rest.
function rowsWereCut(rows) {
  return rows.some(
    (row) =>
      row &&
      typeof row === 'object' &&
      Object.values(row).some((value) => typeof value === 'string' && value.endsWith('…'))
  );
}

const fits = (text) => Buffer.byteLength(text, 'utf8') <= GITHUB_OUTPUT_MAX_BYTES;

function clampStrings(value, max) {
  if (typeof value === 'string') {
    return value.length > max ? `${value.slice(0, max)}… [${value.length - max} more chars in raw]` : value;
  }
  if (Array.isArray(value)) return value.map((item) => clampStrings(item, max));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, clampStrings(item, max)]));
}

function longestString(value) {
  if (typeof value === 'string') return value.length;
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value).reduce((max, item) => Math.max(max, longestString(item)), 0);
}

// Largest uniform string length that fits; long bodies shrink before structure.
function clampToFit(build, data, result) {
  let lo = MIN_CLAMPED_STRING;
  let hi = Math.max(lo, longestString(data));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(build(clampStrings(data, mid)))) lo = mid;
    else hi = mid - 1;
  }
  const text = build(clampStrings(data, lo));
  return fits(text) ? text : structuralView(result, data);
}

const MAX_VIEW_DEPTH = 4;

// Arrays keep their first `count` items, objects keep every key (scalars intact,
// long strings clamped), and anything deeper than MAX_VIEW_DEPTH is a marker.
function boundedView(value, count, depth) {
  if (typeof value === 'string') return clampStrings(value, MIN_CLAMPED_STRING);
  if (!value || typeof value !== 'object') return value;
  if (depth >= MAX_VIEW_DEPTH) return '[nested data omitted; see raw]';
  if (Array.isArray(value)) {
    const items = value.slice(0, count).map((item) => boundedView(item, count, depth + 1));
    if (value.length > count) items.push(`… ${value.length - count} more items in raw`);
    return items;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, boundedView(item, count, depth + 1)]));
}

function longestArray(value) {
  if (!value || typeof value !== 'object') return 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.reduce((max, item) => Math.max(max, longestArray(item)), Array.isArray(value) ? value.length : 0);
}

// Last resort: the largest per-array item count whose structural view fits.
// Always returns text that fits; the minimal form only points at raw.
function structuralView(result, data) {
  const build = (count) =>
    JSON.stringify({
      ...result,
      data: boundedView(data, count, 0),
      shown: `structural view: first ${count} items of each nested list, strings cut to ${MIN_CLAMPED_STRING} chars`,
      omitted: 'remaining list items, long text and deeply nested fields are in raw; read them there',
    });
  let lo = 0;
  let hi = longestArray(data);
  if (!fits(build(0))) {
    return JSON.stringify({
      shown: 'no data fits the output limit',
      omitted: 'the whole result is in raw; read it there',
      raw: result.raw,
    });
  }
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(build(mid))) lo = mid;
    else hi = mid - 1;
  }
  return build(lo);
}

// Long bodies shrink first so the page overview stays complete; only then are
// trailing records left to raw, never to page/limit (that skips or repeats).
function capRecords(result, data) {
  const build = (records, count) =>
    JSON.stringify({
      ...result,
      data: records,
      ...(count < data.length
        ? {
            shown: `records 1-${count} of ${data.length} on this page`,
            omitted: `records ${count + 1}-${data.length} of this page are in raw; read them there before changing page or limit`,
          }
        : {}),
    });
  let lo = 1;
  let hi = data.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(build(clampStrings(data.slice(0, mid), MIN_CLAMPED_STRING), mid))) lo = mid;
    else hi = mid - 1;
  }
  return clampToFit((records) => build(records, lo), data.slice(0, lo), result);
}

// Logs end with the failure in most runs, so the tail is the fallback view;
// the stated line range and raw keep the rest reachable.
function capText(result, text, args) {
  const total = text.split('\n').length;
  const build = (start) => {
    const first = text.slice(0, start).split('\n').length;
    return JSON.stringify({
      ...result,
      data: text.slice(start),
      shown: `lines ${first}-${total} of ${total}`,
      omitted: `lines before ${first} are in raw${
        args.action === 'run.logs' && !args.failed ? '; failed:true refetches only failed jobs' : ''
      }`,
    });
  };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(build(mid))) hi = mid;
    else lo = mid + 1;
  }
  let start = lo;
  const lineStart = start > 0 && text[start - 1] !== '\n' ? text.indexOf('\n', start) : -1;
  if (lineStart !== -1 && lineStart + 1 < text.length) start = lineStart + 1;
  else if (/[\udc00-\udfff]/.test(text[start] || '')) start += 1;
  return build(start);
}

function capGithubResult(result, args) {
  const { data } = result;
  if (typeof data === 'string') return capText(result, data, args);
  if (Array.isArray(data)) return capRecords(result, data);
  return clampToFit((value) => JSON.stringify({ ...result, data: value }), data, result);
}

export const GITHUB_TOOL_DEF = {
  name: 'github',
  title: 'GitHub',
  annotations: {
    title: 'GitHub',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    compressible: false,
  },
  trigger: 'GitHub repos, issues, PRs, Actions, releases; not local Git history, diffs or staging (git).',
  description:
    'GitHub repositories, issues, PRs and reviews, Actions/logs, releases, and notifications through the signed-in GitHub CLI. Local Git history/diffs/staging belong to git. One action per call; writes are serialized and never retried. Obtain user approval before writes; workflow runs and published releases may deploy. repo is owner/name; omit to resolve the current Project. Lists use page/limit and return compact rows (issues/PRs: number, title, state, author, updated, labels, 140-char excerpt; other lists: ids and status fields); open a row with its *.view action for bodies and details. Review/merge requires the current PR head sha. Install/connect in Extensions → Plugin → Git & GitHub. Results omit API-only URLs and node ids and name users/repos by login/full_name; issue/PR views keep decision fields and cap the body; `raw`, present whenever rows, text or fields were cut or dropped, is a readable file with the full response, and long results state what is shown.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: Object.keys(GITHUB_ACTIONS) },
      repo: { type: 'string', description: 'owner/name; required for create, clone, and fork targets.' },
      hostname: { type: 'string', description: 'GitHub Enterprise DNS name; default github.com.' },
      number: { type: 'integer', minimum: 1, description: 'Issue or PR number.' },
      id: { type: 'integer', minimum: 1, description: 'Run, release, or notification thread id.' },
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      owner: { type: 'string', description: 'repo.list owner; omit for authenticated repositories.' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'issue.list/pr.list only.' },
      title: { type: 'string' },
      body: { type: 'string' },
      description: { type: 'string' },
      visibility: { type: 'string', enum: ['private', 'public'] },
      destination: {
        type: 'string',
        description: 'repo.clone only: explicit absolute new directory with an existing parent.',
      },
      organization: { type: 'string', description: 'Optional fork organization.' },
      labels: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      assignees: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      base: { type: 'string' },
      head: { type: 'string' },
      sha: { type: 'string', description: 'Full PR head commit hash; review/merge only.' },
      method: { type: 'string', enum: ['merge', 'squash', 'rebase'] },
      event: { type: 'string', enum: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] },
      workflow: {
        type: 'string',
        description: 'workflow.run target or run.list filter: workflow file name or numeric id as text.',
      },
      ref: { type: 'string', description: 'Explicit branch/tag to dispatch workflow on.' },
      inputs: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'workflow.run named string inputs.',
      },
      failed: { type: 'boolean', description: 'run.logs/rerun: failed jobs only.' },
      tag: { type: 'string' },
      target: { type: 'string', description: 'Release target branch or commit.' },
      draft: { type: 'boolean' },
      prerelease: { type: 'boolean' },
      all: { type: 'boolean', description: 'notification.list: include read threads.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

export async function executeGithubTool(args, cwd, options = {}) {
  try {
    const result = await executeGithubRequest(args, cwd, options);
    const data =
      projectList(args.action, result.data) ?? projectView(args.action, result.data) ?? reduceGithubData(result.data);
    const reduced = { ...result, data };
    if (reduced.hostname === DEFAULT_GITHUB_HOSTNAME) delete reduced.hostname;
    const text = JSON.stringify(reduced);
    // Lists point at raw only when a row or excerpt was cut; they are projected
    // by design. Everything else needs raw whenever the reduction dropped data.
    const lossy = GITHUB_ACTIONS[args.action]?.list
      ? Array.isArray(data) && rowsWereCut(data)
      : JSON.stringify(data) !== JSON.stringify(result.data);
    if (!lossy && fits(text)) return text;
    const raw = persistToolResultArtifactSync({
      sessionId: options.sessionId,
      toolCallId: options.toolCallId,
      channel: 'github-raw',
      content: typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2),
    });
    // Without a session archive the reduction still applies; the note says so.
    reduced.raw = raw ? normalizeOutputPath(raw.path) : 'unavailable (no session archive)';
    const withRaw = JSON.stringify(reduced);
    return fits(withRaw) ? withRaw : capGithubResult(reduced, args);
  } catch (error) {
    return `Error: ${String(error?.message || error)}`;
  }
}
