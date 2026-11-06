#!/usr/bin/env node
// Parity goldens for the `read` tool's text and batch forms, through Node's public `file_path`
// surface. Each case lists the workspace files (as recipes a port can rebuild), the public args
// and what the real Node `read` returned: a string, or structured content when an image is in
// the batch. Every batch case is also recorded with an image ahead of it.
//
//   node record_batch.mjs --tree <Node product tree with node_modules>
import { createHash } from 'node:crypto';
import { utimesSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const tree = resolve(argv[argv.indexOf('--tree') + 1]);
const work = mkdtempSync(join(tmpdir(), 'mixdog-batch-golden-'));
process.env.MIXDOG_DATA_DIR = join(work, 'data');
const importFrom = (rel) => import(pathToFileURL(join(tree, rel)).href);
const { executeBuiltinTool } = await importFrom('src/runtime/agent/orchestrator/tools/builtin.mjs');
const { executePatchTool } = await importFrom('src/runtime/agent/orchestrator/tools/patch.mjs');
const sharp = createRequire(join(tree, 'package.json'))('sharp');
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
};
const adler32 = (buf) => {
  let a = 1;
  let b = 0;
  for (const x of buf) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
};
// zlib stream of stored blocks of at most 65535 bytes, header 78 01.
const stored = (raw) => {
  const parts = [Buffer.from([0x78, 0x01])];
  for (let at = 0; at < raw.length || at === 0; at += 65535) {
    const part = raw.subarray(at, at + 65535);
    const last = at + 65535 >= raw.length;
    const head = Buffer.alloc(5);
    head[0] = last ? 1 : 0;
    head.writeUInt16LE(part.length, 1);
    head.writeUInt16LE(~part.length & 0xffff, 3);
    parts.push(head, part);
    if (last) break;
  }
  parts.push(u32(adler32(raw)));
  return Buffer.concat(parts);
};
const flatPng = ({ width, height, rgb }) => {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', stored(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};


// Workspace recipes: { text } | { rows: [count, width] } (row n is `row-n` padded with `.` to
// width) | { hex } | { png }.
const FILES = {
  'lines.txt': { rows: [120, 0] },
  'long.txt': { rows: [1000, 0] },
  'a.txt': { text: 'alpha\nbeta\ngamma\n' },
  'b.txt': { text: 'one\ntwo\n' },
  'empty.txt': { text: '' },
  'crlf.txt': { text: 'x\r\ny\r\n' },
  'nonl.txt': { text: 'first\nlast' },
  'wide.txt': { rows: [400, 400] },
  'bin.dat': { hex: '0001020304ff' },
  'p.png': { png: { width: 30, height: 20, rgb: [10, 20, 30] } },
  'sub/c.txt': { text: 'c1\nc2\n' },
  'sub/d.txt': { text: 'd1\nd2\nd3\n' },
};
for (let i = 1; i <= 12; i++) FILES[`many/f${String(i).padStart(2, '0')}.txt`] = { text: `f${i}\n` };
// Encodings. `enc` re-encodes the text (with a BOM); `accent` ends each row with é or ü.
Object.assign(FILES, {
  'le.txt': { text: 'héllo\nwörld\n', enc: 'utf16le' },
  'be.txt': { text: 'héllo\nwörld\n', enc: 'utf16be' },
  'le-crlf.txt': { text: 'one\r\ntwo\r\n', enc: 'utf16le' },
  'le-empty.txt': { text: '', enc: 'utf16le' },
  'nobom16.txt': { hex: '610062006300 0a00640065006600 0a00'.replace(/ /g, '') },
  'latin1.txt': { hex: '636166e90a780a' },
  'bom8.txt': { hex: 'efbbbf626f6d0a6c696e650a' },
  'big16.txt': { rows: [6000, 40], accent: true, enc: 'utf16le' },
  'big16be.txt': { rows: [6000, 40], accent: true, enc: 'utf16be' },
  'big8.txt': { rows: [6000, 40], accent: true },
  'wide16.txt': { rows: [300, 300], accent: true, enc: 'utf16le' },
  'g/p.png': { png: { width: 30, height: 20, rgb: [10, 20, 30] } },
  'g/t.txt': { text: 'one\ntwo\n' },
  'g/u.md': { text: 'u1\n' },
  'big-nul-tail.dat': { rows: [3000, 40], nulTail: true },
});

const rowsText = ([count, width], accent) =>
  Array.from({ length: count }, (_, i) => {
    const s = `row-${i + 1}${accent ? (i % 2 ? ' é' : ' ü') : ''}`;
    return width > s.length ? s + '.'.repeat(width - s.length) : s;
  }).join('\n') + '\n';
const encode = (text, enc) => {
  if (!enc) return Buffer.from(text, 'utf8');
  const body = Buffer.from(text, 'utf16le');
  if (enc === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(body).swap16()]);
};
const fileBytes = (f) => {
  if (f.png) return flatPng(f.png);
  if (f.hex !== undefined) return Buffer.from(f.hex, 'hex');
  const bytes = encode(f.rows ? rowsText(f.rows, f.accent) : f.text, f.enc);
  return f.nulTail ? Buffer.concat([bytes, Buffer.from([0])]) : bytes;
};

