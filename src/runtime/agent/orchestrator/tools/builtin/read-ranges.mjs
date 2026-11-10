export function mergeReadRanges(ranges) {
  const filtered = (Array.isArray(ranges) ? ranges : [])
    .filter(
      (r) => r && Number.isFinite(Number(r.startLine)) && (Number.isFinite(Number(r.endLine)) || r.endLine === Infinity)
    )
    .map((r) => ({
      startLine: Math.max(1, Number(r.startLine)),
      endLine: r.endLine === Infinity ? Infinity : Number(r.endLine),
    }))
    .filter((r) => r.endLine === Infinity || r.endLine >= r.startLine)
    .sort((a, b) => a.startLine - b.startLine);
  if (filtered.length === 0) return [];
  const out = [{ ...filtered[0] }];
  // Infinity arithmetic covers open-ended ranges: nothing starts past
  // Infinity + 1, and Math.max keeps an Infinity end.
  for (let i = 1; i < filtered.length; i++) {
    const top = out[out.length - 1];
    const cur = filtered[i];
    if (cur.startLine <= top.endLine + 1) top.endLine = Math.max(top.endLine, cur.endLine);
    else out.push({ ...cur });
  }
  return out;
}
