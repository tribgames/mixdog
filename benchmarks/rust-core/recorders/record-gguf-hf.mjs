#!/usr/bin/env node
// Golden twin of the GGUF metadata parser and memory plan (`local-provider/gguf-header.mjs`) and of
// the Hugging Face search/inspect/register flow (`local-provider/hugging-face.mjs`): Node's real
// code over binary headers built here and a scripted `fetch`. Rust `local_provider::gguf` and
// `local_provider::hugging_face` must give the same answers, and (for the Hugging Face flow) must
// ask the same URLs and byte ranges in the same order.
//
//   node benchmarks/rust-core/recorders/record-gguf-hf.mjs --tree <dir>
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { parseGgufHeader, ggufMemoryPlan } = await importFrom(tree, 'src/runtime/local-provider/gguf-header.mjs');
const { createHuggingFaceCatalog } = await importFrom(tree, 'src/runtime/local-provider/hugging-face.mjs');

// ---- GGUF builder ----------------------------------------------------------------------------
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const i32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const f32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(n);
  return b;
};
const str = (s) => {
  const d = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8');
  return Buffer.concat([u64(d.length), d]);
};
const kv = (key, type, payload) => Buffer.concat([str(key), u32(type), payload]);
const K = {
  u32: (k, v) => kv(k, 4, u32(v)),
  i32: (k, v) => kv(k, 5, i32(v)),
  u64: (k, v) => kv(k, 10, u64(v)),
  f32: (k, v) => kv(k, 6, f32(v)),
  bool: (k, v) => kv(k, 7, Buffer.from([v ? 1 : 0])),
  str: (k, v) => kv(k, 8, str(v)),
  arr: (k, element, count, payload) => kv(k, 9, Buffer.concat([u32(element), u64(count), payload])),
};
const gguf = (kvs, { version = 3, tensors = 1, count = kvs.length } = {}) =>
  Buffer.concat([Buffer.from('GGUF'), u32(version), u64(tensors), u64(count), ...kvs]);

const ARCH = 'llama';
const base = (over = {}) => {
  const m = { 'general.architecture': ARCH, [`${ARCH}.context_length`]: 131072, [`${ARCH}.block_count`]: 32, [`${ARCH}.embedding_length`]: 4096, [`${ARCH}.attention.head_count`]: 32, [`${ARCH}.attention.head_count_kv`]: 8, ...over };
  return Object.entries(m)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => (typeof v === 'string' ? K.str(k, v) : K.u32(k, v)));
};
const BASE = gguf(base());

