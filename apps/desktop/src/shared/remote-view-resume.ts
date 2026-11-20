/** What a receiver that applied every emitted frame holds right now: the
 * revision of a delta lane and the content its decoder keeps. Both ends hash
 * `held` the same way (canonicalJson), so a digest compares content. */
export interface ViewResumePoint {
  revision: number;
  held: unknown;
}

export interface ViewResumeLane {
  revision: number;
  digest: string;
}

/** Object keys sorted at every depth: both ends must hash the same JSON even
 * where a decoder merged fields into a different key order. */
export function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const record = entry as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) sorted[key] = record[key];
      return sorted;
    }) ?? 'null'
  );
}

export async function viewResumeDigest(held: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(held));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export async function viewResumeLane(point: ViewResumePoint | null): Promise<ViewResumeLane | null> {
  return point ? { revision: point.revision, digest: await viewResumeDigest(point.held) } : null;
}
