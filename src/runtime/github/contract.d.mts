export type GithubAction =
  | 'repo.list' | 'repo.view' | 'repo.create' | 'repo.clone' | 'repo.fork'
  | 'issue.list' | 'issue.view' | 'issue.comments' | 'issue.create' | 'issue.edit'
  | 'issue.close' | 'issue.reopen' | 'issue.comment'
  | 'pr.list' | 'pr.view' | 'pr.create' | 'pr.checkout' | 'pr.merge'
  | 'pr.review' | 'pr.comment' | 'pr.comments'
  | 'workflow.list' | 'workflow.run' | 'run.list' | 'run.view' | 'run.logs' | 'run.rerun' | 'run.cancel'
  | 'release.list' | 'release.view' | 'release.create' | 'release.edit'
  | 'notification.list' | 'notification.read';
export interface GithubRequest {
  action: GithubAction;
  repo?: string;
  hostname?: string;
  number?: number;
  id?: number;
  page?: number;
  limit?: number;
  owner?: string;
  state?: 'open' | 'closed' | 'all';
  title?: string;
  body?: string;
  description?: string;
  visibility?: 'private' | 'public';
  destination?: string;
  organization?: string;
  labels?: string[];
  assignees?: string[];
  base?: string;
  head?: string;
  sha?: string;
  method?: 'merge' | 'squash' | 'rebase';
  event?: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
  workflow?: string;
  ref?: string;
  inputs?: Record<string, string>;
  failed?: boolean;
  tag?: string;
  target?: string;
  draft?: boolean;
  prerelease?: boolean;
  all?: boolean;
}
export interface GithubResult {
  action: GithubAction;
  repo: string;
  hostname: string;
  data: unknown;
  page?: number;
  hasMore?: boolean;
}
export const GITHUB_ACTIONS: Readonly<Record<GithubAction, {
  fields: string[]; write?: boolean; list?: boolean; collection?: string;
}>>;
export function validateGithubRequest(input: unknown): GithubRequest;
export function githubRequestMutates(input: unknown): boolean;
export function githubRepository(value: unknown): string;
export function githubText(value: unknown, name: string, maximum?: number, empty?: boolean): string;
export function githubNumber(value: unknown, name?: string, maximum?: number): number;
