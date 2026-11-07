// Records Node's `worktreeRevision` (git-history.ts) for fixed files: `${size}:${mtimeNs}:${ctimeNs}:${ino}`
// from `stat(path, { bigint: true })`. Run in an isolated temp dir: node record.mjs > corpus.json
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'revision-'));
writeFileSync(join(dir, 'empty.txt'), '');
writeFileSync(join(dir, 'five.txt'), 'hello');
writeFileSync(join(dir, 'utf8.txt'), 'héllo wörld\n');
mkdirSync(join(dir, 'sub'));
utimesSync(join(dir, 'five.txt'), 1_700_000_000.123456, 1_700_000_001.654321);
const cases = [];
for (const name of ['empty.txt', 'five.txt', 'utf8.txt', 'sub']) {
  const info = await stat(join(dir, name), { bigint: true });
  cases.push({
    name,
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
    ino: String(info.ino),
    revision: `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`,
  });
}
console.log(JSON.stringify({ platform: process.platform, node: process.version, cases }, null, 2));
