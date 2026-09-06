// One allowlist for the desktop, agent schema, and mutation classifier.
export const GITHUB_ACTIONS = Object.freeze({
  'repo.list': { fields: ['owner', 'page', 'limit'], list: true },
  'repo.view': { fields: [] },
  'repo.create': { fields: ['description', 'visibility'], write: true },
  'repo.clone': { fields: ['destination'], write: true },
  'repo.fork': { fields: ['organization'], write: true },
  'issue.list': { fields: ['state', 'page', 'limit'], list: true },
  'issue.view': { fields: ['number'] },
  'issue.comments': { fields: ['number', 'page', 'limit'], list: true },
  'issue.create': { fields: ['title', 'body', 'labels', 'assignees'], write: true },
  'issue.edit': { fields: ['number', 'title', 'body', 'labels', 'assignees'], write: true },
  'issue.close': { fields: ['number'], write: true },
  'issue.reopen': { fields: ['number'], write: true },
  'issue.comment': { fields: ['number', 'body'], write: true },
  'pr.list': { fields: ['state', 'page', 'limit'], list: true },
  'pr.view': { fields: ['number'] },
  'pr.create': { fields: ['title', 'body', 'base', 'head', 'draft'], write: true },
  'pr.checkout': { fields: ['number'], write: true },
  'pr.merge': { fields: ['number', 'method', 'sha'], write: true },
  'pr.review': { fields: ['number', 'event', 'body', 'sha'], write: true },
  'pr.comment': { fields: ['number', 'body'], write: true },
  'pr.comments': { fields: ['number', 'page', 'limit'], list: true },
  'workflow.list': { fields: ['page', 'limit'], list: true, collection: 'workflows' },
  'workflow.run': { fields: ['workflow', 'ref', 'inputs'], write: true },
  'run.list': { fields: ['page', 'limit'], list: true, collection: 'workflow_runs' },
  'run.view': { fields: ['id'] },
  'run.logs': { fields: ['id', 'failed'] },
  'run.rerun': { fields: ['id', 'failed'], write: true },
  'run.cancel': { fields: ['id'], write: true },
  'release.list': { fields: ['page', 'limit'], list: true },
  'release.view': { fields: ['id'] },
  'release.create': { fields: ['tag', 'title', 'body', 'target', 'draft', 'prerelease'], write: true },
  'release.edit': { fields: ['id', 'title', 'body', 'draft', 'prerelease'], write: true },
  'notification.list': { fields: ['page', 'limit', 'all'], list: true },
  'notification.read': { fields: ['id'], write: true },
});

export function githubRequestMutates(input) {
  // Unknown requests must never enter a read-only/retry lane.
  return GITHUB_ACTIONS[input?.action]?.write !== undefined
    ? GITHUB_ACTIONS[input.action].write
    : !Object.hasOwn(GITHUB_ACTIONS, input?.action ?? '');
}

export function githubText(value, name, maximum = 1000, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim())
    || value.length > maximum || value.includes('\0')) {
    throw new TypeError(`${name} must be ${empty ? 'a' : 'a non-empty'} string of at most ${maximum} characters.`);
  }
  return value;
}

export function githubNumber(value, name = 'number', maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

export function githubRepository(value) {
  if (typeof value !== 'string' || value.length > 250
    || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value)
    || value.split('/').some((part) => part === '.' || part === '..')) {
    throw new TypeError('repo must be an explicit owner/name, not a URL or command.');
  }
  return value;
}

