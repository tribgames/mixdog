export type OverrideThreadSource = 'session' | 'argument' | 'argument-else-session' | 'none';

export const ACTION_OVERRIDES: Readonly<
  Record<
    string,
    (args: readonly unknown[], ctx: { threadId?: string }) => { method: string; params: Record<string, unknown> }
  >
>;
export const OVERRIDE_THREAD_SOURCE: Readonly<Record<string, OverrideThreadSource>>;
