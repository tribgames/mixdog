// The bytes of every file of a replay's world, to compare what a call refused by decision leaves behind: before and after it, every
// file is there with the same bytes and no file was added. A path the set's manifest declares (`skip`, with its reason there) is not
// read.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** `{ '<name>/<path>': Buffer }` of every file under each folder of `roots` (`{ name: absolute folder }`), `/`-separated, but those
 *  at or under a `skip` path (`<name>/<path>`). */
export function worldFiles(roots, skip = []) {
  const files = new Map();
  const walk = (dir, at) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${at}/${entry.name}`;
      if (skip.some((skipped) => path === skipped || path.startsWith(`${skipped}/`))) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else {
        try {
          files.set(path, readFileSync(join(dir, entry.name)));
        } catch (error) {
          throw new Error(`${path}: ${error.message}`);
        }
      }
    }
  };
  for (const [name, dir] of Object.entries(roots)) walk(dir, name);
  return files;
}

/** The files added, removed or changed from `before` to `after` (both `worldFiles`), sorted. */
export function changedFiles(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => !(before.has(path) && after.has(path) && before.get(path).equals(after.get(path)))).sort();
}