export function validateGithubRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !Object.hasOwn(GITHUB_ACTIONS, input.action ?? '')) {
    throw new TypeError('A supported GitHub action is required.');
  }
  const definition = GITHUB_ACTIONS[input.action];
  const allowed = new Set(['action', 'repo', 'hostname', ...definition.fields]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new TypeError(`Unsupported field for GitHub ${input.action}.`);
  }
  const out = { ...input };
  const required = {
    'repo.create': ['repo', 'visibility'], 'repo.clone': ['repo', 'destination'], 'repo.fork': ['repo'],
    'issue.view': ['number'], 'issue.comments': ['number'], 'issue.create': ['title'],
    'issue.edit': ['number'], 'issue.close': ['number'], 'issue.reopen': ['number'],
    'issue.comment': ['number', 'body'], 'pr.view': ['number'], 'pr.comments': ['number'],
    'pr.create': ['title', 'base', 'head'], 'pr.checkout': ['number'],
    'pr.merge': ['number', 'sha'], 'pr.review': ['number', 'sha', 'event'], 'pr.comment': ['number', 'body'],
    'workflow.run': ['workflow', 'ref'], 'run.view': ['id'], 'run.logs': ['id'],
    'run.rerun': ['id'], 'run.cancel': ['id'], 'release.view': ['id'],
    'release.create': ['tag', 'title'], 'release.edit': ['id'], 'notification.read': ['id'],
  }[out.action] || [];
  for (const key of required) {
    if (out[key] === undefined || out[key] === null || out[key] === '') {
      throw new TypeError(`${key} is required for ${out.action}.`);
    }
  }
  if (out.destination !== undefined) githubText(out.destination, 'destination', 1000);
  if (out.repo !== undefined) githubRepository(out.repo);
  if (out.hostname !== undefined && (typeof out.hostname !== 'string'
    || out.hostname.length > 253
    || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(out.hostname))) {
    throw new TypeError('hostname must be a GitHub or GitHub Enterprise DNS name.');
  }
  for (const key of ['number', 'id', 'page', 'limit']) {
    if (out[key] !== undefined) githubNumber(out[key], key, key === 'limit' ? 100 : Number.MAX_SAFE_INTEGER);
  }
  for (const key of ['draft', 'prerelease', 'failed', 'all']) {
    if (out[key] !== undefined && typeof out[key] !== 'boolean') throw new TypeError(`${key} must be boolean.`);
  }
  for (const key of ['body', 'description', 'title']) {
    if (out[key] !== undefined) githubText(out[key], key, key === 'body' ? 60000 : 1000, key !== 'title');
  }
  if ((out.action === 'pr.review' && out.event !== 'APPROVE') || out.action.endsWith('.comment')) {
    githubText(out.body, 'body', 60000);
  }
  for (const key of ['labels', 'assignees']) {
    if (out[key] !== undefined && (!Array.isArray(out[key]) || out[key].length > 50)) {
      throw new TypeError(`${key} must be an array with at most 50 entries.`);
    }
    out[key]?.forEach((value) => githubText(value, key, 100));
  }
  if (out.state !== undefined && !['open', 'closed', 'all'].includes(out.state)) throw new TypeError('Invalid state.');
  if (out.visibility !== undefined && !['private', 'public'].includes(out.visibility)) throw new TypeError('Invalid visibility.');
  if (out.method !== undefined && !['merge', 'squash', 'rebase'].includes(out.method)) throw new TypeError('Invalid merge method.');
  if (out.event !== undefined && !['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(out.event)) throw new TypeError('Invalid review event.');
  if (out.sha !== undefined && !/^[a-f0-9]{40}$/i.test(out.sha)) throw new TypeError('sha must be a full commit hash.');
  for (const key of ['owner', 'organization']) {
    if (out[key] !== undefined && (typeof out[key] !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/i.test(out[key]))) {
      throw new TypeError(`Invalid ${key}.`);
    }
  }
  for (const key of ['base', 'head', 'ref', 'tag', 'target', 'workflow']) {
    if (out[key] !== undefined) {
      githubText(out[key], key, 512);
      if (/^[\-]|[\r\n]/.test(out[key])) throw new TypeError(`Invalid ${key}.`);
    }
  }
  if (out.inputs !== undefined) {
    if (!out.inputs || typeof out.inputs !== 'object' || Array.isArray(out.inputs)
      || Object.keys(out.inputs).length > 25) throw new TypeError('inputs must contain at most 25 named values.');
    for (const [key, value] of Object.entries(out.inputs)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,99}$/.test(key)) throw new TypeError('Invalid workflow input name.');
      githubText(value, 'workflow input', 10000, true);
    }
  }
  return out;
}
