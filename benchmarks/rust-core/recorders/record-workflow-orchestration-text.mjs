#!/usr/bin/env node
// Golden of `orchestrationInstructions(mode)` (`runtime-core/orchestration.mjs`) and of the
// instruction-file decode under it (`lib/instruction-text.cjs`, `readInstructionFile`):
// `native/core/fixtures/workflow-surface/orchestration.json`.
//
// Every case is a sandbox of two folders, the install root (`MIXDOG_ROOT`, shipped
// `orchestration/<mode>.md`) and the data dir (`MIXDOG_DATA_DIR`, the user's replacements),
// written from byte specs. Recorded per case: what `readInstructionFile` answers for the user
// and the shipped file of the mode (`null` for a missing file, `{ text }`, or `{ problem }`) and
// the text `orchestrationInstructions(mode)` returns. A text over 4096 characters is recorded as
// its UTF-16 length and the sha256 of its UTF-8 bytes.
//
//   node benchmarks/rust-core/recorders/record-workflow-orchestration-text.mjs --tree <tree>
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const sandbox = mkdtempSync(join(tmpdir(), 'mixdog-orchestration-text-'));
for (const [name, dir] of [['HOME', 'home'], ['USERPROFILE', 'home'], ['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata']]) {
  mkdirSync(join(sandbox, dir), { recursive: true });
  process.env[name] = join(sandbox, dir);
}
process.env.MIXDOG_HOME = join(sandbox, 'mixdog-home');
process.env.MIXDOG_DATA_DIR = join(sandbox, 'mixdog-home', 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';

const orchestration = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/orchestration.mjs');

const hex = (...parts) => ({ hex: Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part)))).toString('hex') });
const fill = (byte, len) => ({ fill: byte, len });
const bytesOf = (spec) => (spec.hex !== undefined ? Buffer.from(spec.hex, 'hex') : Buffer.alloc(spec.len, spec.fill));
const BOM = [0xef, 0xbb, 0xbf];
const SHIPPED = (mode) => hex(`shipped ${mode}\r\nsecond line  \r\n\r\n`);

