import { resolve, sep } from 'node:path';

// Process-local ownership for project-files' cooperating mutations, not an OS
// lock. Claim every path up front (including a WorkspaceEdit's whole set), so
// opposite-order batches cannot deadlock and rollback stays inside the claim.
// Ancestor claims cover directory renames; disjoint files still run in parallel.
interface Claim {
  paths: string[];
  done: Promise<void>;
}
const pending = new Set<Claim>();

export function mutationPathKey(path: string): string {
  // Case-fold only for scheduling, NOT file identity. Even a case-sensitive
  // host can mount a case-insensitive volume; unnecessary serialization of
  // A/a is safe, conflating them as duplicate files is not.
  return resolve(path).toLowerCase();
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(right.endsWith(sep) ? right : right + sep)
    || right.startsWith(left.endsWith(sep) ? left : left + sep);
}

export async function withProjectMutationPaths<T>(paths: string[], run: () => Promise<T>): Promise<T> {
  const keys = [...new Set(paths.map(mutationPathKey))];
  const predecessors = [...pending].filter((claim) =>
    claim.paths.some((left) => keys.some((right) => overlaps(left, right)))
  );
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  const claim: Claim = { paths: keys, done };
  pending.add(claim);
  try {
    await Promise.all(predecessors.map((previous) => previous.done));
    return await run();
  } finally {
    pending.delete(claim);
    release();
  }
}
