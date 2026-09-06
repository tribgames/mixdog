import { GITHUB_ACTIONS } from './contract.mjs';
import { executeGithubRequest } from './client.mjs';

export const GITHUB_TOOL_DEF = {
  name: 'github',
  title: 'GitHub',
  annotations: { title: 'GitHub', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, compressible: false },
  description: 'GitHub repositories, issues, PRs and reviews, Actions/logs, releases, and notifications through the signed-in GitHub CLI. Local Git history/diffs/staging belong to git. One action per call; writes are serialized and never retried. Obtain user approval before writes; workflow runs and published releases may deploy. repo is owner/name; omit to resolve the current Project. Lists use page/limit. Review/merge requires the current PR head sha. Install/connect in Extensions → Plugin → Git & GitHub.',
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
      state: { type: 'string', enum: ['open', 'closed', 'all'] },
      title: { type: 'string' },
      body: { type: 'string' },
      description: { type: 'string' },
      visibility: { type: 'string', enum: ['private', 'public'] },
      destination: { type: 'string', description: 'repo.clone only: explicit absolute new directory with an existing parent.' },
      organization: { type: 'string', description: 'Optional fork organization.' },
      labels: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      assignees: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      base: { type: 'string' },
      head: { type: 'string' },
      sha: { type: 'string', description: 'Full PR head commit hash; review/merge only.' },
      method: { type: 'string', enum: ['merge', 'squash', 'rebase'] },
      event: { type: 'string', enum: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] },
      workflow: { type: 'string', description: 'Workflow file name or numeric id as text.' },
      ref: { type: 'string', description: 'Explicit branch/tag to dispatch workflow on.' },
      inputs: { type: 'object', additionalProperties: { type: 'string' }, description: 'workflow.run named string inputs.' },
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
    let text = JSON.stringify(result);
    if (text.length > 40000) {
      text = JSON.stringify({
        action: result.action, repo: result.repo, page: result.page, hasMore: result.hasMore,
        truncated: true, output: text.slice(0, 38000),
        hint: 'Use a smaller list limit or a specific view action. Writes must not be replayed.',
      });
    }
    return text;
  } catch (error) {
    return `Error: ${String(error?.message || error)}`;
  }
}
