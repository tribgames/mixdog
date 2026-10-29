export function gitCommand(env?: NodeJS.ProcessEnv | null): string;
export function gitChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function gitChildEnv(env?: null): NodeJS.ProcessEnv | null;
export function forgetMissingGit(command: string, error: unknown): boolean;
export function startGit<T>(
  env: NodeJS.ProcessEnv,
  start: (command: string, env: NodeJS.ProcessEnv) => Promise<T>,
  spawnError?: (outcome: T) => unknown
): Promise<T>;
