// The files a daemon answers for (its owner lock file, daemon.json), followed
// by change events instead of re-checked on a clock. Each cached value is the
// file's stat stamp, so any write or replacement reads back as a change, which
// goes to that file's handler to judge from the file's actual state.
//
// After every write the daemon itself makes, `published(path)` sets the
// baseline to the stamp it wrote: otherwise a deletion landing in the same
// debounce window as that write re-reads as missing-to-missing, no change, and
// is lost.
//
// A watch that cannot be kept is logged, never polled: while an entry is blind
// a deletion or replacement goes unseen until an ancestor's event names its
// directory and the watch re-attaches; the re-read then judges it at once.
// That gap is accepted as a known limit, with no fence on loss and no polling:
// the lock is what excludes a second daemon, and the reference single-owner
// lock (codex app-server-daemon/src/backend/pid.rs:112, a flock on the pid
// file) has no replacement detection at all, so this watch is extra to it.
import { createWatchedFileCache, fileStamp, fileStampSync } from '../runtime/shared/watched-file-cache.mjs';

const stamped = (stamp) => {
  if (stamp === null) throw new Error('stat failed');
  return { value: stamp };
};

/** `handlers`: Map of path → handler(), run on each change of that file. */
export function followOwnedFiles({ handlers, log }) {
  const run = (file) => handlers.get(file)?.();
  const cache = createWatchedFileCache(
    { load: (file) => stamped(fileStampSync(file)), loadAsync: (file) => fileStamp(file).then(stamped) },
    {
      onChange: run,
      onWatch: (file, watched) =>
        log(
          watched
            ? `ownership watch on ${file} re-attached; re-reading it now`
            : `ownership watch on ${file} LOST — its deletion or replacement goes unseen until the watch re-attaches`
        ),
    }
  );
  for (const file of handlers.keys()) cache.get(file);
  return {
    /** This process just wrote `file`. */
    async published(file) {
      const stamp = await fileStamp(file);
      // Already gone again: that is the change to judge.
      if (stamp === 'missing') run(file);
      else if (stamp !== null) cache.set(file, stamp);
    },
    close: () => cache.close(),
  };
}
