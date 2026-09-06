import type { GithubRequest } from '../../shared/contract';

export type GithubSection = 'repositories' | 'issues' | 'actions' | 'workflows' | 'releases' | 'notifications';
export const GITHUB_SECTIONS: ReadonlyArray<readonly [GithubSection, string]> = [
  ['repositories', 'Repositories'], ['issues', 'Issues'], ['actions', 'Actions'],
  ['workflows', 'Workflows'], ['releases', 'Releases'], ['notifications', 'Notifications'],
];
export const LIST_ACTIONS: Record<GithubSection, GithubRequest['action']> = {
  repositories: 'repo.list', issues: 'issue.list', actions: 'run.list',
  workflows: 'workflow.list', releases: 'release.list', notifications: 'notification.list',
};
export type GithubRecord = Record<string, unknown>;
export const githubRecord = (value: unknown): GithubRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as GithubRecord : {};
export const githubRows = (value: unknown): GithubRecord[] =>
  Array.isArray(value) ? value.map(githubRecord) : [];

export function githubItemTitle(item: GithubRecord): string {
  return String(item.full_name || item.title || githubRecord(item.subject).title
    || item.display_title || item.name || item.tag_name || item.id || '');
}
export function githubItemState(item: GithubRecord): string {
  return [
    item.conclusion || item.status || item.state,
    item.draft ? 'Draft' : '',
    item.prerelease ? 'Pre-release' : '',
    item.private === true ? 'Private' : '',
    item.unread === true ? 'Unread' : '',
  ].filter(Boolean).join(' · ');
}
export function githubItemUrl(item: GithubRecord): string {
  const url = String(item.html_url || '');
  try { return new URL(url).protocol === 'https:' ? url : ''; } catch { return ''; }
}
export function repositoryFromUrl(value: string): { repo: string; hostname: string } | null {
  try {
    const url = new URL(value);
    const repo = url.pathname.replace(/^\/|\/$/g, '').replace(/\.git$/, '');
    if (url.protocol !== 'https:' || !/^[\w-]+\/[\w.-]+$/.test(repo)) return null;
    return { repo, hostname: url.hostname };
  } catch { return null; }
}
