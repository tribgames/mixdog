/**
 * Cumulative per-session accounting as agent pool rows publish it, read off
 * the counters the session already persists (totalInputTokens /
 * totalOutputTokens / totalToolCalls, advanced once per provider response).
 * A counter the session never recorded stays unknown (null), not zero.
 */
const counter = (value) => (Number.isFinite(value) && value >= 0 ? value : null);

export function sessionUsageTotals(session) {
  const input = counter(session?.totalInputTokens);
  const output = counter(session?.totalOutputTokens);
  return {
    usage:
      input === null && output === null
        ? null
        : { inputTokens: input ?? 0, outputTokens: output ?? 0, totalTokens: (input ?? 0) + (output ?? 0) },
    toolCalls: counter(session?.totalToolCalls),
  };
}