// ---- parser cases ----------------------------------------------------------------------------
const parseCases = [];
const parseCase = (name, buffer) => parseCases.push({ name, buffer });
parseCase('base', BASE);
for (const n of [0, 1, 3, 4, 7, 8, 15, 16, 23, 24, 30, 40, 60, 100, BASE.length - 1]) parseCase(`prefix ${n}`, BASE.subarray(0, n));
parseCase('trailing bytes are ignored', Buffer.concat([BASE, Buffer.alloc(100, 7)]));
parseCase('bad magic', Buffer.concat([Buffer.from('GGUX'), BASE.subarray(4)]));
parseCase('four bytes only', Buffer.from('GGUF'));
for (const version of [0, 1, 2, 3, 4, 99]) parseCase(`version ${version}`, gguf(base(), { version }));
parseCase('no tensors', gguf(base(), { tensors: 0 }));
parseCase('huge tensor count', Buffer.concat([Buffer.from('GGUF'), u32(3), u64(2n ** 53n), u64(1)]));
parseCase('safe-integer tensor count', Buffer.concat([Buffer.from('GGUF'), u32(3), u64(2n ** 53n - 1n), u64(0)]));
parseCase('count over the limit', gguf([], { count: 100_001 }));
parseCase('count claims more than present', gguf(base(), { count: 99 }));
parseCase('count of zero', gguf([], { count: 0 }));
parseCase('empty architecture with keys', gguf([K.str('general.architecture', ''), ...base({ 'general.architecture': undefined })].concat([K.u32('.context_length', 1)])));
// Not recorded: a numeric `general.architecture` is accepted by Node (it keeps the number), a
// corrupt file no real model has; Rust refuses it as unsupported.
parseCase('architecture missing', gguf(base({ 'general.architecture': undefined })));
parseCase('attention keys missing', gguf(base({ [`${ARCH}.attention.head_count_kv`]: undefined })));
parseCase('keys for another architecture', gguf(base({ 'general.architecture': 'qwen2' })));
parseCase('duplicate key, last wins', gguf([...base(), K.u32(`${ARCH}.context_length`, 20000)]));
parseCase('retained key as bool', gguf([...base({ [`${ARCH}.block_count`]: undefined }), K.bool(`${ARCH}.block_count`, true)]));
parseCase('retained key as string', gguf([...base({ [`${ARCH}.block_count`]: undefined }), K.str(`${ARCH}.block_count`, '32')]));
parseCase('retained key as f32', gguf([...base({ [`${ARCH}.block_count`]: undefined }), K.f32(`${ARCH}.block_count`, 32)]));
parseCase('retained key as NaN', gguf([...base({ [`${ARCH}.block_count`]: undefined }), K.f32(`${ARCH}.block_count`, NaN)]));
parseCase('retained key as infinity', gguf([...base({ [`${ARCH}.block_count`]: undefined }), K.f32(`${ARCH}.block_count`, Infinity)]));
parseCase('retained key as i32', gguf([...base({ [`${ARCH}.block_count`]: undefined }), K.i32(`${ARCH}.block_count`, -3)]));
parseCase('retained key as u64', gguf([...base({ [`${ARCH}.block_count`]: undefined }), K.u64(`${ARCH}.block_count`, 2n ** 60n)]));
for (const [type, width] of [[0, 1], [1, 1], [2, 2], [3, 2], [11, 8], [12, 8]]) {
  parseCase(`retained key as type ${type}`, gguf([...base({ [`${ARCH}.block_count`]: undefined }), kv(`${ARCH}.block_count`, type, Buffer.alloc(width, 1))]));
}
parseCase('retained key as array', gguf([...base({ [`${ARCH}.block_count`]: undefined }), K.arr(`${ARCH}.block_count`, 4, 2, Buffer.alloc(8))]));
parseCase('retained key as u32 array of one', gguf([...base(), K.arr('tokenizer.ggml.scores', 6, 3, Buffer.alloc(12))]));
for (const type of [0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12]) {
  parseCase(`unretained type ${type}`, gguf([K.str('general.name', 'x'), kv('other.value', type, Buffer.alloc(8, 2)), ...base()]));
}
parseCase('unsupported type 13', gguf([kv('other', 13, Buffer.alloc(8)), ...base()]));
parseCase('unsupported type 99', gguf([kv('other', 99, Buffer.alloc(8)), ...base()]));
parseCase('array of strings', gguf([K.arr('tokenizer.ggml.tokens', 8, 3, Buffer.concat([str('a'), str('bb'), str('')])), ...base()]));
parseCase('array of strings cut short', gguf([K.arr('tokenizer.ggml.tokens', 8, 3, Buffer.concat([str('a'), str('bb')])), ...base()]));
parseCase('array of numbers', gguf([K.arr('t.scores', 6, 4, Buffer.alloc(16)), ...base()]));
parseCase('array payload cut short', gguf([K.arr('t.scores', 6, 4, Buffer.alloc(15))]));
parseCase('empty array', gguf([K.arr('t.empty', 4, 0, Buffer.alloc(0)), ...base()]));
parseCase('array of arrays', gguf([K.arr('t.nested', 9, 1, Buffer.concat([u32(4), u64(1), Buffer.alloc(4)])), ...base()]));
parseCase('array of arrays of arrays', gguf([K.arr('t.nested', 9, 1, Buffer.concat([u32(9), u64(1), u32(4), u64(1), Buffer.alloc(4)])), ...base()]));
parseCase('array of arrays, empty', gguf([K.arr('t.nested', 9, 0, Buffer.alloc(0)), ...base()]));
parseCase('array with unsupported element and count 0', gguf([K.arr('t.odd', 99, 0, Buffer.alloc(0)), ...base()]));
parseCase('array with unsupported element', gguf([K.arr('t.odd', 99, 1, Buffer.alloc(8)), ...base()]));
parseCase('array over the count limit', gguf([K.arr('t.big', 4, 1_000_001, Buffer.alloc(0))]));
parseCase('array at the count limit, cut short', gguf([K.arr('t.big', 0, 1_000_000, Buffer.alloc(10))]));
parseCase('array count above safe integer', gguf([K.arr('t.big', 4, 2n ** 53n, Buffer.alloc(0))]));
parseCase('string over the limit', gguf([kv('a', 8, Buffer.concat([u64(16 * 1024 * 1024 + 1)]))]));
parseCase('string at the limit, cut short', gguf([kv('a', 8, Buffer.concat([u64(16 * 1024 * 1024), Buffer.alloc(8)]))]));
parseCase('string length above safe integer', gguf([kv('a', 8, u64(2n ** 53n))]));
parseCase('key of 1024 units', gguf([K.u32('k'.repeat(1024), 1), ...base()]));
parseCase('key of 1025 units', gguf([K.u32('k'.repeat(1025), 1), ...base()]));
parseCase('key of 512 astral characters', gguf([K.u32('😀'.repeat(512), 1), ...base()]));
parseCase('key of 513 astral characters', gguf([K.u32('😀'.repeat(513), 1), ...base()]));
parseCase('key with invalid utf-8', gguf([kv(Buffer.from([0xff, 0xfe, 0x61]), 4, u32(1)), ...base()]));
parseCase('invalid utf-8 architecture', gguf([K.str('general.architecture', Buffer.from([0x6c, 0xff])), ...base({ 'general.architecture': undefined })]));
for (const suffix of ['context_length', 'block_count', 'embedding_length', 'head_count', 'head_count_kv', 'key_length', 'value_length']) {
  parseCase(`extra retained suffix ${suffix}`, gguf([K.u32(`x.${suffix}`, 7), K.u32(`${suffix}`, 8), K.u32(`x${suffix}`, 9), K.u32(`x.${suffix}.y`, 10), K.u32(`x.${suffix}\n`, 11), ...base()]));
}
parseCase('attention key and value lengths', gguf(base({ [`${ARCH}.attention.key_length`]: 192, [`${ARCH}.attention.value_length`]: 128 })));
parseCase('hybrid keys', gguf([...base(), K.u32('llama.rope.dimension_count', 128), K.u32('x.y.z.head_count', 3)]));

