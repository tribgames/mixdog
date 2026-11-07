#!/usr/bin/env node
// Golden twin of `restoreQueued(currentText, selectedId)` (src/tui/session/session-flow/queue/take-entries.mjs): the
// queued entries given back to the composer, with the pasted images, pasted texts and file parts read from the prompt
// attachment store. Each case lists the queue as Node holds it, the blobs on disk, and the reply.
//
//   MIXDOG_DATA_DIR=<temp> MIXDOG_HOME=<temp> HOME=<temp> USERPROFILE=<temp> APPDATA=<temp> LOCALAPPDATA=<temp> MIXDOG_SKIP_USER_DATA_BACKUP=1 \
//     node --experimental-transform-types benchmarks/rust-core/recorders/record-restore-queued.mjs --tree <dir>
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'restore-queued-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const tree = resolveTree(parseArgs());
const { createTakeEntriesOps } = await importFrom(tree, 'src/tui/session/session-flow/queue/take-entries.mjs');

const BLOBS = { image: 'PNGBYTES-one', image2: 'PNGBYTES-two', text: 'pasted body\nline two', pdf: '%PDF-1.7 bytes' };
const refOf = (bytes) => createHash('sha256').update(bytes).digest('hex');
const REFS = Object.fromEntries(Object.entries(BLOBS).map(([name, bytes]) => [name, refOf(bytes)]));
const MISSING = (seed) => refOf(`missing-${seed}`);
const blobs = {};
for (const [name, bytes] of Object.entries(BLOBS)) {
  const ref = REFS[name];
  mkdirSync(join(dataDir, 'prompt-attachments', 'sha256', ref.slice(0, 2)), { recursive: true });
  writeFileSync(join(dataDir, 'prompt-attachments', 'sha256', ref.slice(0, 2), ref), bytes);
  blobs[ref] = Buffer.from(bytes).toString('base64');
}

const image = (ref, extra = {}) => ({ attachmentRef: ref, mimeType: 'image/png', filename: 'p.png', ...extra });
const textPart = (text) => ({ type: 'text', text });
const filePart = (ref, filename) => ({ type: 'file', attachmentRef: ref, mimeType: 'application/pdf', filename });

const CASES = [
  { name: 'one entry by id', entries: [{ id: 'q1', text: 'hello' }, { id: 'q2', text: 'other' }], currentText: '', selectedId: 'q1' },
  { name: 'the composer text follows', entries: [{ id: 'q1', text: 'hello' }], currentText: 'draft', selectedId: 'q1' },
  { name: 'a blank entry and a blank composer', entries: [{ id: 'q1', text: '  ' }], currentText: ' ', selectedId: 'q1' },
  { name: 'no id restores every entry in order', entries: [{ id: 'q1', text: 'one' }, { id: 'q2', text: 'two' }], currentText: 'draft', selectedId: '' },
  { name: 'an id that is not queued', entries: [{ id: 'q1', text: 'hello' }], currentText: 'draft', selectedId: 'zz' },
  { name: 'nothing queued, no id', entries: [], currentText: 'draft', selectedId: '' },
  {
    name: 'inline pasted buffers come back as they were',
    entries: [{ id: 'q1', text: 'see [Image #1]', pastedImages: { 1: { data: 'AAAA', mimeType: 'image/png' } }, pastedTexts: { 1: { text: 'inline text' } } }],
    currentText: '',
    selectedId: 'q1',
  },
  {
    name: 'referenced pasted buffers are read from the store',
    entries: [{ id: 'q1', text: 'a [Image #1] b', pastedImages: { 1: image(REFS.image) }, pastedTexts: { 1: { attachmentRef: REFS.text, filename: 'n.txt' } } }],
    currentText: '',
    selectedId: 'q1',
  },
  {
    name: 'two entries merge their buffers, a falsy one skipped',
    entries: [
      { id: 'q1', text: 'x', pastedImages: { 1: image(REFS.image), 2: null } },
      { id: 'q2', text: 'y', pastedImages: { 3: image(REFS.image2) }, pastedTexts: { 1: { attachmentRef: REFS.text } } },
    ],
    currentText: '',
    selectedId: '',
  },
  {
    name: 'one unreadable image is dropped alone and reported',
    entries: [{ id: 'q1', text: 'keep', pastedImages: { 1: image(MISSING('a')), 2: image(REFS.image) } }],
    currentText: '',
    selectedId: 'q1',
  },
  {
    name: 'two unreadable attachments are reported together',
    entries: [{ id: 'q1', text: 'keep', pastedImages: { 1: image(MISSING('b')) }, pastedTexts: { 1: { attachmentRef: MISSING('c') } } }],
    currentText: '',
    selectedId: 'q1',
  },
  {
    name: 'file parts are given back with their bytes',
    entries: [
      {
        id: 'q1',
        text: 'read this',
        content: [textPart('read this'), filePart(REFS.pdf, 'a.pdf'), { type: 'file', data: 'QUJD', mimeType: 'application/pdf', filename: 'inline.pdf' }, { type: 'file', mimeType: 'application/pdf', filename: 'empty.pdf' }],
      },
    ],
    currentText: '',
    selectedId: 'q1',
  },
  {
    name: 'an unreadable file part is dropped and reported',
    entries: [{ id: 'q1', text: 'read', content: [textPart('read'), filePart(MISSING('d'), 'gone.pdf'), filePart(REFS.pdf, 'a.pdf')] }],
    currentText: '',
    selectedId: 'q1',
  },
];

const results = [];
for (const spec of CASES) {
  const pending = spec.entries.map((entry) => ({ ...entry, mode: 'prompt', priority: 'next' }));
  const ops = createTakeEntriesOps({ pending, pendingNotificationKeys: new Set(), removeQueuedEntries() {}, leadSessionId: () => 'recorder' });
  const reply = ops.restoreQueued(spec.currentText, spec.selectedId);
  results.push({ ...spec, reply, left: pending.map((entry) => entry.id) });
}

const out = join(FIXTURES_ROOT, 'desktop', 'queue', 'restore-queued-twin.json');
mkdirSync(join(FIXTURES_ROOT, 'desktop', 'queue'), { recursive: true });
writeFileSync(out, `${JSON.stringify({ domain: 'queue', recorder: 'benchmarks/rust-core/recorders/record-restore-queued.mjs', blobs, cases: results }, null, 2)}\n`);
console.log(`${results.length} cases -> ${out}`);
