import { GITHUB_ACTIONS, githubNumber, githubRepository, githubText, validateGithubRequest } from './contract.mjs';

const selected = (input, names) => Object.fromEntries(names
  .filter((name) => input[name] !== undefined).map((name) => [name, input[name]]));

export function buildGithubCommand(value) {
  const input = validateGithubRequest(value);
  const { action } = input;
  const definition = GITHUB_ACTIONS[action];
  const repoFree = action === 'repo.list' || action.startsWith('notification.');
  const repo = repoFree ? input.repo : githubRepository(input.repo);
  const root = `repos/${repo}`;
  const page = input.page ?? 1;
  const limit = input.limit ?? 30;
  const query = `per_page=${limit}&page=${page}`;
  const number = () => githubNumber(input.number);
  const id = () => githubNumber(input.id, 'id');
  const text = (key) => githubText(input[key], key, key === 'body' ? 60000 : 1000);
  const api = (endpoint, method = 'GET', body) => ({
    args: ['api', endpoint, '--hostname', input.hostname || 'github.com', '--method', method,
      ...(body === undefined ? [] : ['--input', '-'])],
    input: body === undefined ? undefined : JSON.stringify(body),
    json: true, list: definition.list === true, collection: definition.collection,
    page, limit, mutation: definition.write === true,
  });
  const cli = (args, json = false) => ({
    args, json, mutation: definition.write === true, hostname: input.hostname || 'github.com',
  });
  switch (action) {
    case 'repo.list':
      return api(input.owner ? `users/${input.owner}/repos?${query}&sort=updated` : `user/repos?${query}&sort=updated`);
    case 'repo.view': return api(root);
    case 'repo.create':
      if (!input.visibility) throw new TypeError('Choose private or public visibility explicitly.');
      return cli(['repo', 'create', repo, `--${input.visibility}`, '--description', input.description || '']);
    case 'repo.clone':
      return cli(['repo', 'clone', repo, text('destination')]);
    case 'repo.fork':
      return api(`${root}/forks`, 'POST', selected(input, ['organization']));
    case 'issue.list': return api(`${root}/issues?${query}&state=${input.state || 'open'}`);
    case 'issue.view': return api(`${root}/issues/${number()}`);
    case 'issue.comments': return api(`${root}/issues/${number()}/comments?${query}`);
    case 'issue.create':
      return api(`${root}/issues`, 'POST', { ...selected(input, ['body', 'labels', 'assignees']), title: text('title') });
    case 'issue.edit': {
      const body = selected(input, ['title', 'body', 'labels', 'assignees']);
      if (!Object.keys(body).length) throw new TypeError('Choose at least one issue field to edit.');
      return api(`${root}/issues/${number()}`, 'PATCH', body);
    }
    case 'issue.close':
    case 'issue.reopen':
      return api(`${root}/issues/${number()}`, 'PATCH', { state: action === 'issue.close' ? 'closed' : 'open' });
    case 'issue.comment':
    case 'pr.comment':
      return api(`${root}/issues/${number()}/comments`, 'POST', { body: text('body') });
    case 'pr.list': return api(`${root}/pulls?${query}&state=${input.state || 'open'}`);
    case 'pr.view': return api(`${root}/pulls/${number()}`);
    case 'pr.comments': return api(`${root}/pulls/${number()}/comments?${query}`);
    case 'pr.create':
      return api(`${root}/pulls`, 'POST', {
        title: text('title'), base: text('base'), head: text('head'),
        ...selected(input, ['body', 'draft']),
      });
    case 'pr.checkout': return cli(['pr', 'checkout', String(number()), '--repo', repo]);
    case 'pr.merge':
      if (!input.sha) throw new TypeError('Read the pull request and supply its head sha before merging.');
      return api(`${root}/pulls/${number()}/merge`, 'PUT', { merge_method: input.method || 'merge', sha: input.sha });
    case 'pr.review': {
      if (!input.event) throw new TypeError('A review event is required.');
      if (!input.sha) throw new TypeError('Read the pull request and supply its head sha before reviewing.');
      if (input.event !== 'APPROVE') text('body');
      return api(`${root}/pulls/${number()}/reviews`, 'POST', {
        event: input.event, body: input.body || '', commit_id: input.sha,
      });
    }
    case 'workflow.list': return api(`${root}/actions/workflows?${query}`);
    case 'workflow.run':
      return api(`${root}/actions/workflows/${encodeURIComponent(text('workflow'))}/dispatches`, 'POST', {
        ref: text('ref'), inputs: input.inputs || {},
      });
    case 'run.list': return api(`${root}/actions/runs?${query}`);
    case 'run.view': return api(`${root}/actions/runs/${id()}`);
    case 'run.logs':
      return cli(['run', 'view', String(id()), '--repo', repo, input.failed ? '--log-failed' : '--log']);
    case 'run.rerun':
      return api(`${root}/actions/runs/${id()}/${input.failed ? 'rerun-failed-jobs' : 'rerun'}`, 'POST');
    case 'run.cancel': return api(`${root}/actions/runs/${id()}/cancel`, 'POST');
    case 'release.list': return api(`${root}/releases?${query}`);
    case 'release.view': return api(`${root}/releases/${id()}`);
    case 'release.create':
      return api(`${root}/releases`, 'POST', {
        tag_name: text('tag'), name: text('title'),
        ...selected(input, ['body', 'draft', 'prerelease']),
        ...(input.target ? { target_commitish: input.target } : {}),
      });
    case 'release.edit': {
      const body = selected(input, ['body', 'draft', 'prerelease']);
      if (input.title !== undefined) body.name = input.title;
      if (!Object.keys(body).length) throw new TypeError('Choose at least one release field to edit.');
      return api(`${root}/releases/${id()}`, 'PATCH', body);
    }
    case 'notification.list': return api(`notifications?${query}&all=${input.all === true}`);
    case 'notification.read': return api(`notifications/threads/${id()}`, 'PATCH');
    default: throw new TypeError('Unsupported GitHub action.');
  }
}
