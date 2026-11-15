// What one Office tool call leaves, as the recorder of the dispatch set reads it: the answer, the write receipts the call's ledger
// holds (`officeWriteChanges`, what the extension-host worker sends back to the turn review) and the files of the call's folder that
// the call changed, with the files the test itself put there since the call before (the seeds). Contents are raw (base64); the
// recorder turns them into what the golden holds.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

/** `Map<relative path with '/', Buffer>` of the files under `root` (a folder is its path and a `/`, with `null` for bytes), leaving
 *  `skip` (the Office data folder) out. */
export function walk(root, skip) {
  const files = new Map();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (skip && samePath(full, skip)) continue;
      if (entry.isDirectory()) {
        files.set(`${path.relative(root, full).split(path.sep).join('/')}/`, null);
        visit(full);
      }
      else if (entry.isFile()) files.set(path.relative(root, full).split(path.sep).join('/'), readFileSync(full));
    }
  };
  try {
    visit(root);
  } catch {
    // a folder the test removed
  }
  return files;
}

/** The files of `after` that are new or different from `before` (base64; a new folder is `{ dir: true }`), and `null` for each
 *  one `after` lacks. */
export function difference(before, after) {
  const changed = {};
  for (const [name, bytes] of after) {
    if (bytes === null) {
      if (!before.has(name)) changed[name] = { dir: true };
    } else if (!before.has(name) || before.get(name) === null || !before.get(name).equals(bytes)) changed[name] = bytes.toString('base64');
  }
  for (const name of before.keys()) if (!after.has(name)) changed[name] = null;
  return changed;
}

const side = (content) => {
  if (content === null) return { absent: true };
  if (Buffer.isBuffer(content)) return { base64: content.toString('base64') };
  return { uncaptured: true };
};

/** `capture(real, args, context)` runs `real.executeOfficeTool` inside a write ledger and answers `{ result, event }`. */
export async function createCapture(tree) {
  const ledgerApi = await import(pathToFileURL(path.join(tree, 'src/runtime/office/core/office-write-ledger.mjs')).href);
  const known = new Map();
  return async function capture(real, args, context) {
    const given = context?.cwd;
    const dataDir = context?.dataDir ?? process.env.MIXDOG_DATA_DIR ?? '';
    const before = given ? walk(given, dataDir) : null;
    const seeds = given ? difference(known.get(given) ?? new Map(), before) : {};
    const { ledger, run } = ledgerApi.runWithOfficeWriteLedger({ cwd: given, dataDir }, () => real.executeOfficeTool(args, context));
    const result = await run;
    const writes = ledgerApi.officeWriteChanges(ledger).map(({ fullPath, before: was, after }) => ({ path: fullPath, before: side(was), after: side(after) }));
    const after = given ? walk(given, dataDir) : null;
    if (given) known.set(given, after);
    const disk = given ? difference(before, after) : {};
    const event = {
      cwd: given ?? null,
      dataDir,
      args: JSON.parse(JSON.stringify(args ?? {})),
      aborted: context?.signal?.aborted === true,
      text: result.content[0].text,
      isError: result.isError === true,
      images: result.content.length - 1,
      writes,
      seeds,
      disk,
    };
    return { result, event };
  };
}