const PARSED = (buffer) => {
  try {
    const h = parseGgufHeader(buffer);
    return { ok: { version: h.version, architecture: h.architecture, metadata: h.metadata }, header: h };
  } catch (error) {
    return { error: { message: error.message, code: error.code ?? null } };
  }
};

// ---- memory plan cases -----------------------------------------------------------------------
const planHeaders = [
  ['base', BASE],
  ['context 8192', gguf(base({ [`${ARCH}.context_length`]: 8192 }))],
  ['context 16384', gguf(base({ [`${ARCH}.context_length`]: 16384 }))],
  ['context 20000', gguf(base({ [`${ARCH}.context_length`]: 20000 }))],
  ['context 16383', gguf(base({ [`${ARCH}.context_length`]: 16383 }))],
  ['embedding 4097', gguf(base({ [`${ARCH}.embedding_length`]: 4097 }))],
  ['embedding 4097 with key and value 128', gguf(base({ [`${ARCH}.embedding_length`]: 4097, [`${ARCH}.attention.key_length`]: 128, [`${ARCH}.attention.value_length`]: 128 }))],
  ['key 192 value 128', gguf(base({ [`${ARCH}.attention.key_length`]: 192, [`${ARCH}.attention.value_length`]: 128 }))],
  ['key 0 value 0', gguf(base({ [`${ARCH}.attention.key_length`]: 0, [`${ARCH}.attention.value_length`]: 0 }))],
  ['key 100.5', gguf([...base(), K.f32(`${ARCH}.attention.key_length`, 100.5)])],
  ['key NaN', gguf([...base(), K.f32(`${ARCH}.attention.key_length`, NaN)])],
  ['key negative', gguf([...base(), K.i32(`${ARCH}.attention.key_length`, -128)])],
  ['key as string', gguf([...base(), K.str(`${ARCH}.attention.key_length`, '128')])],
  ['head count 0', gguf(base({ [`${ARCH}.attention.head_count`]: 0 }))],
  ['head count kv 0', gguf(base({ [`${ARCH}.attention.head_count_kv`]: 0 }))],
  ['block count 0', gguf(base({ [`${ARCH}.block_count`]: 0 }))],
  ['block count negative', gguf([...base({ [`${ARCH}.block_count`]: undefined }), K.i32(`${ARCH}.block_count`, -1)])],
  ['block count 2^60', gguf([...base({ [`${ARCH}.block_count`]: undefined }), K.u64(`${ARCH}.block_count`, 2n ** 60n)])],
  ['block count 2^53', gguf([...base({ [`${ARCH}.block_count`]: undefined }), K.u64(`${ARCH}.block_count`, 2n ** 53n)])],
  ['block count fractional', gguf([...base({ [`${ARCH}.block_count`]: undefined }), K.f32(`${ARCH}.block_count`, 32.5)])],
  ['uppercase architecture', gguf(base({ 'general.architecture': 'Llama', Llama: undefined }).concat(['context_length', 'block_count', 'embedding_length', 'attention.head_count', 'attention.head_count_kv'].map((n) => K.u32(`Llama.${n}`, 32768))))],
  ['hyphen architecture', gguf(base({ 'general.architecture': 'llama-3' }).concat(['context_length', 'block_count', 'embedding_length', 'attention.head_count', 'attention.head_count_kv'].map((n) => K.u32(`llama-3.${n}`, 32768))))],
  ['digit architecture', gguf(base({ 'general.architecture': 'gemma3n' }).concat(['context_length', 'block_count', 'embedding_length', 'attention.head_count', 'attention.head_count_kv'].map((n) => K.u32(`gemma3n.${n}`, 32768))))],
  ['huge kv', gguf(base({ [`${ARCH}.block_count`]: 4_000_000_000, [`${ARCH}.attention.head_count_kv`]: 4_000_000_000, [`${ARCH}.attention.key_length`]: 4_000_000_000 }))],
];
const REQUESTS = ['default', 32768, 16384, 20000, 16383, 32769, 0, -5, 40000, 24576];
const FILE_SIZES = [4_000_000_000, 1, 0, 9_007_199_254_000_000, 123_456_789];

