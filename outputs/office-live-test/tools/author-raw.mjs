// Prints the raw author result when scripts/office/author-deck.mjs reports "author failed: undefined".
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { executeOfficeTool } from '../../../src/runtime/office/index.mjs';

const [script, deck] = process.argv.slice(2);
const raw = await executeOfficeTool(
  { action: 'author', path: deck, script: await readFile(script, 'utf8'), mode: 'portable', overwrite: true, render: false },
  { cwd: resolve('.') }
);
const text = raw.content[0].text;
console.log(text.slice(0, 3000));
try {
  const result = JSON.parse(text);
  if (result.session) await executeOfficeTool({ action: 'close', session: result.session }, { cwd: resolve('.') });
} catch {}
