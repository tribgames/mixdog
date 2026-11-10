export type GitIgnoreScope = 'file' | 'extension';
export type GitResetMode = 'soft' | 'mixed' | 'hard';
export type GitReviewSource = 'branch' | 'uncommitted';

/** `family`: the `platformFamily` of the PC's `initialize` answer; absent, the win32 rule. */
export function isAbsolutePath(value: string, family?: string): boolean;
export function requiredRepositoryCwd(value: unknown, family?: string): string;
export function requiredGitIgnoreScope(value: unknown): GitIgnoreScope;
export function requiredReviewSource(value: unknown): GitReviewSource;
export function requiredCommitHash(value: unknown): string;
export function requiredGitResetMode(value: unknown): GitResetMode;
export function requiredGitRevision(value: unknown): string;