const R = (file_path, extra = {}) => ({ file_path, ...extra });
const CASES = {
  'single-file': R('a.txt'),
  'single-window': R('lines.txt', { offset: 11, limit: 5 }),
  'single-to-end': R('lines.txt', { offset: 118, limit: 50 }),
  'single-past-end': R('a.txt', { offset: 10 }),
  'single-empty': R('empty.txt'),
  'single-crlf': R('crlf.txt'),
  'single-no-final-newline': R('nonl.txt'),
  'single-capped': R('wide.txt'),
  'single-capped-limit': R('wide.txt', { limit: 100000 }),
  'single-missing': R('nope.txt'),
  'single-dir': R('sub'),
  'single-binary': R('bin.dat'),
  'single-glob': R('many/*.txt'),
  'single-glob-window': R('many/*.txt', { limit: 1 }),
  'single-bad-offset': R('a.txt', { offset: 0 }),
  'batch-two': R(['a.txt', 'b.txt']),
  'batch-one': R(['a.txt']),
  'batch-repeat': R(['a.txt', 'a.txt']),
  'batch-repeat-other-window': R(['lines.txt', { file_path: 'lines.txt', offset: 3, limit: 2 }]),
  'batch-defaults': R(['lines.txt', 'a.txt'], { offset: 5, limit: 2 }),
  'batch-object-windows': R([{ file_path: 'lines.txt', offset: 2, limit: 3 }, { file_path: 'a.txt', offset: 2 }]),
  'batch-overlap': R([{ file_path: 'lines.txt', offset: 2, limit: 5 }, { file_path: 'lines.txt', offset: 4, limit: 5 }]),
  'batch-adjacent': R([{ file_path: 'lines.txt', offset: 1, limit: 2 }, { file_path: 'lines.txt', offset: 3, limit: 2 }]),
  'batch-gap-near': R([{ file_path: 'long.txt', offset: 1, limit: 2 }, { file_path: 'long.txt', offset: 100, limit: 2 }]),
  'batch-gap-far': R([{ file_path: 'long.txt', offset: 1, limit: 2 }, { file_path: 'long.txt', offset: 700, limit: 2 }]),
  'batch-three-windows': R([
    { file_path: 'long.txt', offset: 10, limit: 3 },
    { file_path: 'long.txt', offset: 1, limit: 3 },
    { file_path: 'long.txt', offset: 20, limit: 3 },
  ]),
  'batch-contained': R([{ file_path: 'lines.txt', offset: 1, limit: 50 }, { file_path: 'lines.txt', offset: 5, limit: 2 }]),
  'batch-two-spellings': R(['a.txt', './a.txt']),
  'batch-missing': R(['a.txt', 'nope.txt']),
  'batch-dir': R(['a.txt', 'sub']),
  'batch-empty-file': R(['a.txt', 'empty.txt']),
  'batch-crlf': R(['crlf.txt', 'b.txt']),
  'batch-binary': R(['a.txt', 'bin.dat']),
  'batch-past-end': R(['a.txt', { file_path: 'b.txt', offset: 50, limit: 2 }]),
  'batch-capped': R(['wide.txt', 'a.txt']),
  'batch-two-capped': R(['wide.txt', 'long.txt']),
  'batch-capped-window': R([{ file_path: 'wide.txt', offset: 1, limit: 400 }, 'b.txt']),
  'batch-limit-short': R(['lines.txt', 'long.txt'], { limit: 3 }),
  'batch-subdir': R(['sub/c.txt', 'sub/d.txt']),
  'batch-twelve-files': R(Array.from({ length: 12 }, (_, i) => `many/f${String(i + 1).padStart(2, '0')}.txt`)),
  'batch-glob-entry': R(['many/*.txt', 'a.txt']),
  'batch-extra-key': R([{ file_path: 'a.txt', mode: 'head' }]),
  'batch-bad-target': R([7]),
  'batch-bad-window': R([{ file_path: 'a.txt', offset: 0 }]),
  'batch-empty-array': R([]),
  'batch-path-line-suffix': R(['a.txt:2']),
  // Encodings: a UTF-16 file is always read whole and decoded (so its footer has a total, even in a
  // batch); no BOM and a NUL make it binary; a stray byte decodes lossily; a UTF-8 BOM is dropped.
  'enc-single-le': R('le.txt'),
  'enc-single-be': R('be.txt'),
  'enc-single-le-crlf': R('le-crlf.txt'),
  'enc-single-le-empty': R('le-empty.txt'),
  'enc-single-nobom16': R('nobom16.txt'),
  'enc-single-latin1': R('latin1.txt'),
  'enc-single-bom8': R('bom8.txt'),
  'enc-single-big16': R('big16.txt'),
  'enc-single-big16-window': R('big16.txt', { offset: 10, limit: 3 }),
  'enc-single-big16-tail': R('big16.txt', { offset: 5990, limit: 100 }),
  'enc-single-big16be-window': R('big16be.txt', { offset: 3000, limit: 2 }),
  'enc-single-big8-window': R('big8.txt', { offset: 10, limit: 3 }),
  'enc-single-big8-default': R('big8.txt'),
  'enc-single-wide16-capped': R('wide16.txt'),
  'enc-single-nul-tail': R('big-nul-tail.dat', { offset: 1, limit: 5 }),
  'enc-batch-all': R(['le.txt', 'be.txt', 'latin1.txt', 'bom8.txt', 'nobom16.txt']),
  'enc-batch-big16': R(['big16.txt']),
  'enc-batch-big16-window': R([{ file_path: 'big16.txt', offset: 5990, limit: 50 }, 'big8.txt']),
  'enc-batch-wide16': R(['wide16.txt', 'a.txt']),
  'enc-batch-empty16': R(['le-empty.txt', 'a.txt']),
  'enc-batch-overlap16': R([{ file_path: 'le.txt', offset: 1, limit: 1 }, { file_path: 'le.txt', offset: 2, limit: 1 }]),
  // Globs: one match is read as that file, several are a batch; an image among them stays an image.
  'glob-one-text': R('g/t*.txt'),
  'glob-one-image': R('g/*.png'),
  'glob-two-with-image': R('g/*'),
  'glob-nested-with-image': R(['g/*', 'a.txt']),
  'glob-nested-one-match': R(['g/t*.txt', 'a.txt']),
  'glob-nested-one-image': R(['g/*.png', 'a.txt']),
  'glob-nested-after-image': R(['p.png', 'g/*']),
  'glob-nested-no-match': R(['g/*.zzz', 'a.txt']),
  'glob-no-match': R('g/*.zzz'),
};
// Image variants: the same arguments with an image ahead of the targets.
const withImage = (input) =>
  Array.isArray(input.file_path) && input.file_path.length > 0 && input.file_path.length < 10
    ? { ...input, file_path: ['p.png', ...input.file_path] }
    : null;