const planCases = [];
for (const [name, buffer] of planHeaders) {
  const parsed = PARSED(buffer);
  if (!parsed.header) continue;
  for (const requested of REQUESTS) {
    for (const fileSize of requested === 'default' || requested === 20000 ? FILE_SIZES : [FILE_SIZES[0]]) {
      let outcome;
      try {
        outcome = { plan: requested === 'default' ? ggufMemoryPlan(parsed.header, fileSize) : ggufMemoryPlan(parsed.header, fileSize, requested) };
      } catch (error) {
        outcome = { error: error.message };
      }
      planCases.push({ header: name, fileSize, requested, ...outcome });
    }
  }
}

// ---- Hugging Face flow -----------------------------------------------------------------------
const ORIGIN = 'https://huggingface.co';
const SHA = 'c'.repeat(40);
const LFS = 'd'.repeat(64);
const part = (buffer) => ({ hex: buffer.toString('hex') });
const concat = (parts) => Buffer.concat(parts.map((p) => (p.zeros !== undefined ? Buffer.alloc(p.zeros) : Buffer.from(p.hex, 'hex'))));
const siblingsFor = (size, name = 'm.gguf', over = {}) => ({ rfilename: name, size, lfs: { sha256: LFS, size }, ...over });
const info = (size, over = {}) => ({ sha: SHA, cardData: { license: 'apache-2.0' }, siblings: [siblingsFor(size), { rfilename: 'readme.md' }], ...over });

const scenarios = [];
const add = (s) => scenarios.push({ search: null, info: null, gguf: [part(BASE)], rangeStatus: 206, rangeEndDelta: 0, rangeTotalDelta: 0, httpUrl: false, gpuMemory: 0, then: [], ...s });
const baseSize = BASE.length;

