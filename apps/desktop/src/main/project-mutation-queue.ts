import { resolve, sep } from 'node:path';

// Process-local ownership for project-files' cooperating mutations, not an OS
// lock. Claim every path up front (including a WorkspaceEdit's whole set), so
// opposite-order batches cannot deadlock and rollback stays inside the claim.
// Ancestor claims cover directory renames; disjoint files still run in parallel.
//
// Paths are not file identity: two hard links are two paths for one file, which
// the path claims cannot see. In-place writers therefore also claim the file's
// identity (device + file index of the open handle) before touching its bytes.
// Identity claims are only ever taken inside a path claim, all at once, and
// their holders wait for nothing else, so the two queues cannot deadlock.
interface Claim {
  keys: string[];
  done: Promise<void>;
}
const pending = new Set<Claim>();
const pendingFiles = new Set<Claim>();

export function mutationPathKey(path: string): string {
  // Case-fold only for scheduling, NOT file identity. Even a case-sensitive
  // host can mount a case-insensitive volume; unnecessary serialization of
  // A/a is safe, conflating them as duplicate files is not.
  return resolve(path).toLowerCase();
}

function overlaps(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(right.endsWith(sep) ? right : right + sep) ||
    right.startsWith(left.endsWith(sep) ? left : left + sep)
  );
}

async function claimed<T>(
  queue: Set<Claim>,
  keys: string[],
  conflicts: (left: string, right: string) => boolean,
  run: () => Promise<T>
): Promise<T> {
  const predecessors = [...queue].filter((claim) =>
    claim.keys.some((left) => keys.some((right) => conflicts(left, right)))
  );
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const claim: Claim = { keys, done };
  queue.add(claim);
  try {
    await Promise.all(predecessors.map((previous) => previous.done));
    return await run();
  } finally {
    queue.delete(claim);
    release();
  }
}

export function withProjectMutationPaths<T>(paths: string[], run: () => Promise<T>): Promise<T> {
  return claimed(pending, [...new Set(paths.map(mutationPathKey))], overlaps, run);
}

/** Runs `run` once no other cooperating writer holds any of these file
 *  identities (`dev:ino` keys of open handles). Claim all of a batch's files
 *  in one call. */
export function withFileIdentities<T>(identities: string[], run: () => Promise<T>): Promise<T> {
  return claimed(pendingFiles, [...new Set(identities)], (left, right) => left === right, run);
}