const cases = [];
for (const [name, input] of Object.entries(CASES)) {
  cases.push({ name, input });
  const image = withImage(input);
  if (image) cases.push({ name: `${name}+image`, input: image });
}
cases.push({ name: 'image-alone-batch', input: R(['p.png']) });
cases.push({ name: 'image-twice-batch', input: R(['p.png', 'p.png']) });
cases.push({ name: 'image-window-entry', input: R([{ file_path: 'p.png', offset: 1, limit: 5 }, 'a.txt']) });
cases.push({ name: 'image-missing-batch', input: R(['missing.png', 'a.txt']) });

const used = new Set(Object.keys(FILES));
// The workspace path inside a message is a placeholder in the recording.
let wsText = '';
const scrub = (s) => (typeof s === 'string' && wsText ? s.split(wsText).join('<WS>') : s);
const summarize = async (raw) => {
  if (typeof raw === 'string') return { text: scrub(raw) };
  const content = [];
  for (const block of raw.content ?? []) {
    if (block.type !== 'image') {
      content.push({ type: block.type, text: scrub(block.text) });
      continue;
    }
    const meta = await sharp(Buffer.from(block.data, 'base64')).metadata();
    content.push({
      type: 'image',
      mimeType: block.mimeType,
      base64Length: block.data.length,
      base64Sha256: createHash('sha256').update(block.data).digest('hex'),
      width: meta.width,
      height: meta.height,
    });
  }
  return { content, isError: raw.isError === true };
};

