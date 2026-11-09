export function resolveAction(
  action: string,
  args: readonly unknown[],
  ctx: { threadId?: string }
): { method: string; params: Record<string, unknown> };
