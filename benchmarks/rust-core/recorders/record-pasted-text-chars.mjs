// Records what Node b6f10295a's `materializePromptSubmission` (src/runtime/attachments/store.mjs:619, `materializePastedTexts` :466-499) makes of a
// pasted text's `chars`, `sizeBytes` and `attachmentRef`, run unchanged from the exact export.
//
//   node benchmarks/rust-core/recorders/record-pasted-text-chars.mjs --tree <export dir>
// writes the set native/core/fixtures/pasted-text-chars (its one recording and its manifest).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NODE_COMMIT, verifyNodeExport } from '../../../apps/desktop/src/renderer/remote-protocol-chat-node-export.mjs';
import { FIXTURES_ROOT, nodeTreeIdentity, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const args = parseArgs();
const exportDir = resolveTree(args);
const setDir = join(FIXTURES_ROOT, 'pasted-text-chars');
// The export is the commit's tree, file by file, before anything of it runs.
verifyNodeExport(exportDir);
const dataDir = mkdtempSync(join(tmpdir(), 'pasted-chars-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }));
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
mkdirSync(setDir, { recursive: true });
writeJson(join(setDir, 'pasted-text-chars.json'), { recorder: 'benchmarks/rust-core/recorders/record-pasted-text-chars.mjs', commit: NODE_COMMIT, cases });
const { recorder, recorderSha256, nodeVersion, inputs: modules } = recorderProvenance(import.meta.url);
writeSetManifest(setDir, {
  set: 'pasted-text-chars',
  recorder,
  command: 'node benchmarks/rust-core/recorders/record-pasted-text-chars.mjs --tree <exact b6f10295a export>',
  extra: { recorderSha256, nodeVersion, inputs: modules },
  identity: nodeTreeIdentity(args, exportDir, NODE_COMMIT),
});
console.log(`recorded ${cases.length} cases`);
