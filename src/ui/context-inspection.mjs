// Messages split by author, because what the person typed, what the model
// produced, what a tool returned and what an attachment cost all grow for
// different reasons and are reduced in different ways. Runtime-authored
// reminders are the system speaking, so they ride in the system row as their
// own group instead of a category of their own. The remaining rows are the
// request surface, which is not a message at all.
export const CONTEXT_CATEGORIES = [
  { key: 'system', label: 'System messages' },
  { key: 'user', label: 'User messages' },
  { key: 'assistant', label: 'Assistant messages' },
  { key: 'toolResults', label: 'Tool results' },
  { key: 'attachments', label: 'Attachments' },
  { key: 'tools', label: 'System tools' },
  { key: 'mcp', label: 'MCP tools' },
  { key: 'agents', label: 'Custom agents' },
  { key: 'memory', label: 'Memory files' },
  { key: 'skills', label: 'Skills' },
];

// Integer allocation conserves the total; no category is counted twice.
export function contextShares(weights, total) {
  const sum = weights.reduce((value, weight) => value + weight, 0);
  if (!sum) return weights.map(() => 0);
  const exact = weights.map((weight) => (weight / sum) * total);
  const shares = exact.map(Math.floor);
  let remaining = total - shares.reduce((value, share) => value + share, 0);
  for (const index of exact.map((_, index) => index).sort((a, b) => exact[b] - shares[b] - (exact[a] - shares[a]))) {
    if (remaining-- <= 0) break;
    shares[index] += 1;
  }
  return shares;
}

// The map shows what the context holds and what is still open. The
// auto-compact buffer is headroom policy, not content, and reading it as a
// third kind of occupancy only crowded the picture (user: 자동압축버퍼는 항목
// 없애줘); the window it reserves is already the window this map measures.
export function buildContextMap(categories, { windowTokens = 0, cells = 128, fit = false } = {}) {
  const occupied = categories.reduce((sum, category) => sum + category.tokens, 0);
  const window = Math.max(0, windowTokens);
  const free = Math.max(0, window - occupied);
  const segments = [...categories, { key: 'free', tokens: fit ? 0 : free }];
  const scaleTokens = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const counts = contextShares(segments.map((segment) => segment.tokens), cells);
  return {
    cells: scaleTokens ? segments.flatMap((segment, index) => Array(counts[index]).fill(segment.key)) : [],
    blockTokens: scaleTokens / cells,
    scaleTokens,
    occupied,
    overflow: window > 0 && occupied > window,
  };
}