const ws = join(work, 'ws');
for (const [rel, f] of Object.entries(FILES)) {
  mkdirSync(dirname(join(ws, rel)), { recursive: true });
  writeFileSync(join(ws, rel), fileBytes(f));
}
// Newest-first glob order needs distinct, fixed mtimes.
const stamp = (rel, n) => { const at = new Date(1700000000000 + n * 1000); utimesSync(join(ws, rel), at, at); };
Object.keys(FILES).forEach((rel, n) => stamp(rel, n));
wsText = ws.replace(/\\/g, '/');
const recorded = [];
for (const c of cases) {
  const raw = await executeBuiltinTool('read', structuredClone(c.input), ws);
  recorded.push({ name: c.name, input: c.input, result: await summarize(raw) });
}
// Sequences: calls in one session over a fresh workspace, which is what the read state answers to.
const R1 = (file_path, extra = {}) => ({ file_path, ...extra });
const SEQUENCES = [
  { name: 'read-twice', steps: [{ input: R1('a.txt') }, { input: R1('a.txt') }, { input: R1('a.txt') }] },
  { name: 'window-twice', steps: [{ input: R1('a.txt', { offset: 2, limit: 1 }) }, { input: R1('a.txt', { offset: 2, limit: 1 }) }, { input: R1('a.txt') }, { input: R1('a.txt', { offset: 3, limit: 1 }) }] },
  {
    name: 'ranged-partial',
    steps: [
      { input: R1('long.txt', { offset: 1, limit: 10 }) },
      { input: R1('long.txt', { offset: 1, limit: 10 }) },
      { input: R1('long.txt', { offset: 100, limit: 10 }) },
      { input: R1('long.txt', { offset: 100, limit: 10 }) },
      { input: R1('long.txt') },
      { input: R1('long.txt') },
      { input: R1('long.txt', { offset: 5, limit: 3 }) },
    ],
  },
  { name: 'batch-never-stubs', steps: [{ input: R1('a.txt') }, { input: R1(['a.txt']) }, { input: R1(['a.txt', 'b.txt']) }, { input: R1('a.txt') }] },
  {
    name: 'edit-then-read',
    steps: [
      { input: R1('a.txt') },
      { tool: 'edit', input: { file_path: 'a.txt', old_string: 'beta', new_string: 'BETA' } },
      { input: R1('a.txt') },
      { input: R1('a.txt') },
      { input: R1('a.txt', { offset: 2, limit: 1 }) },
    ],
  },
  {
    name: 'edit-unread',
    steps: [{ tool: 'edit', input: { file_path: 'a.txt', old_string: 'beta', new_string: 'BETA' } }, { input: R1('a.txt') }, { input: R1('a.txt') }],
  },
  {
    name: 'edit-after-partial-read',
    steps: [
      { input: R1('long.txt', { offset: 1, limit: 10 }) },
      { tool: 'edit', input: { file_path: 'long.txt', old_string: 'row-3\nrow-4', new_string: 'ROW-3\nrow-4' } },
      { input: R1('long.txt') },
      { input: R1('long.txt') },
    ],
  },
  {
    name: 'patch-then-read',
    steps: [
      { input: R1('a.txt') },
      { tool: 'apply_patch', input: { patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+ALPHA\n*** End Patch\n' } },
      { input: R1('a.txt') },
      { input: R1('a.txt') },
    ],
  },
  { name: 'external-change', steps: [{ input: R1('a.txt') }, { write: { path: 'a.txt', text: 'alpha\nbeta\nDELTA\n' } }, { input: R1('a.txt') }, { input: R1('a.txt') }] },
  {
    name: 'external-then-edit',
    steps: [
      { input: R1('a.txt') },
      { write: { path: 'a.txt', text: 'alpha\nbeta\nDELTA\n' } },
      { tool: 'edit', input: { file_path: 'a.txt', old_string: 'beta', new_string: 'BETA' } },
      { input: R1('a.txt') },
    ],
  },
  { name: 'cache-lifetime', steps: [{ input: R1('a.txt') }, { sleepMs: 31000 }, { input: R1('a.txt') }, { input: R1('a.txt') }] },
  {
    name: 'two-sessions',
    steps: [{ session: 'one', input: R1('a.txt') }, { session: 'two', input: R1('a.txt') }, { session: 'two', input: R1('a.txt') }, { session: 'one', input: R1('a.txt') }],
  },
  { name: 'two-files', steps: [{ input: R1('a.txt') }, { input: R1('b.txt') }, { input: R1('a.txt') }, { input: R1('b.txt') }] },
  { name: 'over-cache-size', steps: [{ input: R1('wide.txt', { offset: 1, limit: 3 }) }, { input: R1('wide.txt', { offset: 1, limit: 3 }) }] },
  {
    name: 'special-bodies',
    steps: [{ input: R1('bin.dat') }, { input: R1('bin.dat') }, { input: R1('empty.txt') }, { input: R1('empty.txt') }, { input: R1('le.txt') }, { input: R1('le.txt') }, { input: R1('nope.txt') }, { input: R1('nope.txt') }],
  },
  { name: 'glob-twice', steps: [{ input: R1('many/*.txt') }, { input: R1('many/*.txt') }, { input: R1('g/t*.txt') }, { input: R1('g/t*.txt') }] },
  { name: 'image-twice', steps: [{ input: R1('p.png') }, { input: R1('p.png') }] },
  { name: 'no-session', steps: [{ session: null, input: R1('a.txt') }, { session: null, input: R1('a.txt') }] },
];
const sequences = [];
for (const [n, seq] of SEQUENCES.entries()) {
  const dir = join(work, 'seq', String(n));
  for (const [rel, f] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), fileBytes(f));
  }
  Object.keys(FILES).forEach((rel, i) => {
    const at = new Date(1700000000000 + i * 1000);
    utimesSync(join(dir, rel), at, at);
  });
  wsText = dir.replace(/\\/g, '/');
  const steps = [];
  let bump = 0;
  for (const step of seq.steps) {
    if (step.sleepMs) {
      await new Promise((r) => setTimeout(r, step.sleepMs));
      steps.push({ sleepMs: step.sleepMs });
      continue;
    }
    if (step.write) {
      const p = join(dir, step.write.path);
      writeFileSync(p, step.write.text);
      bump += 5;
      const at = new Date(1700001000000 + bump * 1000);
      utimesSync(p, at, at);
      steps.push({ write: step.write });
      continue;
    }
    const session = step.session === undefined ? 's1' : step.session;
    const options = session === null ? {} : { sessionId: session };
    const run = step.tool === 'apply_patch' ? (name, a, d, o) => executePatchTool(name, a, d, o) : executeBuiltinTool;
    const raw = await run(step.tool ?? 'read', structuredClone(step.input), dir, options);
    steps.push({ tool: step.tool ?? 'read', session, input: step.input, result: await summarize(raw) });
  }
  sequences.push({ name: seq.name, steps });
}
const out = join(dirname(fileURLToPath(import.meta.url)), 'batch_cases.json');
writeFileSync(out, `${JSON.stringify({ files: FILES, cases: recorded, sequences }, null, 1)}\n`);
rmSync(work, { recursive: true, force: true });
console.log(`recorded ${recorded.length} cases -> ${out}`);
