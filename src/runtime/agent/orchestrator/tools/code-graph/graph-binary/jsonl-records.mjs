// mixdog-graph JSONL stdout → records. Capability modes (--langs) answer with
// a single table object that has no `rel`; only per-file record modes require
// it.
export function parseGraphJsonl(output, { requireRel = true } = {}) {
  const records = [];
  let lineNumber = 0;
  for (const line of output.split('\n')) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (!rec || (requireRel && typeof rec.rel !== 'string')) throw new Error('record is missing string rel');
      records.push(rec);
    } catch (error) {
      throw new Error(
        `[code-graph] mixdog-graph emitted invalid JSONL at line ${lineNumber}: ${error?.message || error}`
      );
    }
  }
  return records;
}
