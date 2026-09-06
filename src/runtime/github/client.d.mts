import type { GithubRequest, GithubResult } from './contract.mjs';
export interface GithubCommand {
  args: string[];
  input?: string;
  hostname?: string;
  mutation?: boolean;
  json?: boolean;
}
export interface GithubExecutionOptions {
  cwd?: string;
  signal?: AbortSignal;
  abortSignal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  run?: (command: GithubCommand, options: GithubExecutionOptions) => Promise<string>;
}
export function runGithubProcess(command: GithubCommand, options?: GithubExecutionOptions): Promise<string>;
export function executeGithubRequest(input: GithubRequest | unknown, cwd: string, options?: GithubExecutionOptions): Promise<GithubResult>;
