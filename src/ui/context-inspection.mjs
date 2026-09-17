export const CONTEXT_CATEGORIES = [
  { key: 'system', label: 'System prompt' },
  { key: 'tools', label: 'System tools' },
  { key: 'mcp', label: 'MCP tools' },
  { key: 'agents', label: 'Custom agents' },
  { key: 'memory', label: 'Memory files' },
  { key: 'skills', label: 'Skills' },
  { key: 'messages', label: 'Messages' },
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

export function buildContextMap(categories, { windowTokens = 0, reserveTokens = 0, cells = 128, fit = false } = {}) {
  const occupied = categories.reduce((sum, category) => sum + category.tokens, 0);
  const window = Math.max(0, windowTokens);
  const reserve = Math.max(0, reserveTokens);
  const free = Math.max(0, window - occupied);
  const segments = [
    ...categories,
    { key: 'free', tokens: fit ? 0 : free },
    { key: 'autocompact', tokens: fit ? 0 : reserve },
  ];
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