// search
const searchRows = [
  { id: 'o/n', downloads: 5 }, { id: 'bad id', downloads: 1 }, { id: 'a.b-c_d/e.f-g_h', downloads: '12' }, { id: 'x/y', downloads: '0x10' },
  { id: 'x/z', downloads: ' 7 ' }, { id: 'x/t', downloads: true }, { id: 'x/f', downloads: false }, { id: 'x/n', downloads: null }, { id: 'x/s', downloads: 'abc' },
  { id: 'x/d', downloads: 3.5 }, { id: 'x/m', downloads: -1 }, { id: 'x/u' }, { id: 'x/e', downloads: '' }, { id: 123, downloads: 1 }, { id: '', downloads: 1 },
  { id: 'a/b/c', downloads: 1 }, { id: '/b', downloads: 1 }, { id: 'a/', downloads: 1 }, { id: 'ü/n', downloads: 1 }, { id: 'a/..', downloads: 1 }, { id: 'a/.', downloads: 1 },
];
const manyRows = Array.from({ length: 25 }, (_, i) => ({ id: i % 7 === 0 ? `bad id ${i}` : `o/m${i}`, downloads: i }));
const searchOk = (name, query, rows = searchRows) => add({ name, op: 'search', args: { query }, search: { body: rows } });
searchOk('search rows', 'llama');
searchOk('search trims and encodes', "  llama 3.1 ~!'()*&=/ü+  ");
searchOk('search many rows are cut at 20 before filtering', 'many', manyRows);
searchOk('search empty rows', 'none', []);
searchOk('search 200 characters', 'q'.repeat(200));
searchOk('search 100 astral characters', '😀'.repeat(100));
add({ name: 'search 101 astral characters', op: 'search', args: { query: '😀'.repeat(101) }, search: { body: [] } });
add({ name: 'search 200 characters after trimming is refused when 201 before', op: 'search', args: { query: ` ${'q'.repeat(200)}` }, search: { body: [] } });
add({ name: 'search 201 characters', op: 'search', args: { query: 'q'.repeat(201) }, search: { body: [] } });
add({ name: 'search whitespace only', op: 'search', args: { query: ' \t\u00a0\u3000 ' }, search: { body: [] } });
add({ name: 'search empty', op: 'search', args: { query: '' }, search: { body: [] } });
add({ name: 'search number', op: 'search', args: { query: 12 }, search: { body: [] } });
add({ name: 'search null', op: 'search', args: { query: null }, search: { body: [] } });
add({ name: 'search absent', op: 'search', args: {}, search: { body: [] } });
add({ name: 'search not an array', op: 'search', args: { query: 'x' }, search: { body: { models: [] } } });
add({ name: 'search null body', op: 'search', args: { query: 'x' }, search: { body: null } });
add({ name: 'search http 500', op: 'search', args: { query: 'x' }, search: { status: 500, body: [] } });
add({ name: 'search http 429', op: 'search', args: { query: 'x' }, search: { status: 429, body: [] } });

// inspect: listing
const listing = (name, infoBody, args = {}) => add({ name, op: 'inspect', args: { repository: 'o/n', ...args }, info: { body: infoBody } });
listing('listing', info(baseSize));
listing('listing with extra files', info(baseSize, { siblings: [siblingsFor(baseSize), siblingsFor(5, 'dir/Q4.GGUF', { lfs: undefined }), siblingsFor(7, 'b.gguf.bak'), { rfilename: 123 }, { rfilename: 'c.gguf' }, { size: 3 }, siblingsFor(undefined, 'nosize.gguf'), siblingsFor(9, 'x.gguf', { lfs: { sha256: 'bad' } }), siblingsFor(1, 'e.gguf', { lfs: { sha256: '' } }), siblingsFor(2, 'z.gguf', { lfs: { sha256: 0 } }), siblingsFor(3, 'n.gguf', { lfs: { sha256: 5 } }), siblingsFor('4', 's.gguf'), siblingsFor(null, 'nul.gguf', { lfs: null })] }));
listing('listing 200 files', info(baseSize, { siblings: Array.from({ length: 200 }, (_, i) => siblingsFor(100 + i, `f${i}.gguf`)) }));
listing('listing 201 files', info(baseSize, { siblings: Array.from({ length: 201 }, (_, i) => siblingsFor(100 + i, `f${i}.gguf`)) }));
listing('listing no siblings', info(baseSize, { siblings: undefined }));
listing('listing siblings null', info(baseSize, { siblings: null }));
listing('listing filename null', info(baseSize), { filename: null });
listing('listing filename empty', info(baseSize), { filename: '' });
listing('listing filename zero', info(baseSize), { filename: 0 });
listing('listing filename false', info(baseSize), { filename: false });
for (const [label, over] of [['private', { private: true }], ['gated true', { gated: true }], ['gated manual', { gated: 'manual' }], ['gated auto', { gated: 'auto' }], ['gated false', { gated: false }], ['gated empty string', { gated: '' }], ['gated zero', { gated: 0 }], ['gated one', { gated: 1 }], ['gated null', { gated: null }], ['disabled', { disabled: true }], ['private zero', { private: 0 }], ['disabled object', { disabled: {} }], ['disabled array', { disabled: [] }]]) {
  listing(`flag ${label}`, info(baseSize, over));
}
for (const [label, over] of [['39 chars', { sha: 'c'.repeat(39) }], ['41 chars', { sha: 'c'.repeat(41) }], ['uppercase', { sha: 'C'.repeat(40) }], ['missing', { sha: undefined }], ['not hex', { sha: 'g'.repeat(40) }], ['number', { sha: 5 }], ['trailing newline', { sha: `${'c'.repeat(40)}\n` }]]) {
  listing(`revision ${label}`, info(baseSize, over));
}
for (const [label, card] of [['missing', undefined], ['no license', {}], ['empty', { license: '' }], ['blank', { license: '  ' }], ['200 chars', { license: 'l'.repeat(200) }], ['201 chars', { license: 'l'.repeat(201) }], ['number', { license: 5 }], ['array', { license: ['mit'] }], ['padded', { license: '  mit  ' }], ['card null', null]]) {
  listing(`license ${label}`, info(baseSize, { cardData: card }));
}
for (const [label, repository] of [['absent', undefined], ['number', 5], ['no slash', 'abc'], ['three parts', 'a/b/c'], ['dot dot', '../x'], ['name dot dot', 'a/..'], ['dot name', 'a/.'], ['dot owner', './b'], ['space', 'a b/c'], ['unicode', 'ü/n'], ['empty', ''], ['trailing slash', 'a/'], ['leading slash', '/b'], ['allowed punctuation', 'a.b_c-d/e.f_g-h'], ['dots only', '.../...']]) {
  add({ name: `repository ${label}`, op: 'inspect', args: repository === undefined ? {} : { repository }, info: { body: info(baseSize) } });
}
add({ name: 'info http 404', op: 'inspect', args: { repository: 'o/n' }, info: { status: 404, body: {} } });
for (const [label, contextWindow] of [['16384', 16384], ['32768', 32768], ['20000', 20000], ['1000', 1000], ['16383', 16383], ['32769', 32769], ['40000', 40000], ['fractional', 1.5], ['string', '16384'], ['null', null], ['zero', 0], ['negative', -16384], ['float integer', 16384.0], ['exponent', 2e4], ['huge', 1e30]]) {
  add({ name: `context ${label}`, op: 'inspect', args: { repository: 'o/n', filename: 'm.gguf', contextWindow }, info: { body: info(baseSize) } });
}
add({ name: 'context checked before any request', op: 'inspect', args: { repository: 'o/n', contextWindow: 1000 }, info: { body: info(baseSize) } });

