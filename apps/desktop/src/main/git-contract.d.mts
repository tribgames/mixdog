export type GitIgnoreScope = 'file' | 'extension';
export type GitResetMode = 'soft' | 'mixed' | 'hard';
export type GitReviewSource = 'branch' | 'uncommitted';

export function requiredRepositoryCwd(value: unknown): string;
export function requiredGitIgnoreScope(value: unknown): GitIgnoreScope;
export function requiredReviewSource(value: unknown): GitReviewSource;
export function requiredCommitHash(value: unknown): string;
export function requiredGitResetMode(value: unknown): GitResetMode;
export function requiredGitRevision(value: unknown): string;
