export function diffSessionState(
  previous: unknown,
  next: unknown,
  options?: { prepend?: boolean }
): Record<string, unknown> | null;
export function streamingPartialSuffix(before: unknown, after: unknown): string | null;
export function applySessionStatePatch(previous: unknown, patch: unknown): Record<string, unknown> | null;
export function transcriptItemsDigest(items: readonly unknown[]): string;