// inspect: preview
const preview = (name, args, over = {}) => add({ name, op: 'inspect', args: { repository: 'o/n', filename: 'm.gguf', ...args }, info: { body: info(baseSize) }, ...over });
preview('preview', {});
preview('preview, no GPU holds the default window', {}, { gpuMemory: 0 });
preview('preview, GPU holds the default window', {}, { gpuMemory: 1e13 });
preview('preview, GPU one byte short', {}, { gpuMemory: 2_285_000_000 });
preview('preview with explicit context ignores the GPU', { contextWindow: 20000 }, { gpuMemory: 0 });
preview('preview in a directory', { filename: 'dir/m.gguf' }, { info: { body: info(baseSize, { siblings: [siblingsFor(baseSize, 'dir/m.gguf')] }) } });
preview('preview with uppercase extension', { filename: 'M.GGUF' }, { info: { body: info(baseSize, { siblings: [siblingsFor(baseSize, 'M.GGUF')] }) } });
preview('preview with unicode name', { filename: 'モデル Q4.gguf' }, { info: { body: info(baseSize, { siblings: [siblingsFor(baseSize, 'モデル Q4.gguf')] }) } });
preview('preview of a name with percent and hash', { filename: 'a%b#c?d.gguf' }, { info: { body: info(baseSize, { siblings: [siblingsFor(baseSize, 'a%b#c?d.gguf')] }) } });
for (const [label, filename] of [['shard', 'm-00001-of-00002.gguf'], ['shard uppercase', 'M-00001-OF-00002.GGUF'], ['shard in dir', 'd/m-00003-of-00010.gguf'], ['near shard', 'm-0001-of-00002.gguf'], ['backslash', 'a\\b.gguf'], ['control char', 'a\u0001b.gguf'], ['nul', 'a\u0000.gguf'], ['unit separator', 'a\u001fb.gguf'], ['space is allowed', 'a b.gguf'], ['dot dot', '../m.gguf'], ['dot', './m.gguf'], ['inner dot dot', 'a/../m.gguf'], ['empty segment', 'a//m.gguf'], ['leading slash', '/m.gguf'], ['trailing slash', 'm.gguf/'], ['number', 12], ['object', {}], ['true', true], ['array', ['m.gguf']]]) {
  preview(`filename ${label}`, { filename });
}
preview('filename not listed', { filename: 'other.gguf' });
preview('filename of a non-gguf file', { filename: 'readme.md' });
preview('filename different case', { filename: 'M.gguf' });
for (const [label, sibling] of [
  ['no lfs', siblingsFor(baseSize, 'm.gguf', { lfs: undefined })], ['bad sha', siblingsFor(baseSize, 'm.gguf', { lfs: { sha256: 'd'.repeat(63), size: baseSize } })],
  ['uppercase sha', siblingsFor(baseSize, 'm.gguf', { lfs: { sha256: 'D'.repeat(64), size: baseSize } })], ['lfs size mismatch', siblingsFor(baseSize, 'm.gguf', { lfs: { sha256: LFS, size: baseSize + 1 } })],
  ['lfs size missing', siblingsFor(baseSize, 'm.gguf', { lfs: { sha256: LFS } })], ['size zero', siblingsFor(0, 'm.gguf', { lfs: { sha256: LFS, size: 0 } })], ['size negative', siblingsFor(-5, 'm.gguf', { lfs: { sha256: LFS, size: -5 } })],
  ['size fractional', siblingsFor(10.5, 'm.gguf', { lfs: { sha256: LFS, size: 10.5 } })], ['size string', siblingsFor('100', 'm.gguf', { lfs: { sha256: LFS, size: '100' } })], ['size missing', siblingsFor(undefined, 'm.gguf', { lfs: { sha256: LFS, size: undefined } })],
  ['size above safe integer', siblingsFor(2 ** 60, 'm.gguf', { lfs: { sha256: LFS, size: 2 ** 60 } })],
]) {
  preview(`file ${label}`, {}, { info: { body: info(baseSize, { siblings: [sibling] }) } });
}
preview('duplicate listing, first wins', {}, { info: { body: info(baseSize, { siblings: [siblingsFor(baseSize), siblingsFor(baseSize + 5, 'm.gguf', { lfs: { sha256: 'e'.repeat(64), size: baseSize + 5 } })] }) } });

