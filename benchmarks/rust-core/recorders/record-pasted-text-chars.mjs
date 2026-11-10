// Records what Node b6f10295a's `materializePromptSubmission` (src/runtime/attachments/store.mjs:619, `materializePastedTexts` :466-499) makes of a
// pasted text's `chars`, `sizeBytes` and `attachmentRef`, run unchanged from the exact export.
//
//   node record-pasted-text-chars.mjs <export dir> <out file>
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [exportDir, outFile] = process.argv.slice(2);
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'pasted-chars-'));
const { materializePromptSubmission } = await import(pathToFileURL(join(exportDir, 'src/runtime/attachments/store.mjs')).href);

const inputs = [
  { name: 'ascii, no chars', entry: { id: 1, text: 'a pasted block' } },
  { name: 'astral text counts UTF-16 units', entry: { id: 1, text: '😀' } },
  { name: 'accented text', entry: { id: 1, text: 'héllo' } },
  { name: 'supplied number', entry: { id: 1, text: 'abc', chars: 7 } },
  { name: 'supplied numeric string', entry: { id: 1, text: 'abc', chars: '5' } },
  { name: 'supplied padded numeric string', entry: { id: 1, text: 'abc', chars: ' 12 ' } },
  { name: 'supplied zero falls back', entry: { id: 1, text: 'abcd', chars: 0 } },
  { name: 'supplied non-numeric string falls back', entry: { id: 1, text: 'abcd', chars: 'many' } },
  { name: 'supplied empty string falls back', entry: { id: 1, text: 'abcd', chars: '' } },
  { name: 'supplied fraction', entry: { id: 1, text: 'abcd', chars: 2.5 } },
  { name: 'supplied negative', entry: { id: 1, text: 'abcd', chars: -3 } },
  { name: 'supplied true', entry: { id: 1, text: 'abcd', chars: true } },
];
const cases = inputs.map(({ name, entry }) => {
  const { options } = materializePromptSubmission('see [Pasted text #1]', { pastedTexts: { 1: entry } });
  return { name, entry, materialized: options.pastedTexts[1] };
});
writeFileSync(outFile, `${JSON.stringify({ recorder: 'benchmarks/rust-core/recorders/record-pasted-text-chars.mjs', commit: 'b6f10295a2f698afc85332467192de28500bd146', cases }, null, 2)}\n`);
console.log(`recorded ${cases.length} cases`);
