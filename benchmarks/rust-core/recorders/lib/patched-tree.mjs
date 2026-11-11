// A copy of the Node tree's `src` with a unified diff applied, for recording a Node fix next to the Node of the base
// commit. Only what the patches here need: modified files (hunks matched by their exact old text, which must occur
// exactly once) and new files. `node_modules` is a junction to the base tree's, so the copy resolves its packages.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

function sections(patchText) {
  const out = [];
  let current = null;
  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) { current = { file: line.split(' b/')[1], isNew: false, hunks: [] }; out.push(current); continue; }
    if (!current) continue;
    if (line.startsWith('new file mode')) current.isNew = true;
    else if (line.startsWith('@@')) current.hunks.push({ old: [], neu: [] });
    else if (current.hunks.length && !line.startsWith('\\')) {
      const hunk = current.hunks.at(-1);
      const kind = line[0];
      if (kind === ' ') { hunk.old.push(line.slice(1)); hunk.neu.push(line.slice(1)); }
      else if (kind === '-') hunk.old.push(line.slice(1));
      else if (kind === '+') hunk.neu.push(line.slice(1));
    }
  }
  return out;
}

export function buildPatchedTree(tree, patchPath) {
  const dest = mkdtempSync(join(tmpdir(), 'patched-tree-'));
  cpSync(join(tree, 'src'), join(dest, 'src'), { recursive: true });
  for (const file of ['package.json']) cpSync(join(tree, file), join(dest, file));
  symlinkSync(join(tree, 'node_modules'), join(dest, 'node_modules'), 'junction');
  for (const { file, isNew, hunks } of sections(readFileSync(patchPath, 'utf8'))) {
    const target = join(dest, file);
    if (isNew) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${hunks.flatMap((h) => h.neu).join('\n')}\n`);
      continue;
    }
    if (!existsSync(target)) throw new Error(`patch names a file the tree does not have: ${file}`);
    let text = readFileSync(target, 'utf8');
    const crlf = text.includes('\r\n');
    for (const hunk of hunks) {
      const join_ = (lines) => lines.join(crlf ? '\r\n' : '\n');
      const before = join_(hunk.old);
      const at = text.indexOf(before);
      if (at < 0 || text.indexOf(before, at + 1) >= 0) throw new Error(`a hunk of ${file} does not match exactly once`);
      text = text.slice(0, at) + join_(hunk.neu) + text.slice(at + before.length);
    }
    writeFileSync(target, text);
  }
  return dest;
}