// inspect: ranges
const tailKvs = base();
const bigArrayPrefix = gguf([K.arr('tokenizer.ggml.token_type', 0, 100_000, Buffer.alloc(0))], { count: tailKvs.length + 1 });
const bigArray = [part(bigArrayPrefix), { zeros: 100_000 }, part(Buffer.concat(tailKvs))];
const bigSize = bigArrayPrefix.length + 100_000 + Buffer.concat(tailKvs).length;
const growth = (name, parts, over = {}) => {
  const size = concat(parts).length;
  add({ name, op: 'inspect', args: { repository: 'o/n', filename: 'm.gguf' }, info: { body: info(size) }, gguf: parts, ...over });
};
growth('range, header larger than the first prefix', bigArray);
growth('range, header larger than the first prefix, explicit context', bigArray, { args: { repository: 'o/n', filename: 'm.gguf', contextWindow: 16384 } });
growth('range, 200 KiB file of zeros', [{ zeros: 200 * 1024 }]);
growth('range, 64 KiB file of zeros', [{ zeros: 64 * 1024 }]);
growth('range, file exactly 64 KiB, header fits', [part(BASE), { zeros: 64 * 1024 - baseSize }]);
growth('range, 64 KiB plus one, header fits', [part(BASE), { zeros: 64 * 1024 + 1 - baseSize }]);
growth('range, truncated whole file', [part(BASE.subarray(0, 50))]);
growth('range, not GGUF', [{ zeros: 1000 }]);
growth('range, unsupported architecture', [part(gguf(base({ [`${ARCH}.attention.head_count_kv`]: undefined })))]);
growth('range, wrong version', [part(gguf(base(), { version: 1 }))]);
growth('range, metadata beyond 16 MiB', [part(gguf([kv('a', 8, u64(16 * 1024 * 1024))], { count: 1 })), { zeros: 20 * 1024 * 1024 }]);
{
  const length = 16 * 1024 * 1024 - 1000;
  const head = Buffer.concat([Buffer.from('GGUF'), u32(3), u64(1), u64(1 + tailKvs.length), str('a'), u32(8), u64(length)]);
  growth('range, metadata fits in 16 MiB', [part(head), { zeros: length }, part(Buffer.concat(tailKvs))]);
}
preview('range, status 200', {}, { rangeStatus: 200 });
preview('range, status 416', {}, { rangeStatus: 416 });
preview('range, content-range end differs', {}, { rangeEndDelta: -1 });
preview('range, content-range end beyond', {}, { rangeEndDelta: 1 });
preview('range, content-range total differs', {}, { rangeTotalDelta: 1 });
preview('range, content-range total smaller', {}, { rangeTotalDelta: -1 });
preview('range, redirected to http', {}, { httpUrl: true });
preview('range, content-range missing', {}, { noContentRange: true });
preview('range, content-range malformed', {}, { contentRange: 'bytes 0-5' });
preview('range, content-range with leading text', {}, { contentRange: 'x bytes 0-5/10' });
preview('range, content-range with a plus sign', {}, { contentRange: `bytes 0-+${baseSize - 1}/${baseSize}` });
preview('range, content-range with leading zeros', {}, { contentRange: `bytes 0-000${baseSize - 1}/${baseSize}` });
preview('range, content-range from 1', {}, { contentRange: `bytes 1-${baseSize - 1}/${baseSize}` });