// `user` / `shipped`: file name -> byte spec, or `{ dir: true }` for a directory, or
// `{ parentIsFile: true }` to make the folder holding the file a plain file.
const CASES = [
  { name: 'user-text-replaces-shipped', mode: 'none', user: { 'none.md': hex('User text\r\nline two  \n\n') }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-missing-uses-shipped', mode: 'focused', shipped: { 'focused.md': SHIPPED('focused') } },
  { name: 'both-missing', mode: 'balanced' },
  { name: 'user-zero-bytes', mode: 'swarm', user: { 'swarm.md': hex() }, shipped: { 'swarm.md': SHIPPED('swarm') } },
  { name: 'user-blank-only', mode: 'none', user: { 'none.md': hex('  \n\t\r\n ') }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-nul-only', mode: 'none', user: { 'none.md': hex([0, 0, 0]) }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-nul-and-blank', mode: 'none', user: { 'none.md': hex([0, 0x20, 0x09, 0x0a, 0x0d, 0]) }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-nul-inside', mode: 'none', user: { 'none.md': hex('abc', [0], 'def') }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-invalid-utf8', mode: 'none', user: { 'none.md': hex('ok ', [0xff, 0xfe, 0xfd], ' end') }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-latin1', mode: 'none', user: { 'none.md': hex('caf', [0xe9]) }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-overlong-utf8', mode: 'none', user: { 'none.md': hex('a', [0xc0, 0xaf]) }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-encoded-surrogate', mode: 'none', user: { 'none.md': hex('a', [0xed, 0xa0, 0x80]) }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-truncated-sequence', mode: 'none', user: { 'none.md': hex('a', [0xe2, 0x82]) }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-utf16le', mode: 'none', user: { 'none.md': hex([0xff, 0xfe, 0x41, 0x00]) }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-bom', mode: 'none', user: { 'none.md': hex(BOM, 'Hello\r\n') }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-two-boms', mode: 'none', user: { 'none.md': hex(BOM, BOM, 'Hello') }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-three-boms', mode: 'none', user: { 'none.md': hex(BOM, BOM, BOM, 'Hello') }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-bom-only', mode: 'none', user: { 'none.md': hex(BOM) }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-bom-then-blank', mode: 'none', user: { 'none.md': hex(BOM, '  \n') }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-no-break-space-only', mode: 'none', user: { 'none.md': hex([0xc2, 0xa0]) }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-trailing-js-whitespace', mode: 'none', user: { 'none.md': hex('x \u00a0\u2028\u2029\ufeff\u3000\t \r\n') }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-leading-and-lone-cr-kept', mode: 'none', user: { 'none.md': hex('\n  lead\ra\r\nb\r\r\n') }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-astral-and-interior-bom', mode: 'none', user: { 'none.md': hex('a\ufeffb \ud83d\ude00 \u{10ffff}') }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-exactly-the-limit', mode: 'none', user: { 'none.md': fill(0x61, 262144) }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-over-the-limit', mode: 'none', user: { 'none.md': fill(0x61, 262145) }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-blank-over-the-limit', mode: 'none', user: { 'none.md': fill(0x20, 262145) }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-is-a-folder', mode: 'none', user: { 'none.md': { dir: true } }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'user-folder-is-a-file', mode: 'none', user: { parentIsFile: true }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'shipped-zero-bytes', mode: 'none', shipped: { 'none.md': hex() } },
  { name: 'shipped-nul', mode: 'none', shipped: { 'none.md': hex('a', [0]) } },
  { name: 'shipped-is-a-folder', mode: 'none', shipped: { 'none.md': { dir: true } } },
  { name: 'shipped-over-the-limit', mode: 'none', shipped: { 'none.md': fill(0x62, 262145) } },
  { name: 'shipped-text-big', mode: 'none', shipped: { 'none.md': fill(0x62, 262144) } },
  { name: 'user-problem-and-shipped-problem', mode: 'none', user: { 'none.md': hex([0]) }, shipped: { 'none.md': hex('  ') } },
  { name: 'unknown-mode-reads-none', mode: 'bogus', user: { 'none.md': hex('the none text'), 'bogus.md': hex('never read') }, shipped: { 'none.md': SHIPPED('none') } },
  { name: 'mode-is-case-sensitive', mode: 'Balanced', user: { 'none.md': hex('the none text'), 'balanced.md': hex('never read') } },
  { name: 'empty-mode-reads-none', mode: '', user: { 'none.md': hex('the none text') } },
  { name: 'mode-with-padding-reads-none', mode: ' swarm', user: { 'none.md': hex('the none text'), 'swarm.md': hex('never read') } },
  { name: 'each-mode-has-its-own-file', mode: 'swarm', user: { 'none.md': hex('n'), 'focused.md': hex('f'), 'balanced.md': hex('b'), 'swarm.md': hex('s') } },
  { name: 'balanced-mode', mode: 'balanced', user: { 'none.md': hex('n'), 'focused.md': hex('f'), 'balanced.md': hex('b'), 'swarm.md': hex('s') } },
];

const recordText = (text) =>
  text.length > 4096 ? { len: text.length, sha256: createHash('sha256').update(text, 'utf8').digest('hex') } : { text };
const recordRead = (read) => (read === null ? null : read.problem ? { problem: read.problem } : recordText(read.text));

function lay(folder, files) {
  if (!files) return;
  mkdirSync(folder, { recursive: true });
  if (files.parentIsFile) {
    rmSync(folder, { recursive: true });
    mkdirSync(dirname(folder), { recursive: true });
    writeFileSync(folder, 'not a folder');
    return;
  }
  for (const [name, spec] of Object.entries(files)) {
    if (spec.dir) mkdirSync(join(folder, name), { recursive: true });
    else writeFileSync(join(folder, name), bytesOf(spec));
  }
}

const recorded = [];
for (const [index, scenario] of CASES.entries()) {
  const root = join(sandbox, `case-${index}`, 'root');
  const data = join(sandbox, `case-${index}`, 'data');
  mkdirSync(root, { recursive: true });
  mkdirSync(data, { recursive: true });
  process.env.MIXDOG_ROOT = root;
  process.env.MIXDOG_DATA_DIR = data;
  lay(join(data, 'orchestration'), scenario.user);
  lay(join(root, 'orchestration'), scenario.shipped);
  const userFile = orchestration.userOrchestrationPath(scenario.mode);
  const shippedFile = orchestration.shippedOrchestrationPath(scenario.mode);
  recorded.push({
    name: scenario.name,
    mode: scenario.mode,
    modeFile: userFile.slice(join(data, 'orchestration').length + 1),
    user: scenario.user ?? null,
    shipped: scenario.shipped ?? null,
    readUser: recordRead(orchestration.readInstructionFile(userFile)),
    readShipped: recordRead(orchestration.readInstructionFile(shippedFile)),
    instructions: recordText(orchestration.orchestrationInstructions(scenario.mode)),
  });
}
rmSync(sandbox, { recursive: true, force: true });
writeJson(join(FIXTURES_ROOT, 'workflow-surface', 'orchestration.json'), { cases: recorded });
console.log(`recorded ${recorded.length} cases`);
