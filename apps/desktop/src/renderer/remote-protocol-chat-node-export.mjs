// Node's code the recorders run: the exact export of b6f10295a, checked file by file against the commit's tree before it is loaded.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const NODE_CHECKOUT = 'C:/Project/mixdog';

/** Throws unless every file of the commit's tree is in `exportDir`, byte for byte (git blob ids) or, for a text file the archive wrote
 *  with CRLF (* text=auto), the same bytes once CRLF is read as the LF the repository stores. Returns the number of files checked. */
export function verifyNodeExport(exportDir) {
  const listing = execFileSync('git', ['-C', NODE_CHECKOUT, 'ls-tree', '-r', NODE_COMMIT], { maxBuffer: 1 << 28 }).toString().trim().split('\n');
  const blobId = (b) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
  const mismatched = [];
  let checked = 0;
  for (const line of listing) {
    const [meta, path] = line.split('\t');
    const [mode, , sha] = meta.split(' ');
    if (mode === '160000' || mode === '120000') continue;
    let body;
    try { body = readFileSync(join(exportDir, path)); } catch { mismatched.push(`${path} (missing)`); continue; }
    checked += 1;
    if (blobId(body) !== sha && blobId(Buffer.from(body.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')) !== sha) mismatched.push(path);
  }
  if (mismatched.length) throw new Error(`the export is not ${NODE_COMMIT.slice(0, 9)}: ${mismatched.length} files differ, e.g. ${mismatched.slice(0, 3).join(', ')}`);
  return checked;
}