// register
const registerFlow = (name, then, over = {}) => preview(name, {}, { then, ...over });
registerFlow('register with the license', [{ register: 'preview', accepted: true }]);
registerFlow('register without acceptance', [{ register: 'preview', accepted: false }, { register: 'preview', accepted: true }]);
registerFlow('register acceptance must be exactly true', [{ register: 'preview', accepted: 'yes' }, { register: 'preview', accepted: 1 }, { register: 'preview', accepted: null }]);
registerFlow('register twice', [{ register: 'preview', accepted: true }, { register: 'preview', accepted: true }]);
registerFlow('register unknown preview', [{ register: 'nope', accepted: true }, { register: 'nope', accepted: false }]);
registerFlow('register with explicit context', [{ register: 'preview', accepted: true }], { args: { repository: 'o/n', filename: 'm.gguf', contextWindow: 20000 } });

// ---- run scenarios in Node -------------------------------------------------------------------
const NOW = 1_700_000_000_000;
const normalize = (value) => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'previewId' ? 'PREVIEW' : k === 'expiresAt' ? 'EXPIRES' : normalize(v)]));
  }
  return value;
};
const failure = (error) => ({ error: { kind: error instanceof TypeError ? 'invalid' : 'failed', message: error.message } });

async function run(s) {
  const data = concat(s.gguf);
  const calls = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'hf-golden-'));
  const respondJson = (spec) => new Response(JSON.stringify(spec.body), { status: spec.status ?? 200 });
  const fetchFn = async (url, options = {}) => {
    const range = options.headers?.Range;
    calls.push({ url: String(url), end: range === undefined ? null : Number(/^bytes=0-(\d+)$/.exec(range)[1]) });
    if (String(url).startsWith(`${ORIGIN}/api/models?`)) return respondJson(s.search);
    if (String(url).startsWith(`${ORIGIN}/api/models/`)) return respondJson(s.info);
    const end = Math.min(Number(/^bytes=0-(\d+)$/.exec(range)[1]), data.length - 1);
    const headers = s.noContentRange ? {} : { 'content-range': s.contentRange ?? `bytes 0-${end + s.rangeEndDelta}/${data.length + s.rangeTotalDelta}` };
    const response = new Response(s.rangeStatus === 206 || s.rangeStatus === 200 ? data.subarray(0, end + 1) : null, { status: s.rangeStatus, headers });
    if (s.httpUrl) Object.defineProperty(response, 'url', { value: 'http://cdn.example/file' });
    return response;
  };
  const catalog = createHuggingFaceCatalog({ fetchFn, dataDir, now: () => NOW, hardwareFn: async () => ({ gpus: [{ memoryBytes: s.gpuMemory }] }) });
  let out;
  let previewId = null;
  try {
    out = { result: await catalog[s.op](s.op === 'search' ? s.args.query : s.args) };
    previewId = out.result.previewId ?? null;
  } catch (error) {
    out = failure(error);
  }
  const registers = [];
  for (const step of s.then) {
    try {
      registers.push({ result: catalog.register(step.register === 'preview' ? previewId : step.register, step.accepted) });
    } catch (error) {
      registers.push(failure(error));
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
  return { ...s, expected: { ...normalize(out), calls, registers: normalize(registers) } };
}

const hfCases = [];
for (const s of scenarios) hfCases.push(await run(s));

writeJson(join(FIXTURES_ROOT, 'services', 'gguf-hf-twin.json'), {
  domain: 'gguf-hf-twin',
  recorder: 'benchmarks/rust-core/recorders/record-gguf-hf.mjs',
  parse: parseCases.map(({ name, buffer }) => {
    const { header: _h, ...outcome } = PARSED(buffer);
    return { name, hex: buffer.toString('hex'), ...outcome };
  }),
  planHeaders: Object.fromEntries(planHeaders.map(([name, buffer]) => [name, buffer.toString('hex')])),
  plans: planCases,
  huggingFace: hfCases,
});
console.log(`recorded ${parseCases.length} parses, ${planCases.length} plans, ${hfCases.length} Hugging Face scenarios`);
