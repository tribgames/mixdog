/** FNV-1a over the whole text: one linear pass, no allocation. */
export function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export const textIdentity = (value: unknown): string => (typeof value === 'string' ? `${value.length}.${textHash(value)}` : '0');

/** What identifies the whole output and diff of a tool row (and of an aggregate's members): the host computes it over the uncut text
 *  and sends it on a cut row, so two revisions that differ only in the text the phone's copy leaves out do not look alike. */
export function wholeOutputRevision(row: Record<string, unknown>): string {
  const members = Array.isArray(row.toolMembers) ? row.toolMembers : [];
  return [row, ...members]
    .map((record) => {
      const fields = record && typeof record === 'object' ? (record as Record<string, unknown>) : {};
      return [fields.result, fields.rawResult, fields.uiDiff].map(textIdentity).join('.');
    })
    .join('|');
}
