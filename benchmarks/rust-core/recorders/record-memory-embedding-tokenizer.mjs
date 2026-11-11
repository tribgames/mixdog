#!/usr/bin/env node
// Node's compact Unigram tokenizer (src/runtime/memory/lib/embedding-tokenizer.test.mjs, 3 cases) from the real
// `loadUnigramTokenizer`. The tokenizer.json is the test file's own synthetic XLM-R-shaped one (seeded generator),
// written next to the golden as `tokenizer-main.json` / `tokenizer-bpe.json`; the golden holds, for each probe text,
// the ids the compact encoder gives. The recorder also encodes every text with the reference library
// (@huggingface/tokenizers, the one the test compares against) and refuses to record when they differ.
//
//   node benchmarks/rust-core/recorders/record-memory-embedding-tokenizer.mjs --tree <dir>
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { begin, capture, finish, importFrom } from './lib/mc-record.mjs';

const ctx = begin();
const { loadUnigramTokenizer, UnsupportedTokenizerError } = await importFrom(ctx.tree, 'src/runtime/memory/lib/embedding-tokenizer.mjs');
const treeRequire = createRequire(join(ctx.tree, 'package.json'));
const tokenizersModule = await import(pathToFileURL(createRequire(treeRequire.resolve('@huggingface/transformers')).resolve('@huggingface/tokenizers')).href);
const { Tokenizer } = tokenizersModule.default ?? tokenizersModule;

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The test file's generator, unchanged.
function syntheticTokenizer(random) {
  const letters = [...'abcdeklmnorst가나다라마바사아자한국어'];
  const vocab = [['<s>', 0], ['<pad>', 0], ['</s>', 0], ['<unk>', 0]];
  for (const c of letters) vocab.push([c, -8 - random() * 4], [`\u2581${c}`, -7 - random() * 4]);
  const pick = () => letters[Math.floor(random() * letters.length)];
  for (let i = 0; i < 400; i++) {
    const len = 2 + Math.floor(random() * 4);
    const piece = (random() < 0.5 ? '\u2581' : '') + Array.from({ length: len }, pick).join('');
    vocab.push([piece, -2 - random() * 9]);
  }
  vocab.push(['\u2581ab', -1.5], ['\u2581ab', -3.25]);
  vocab.push(['<mask>', 0]);
  const special = (content, id, extra = {}) => ({ id, content, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true, ...extra });
  return {
    version: '1.0',
    truncation: null,
    padding: null,
    added_tokens: [special('<s>', 0), special('<pad>', 1), special('</s>', 2), special('<unk>', 3), special('<mask>', vocab.length - 1, { lstrip: true })],
    normalizer: { type: 'Sequence', normalizers: [{ type: 'Precompiled', precompiled_charsmap: '' }, { type: 'Replace', pattern: { Regex: ' {2,}' }, content: ' ' }] },
    pre_tokenizer: { type: 'Metaspace', replacement: '\u2581', add_prefix_space: true, prepend_scheme: 'always' },
    post_processor: {
      type: 'TemplateProcessing',
      single: [{ SpecialToken: { id: '<s>', type_id: 0 } }, { Sequence: { id: 'A', type_id: 0 } }, { SpecialToken: { id: '</s>', type_id: 0 } }],
      pair: [],
      special_tokens: { '<s>': { id: '<s>', ids: [0], tokens: ['<s>'] }, '</s>': { id: '</s>', ids: [2], tokens: ['</s>'] } },
    },
    decoder: { type: 'Metaspace', replacement: '\u2581', add_prefix_space: true, prepend_scheme: 'always' },
    model: { type: 'Unigram', unk_id: 3, vocab },
  };
}

const dir = mkdtempSync(join(tmpdir(), 'mixdog-embed-tok-'));
const fileOf = (name, json) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(json)); return path; };

const random = rng(7);
const mainJson = syntheticTokenizer(random);
const reference = new Tokenizer(mainJson, { model_max_length: 512 });
const compact = loadUnigramTokenizer(fileOf('main.json', mainJson), { maxLength: Number.MAX_SAFE_INTEGER });
const alphabet = [...'abcdeklmnorst가나다라마바사아자한국어xyz日本😀～ｆＡ', ' ', ' ', '  ', '\t', '\n', '\u0001', '\u00a0', '<mask>', '<s>'];
const samples = ['', ' ', 'ab', ' ab  ab', 'xyz xyz', 'ab<mask> cd', '한국어   테스트', '～ａｂ～', '😀😀 ab'];
for (let i = 0; i < 3000; i++) {
  const len = Math.floor(random() * 24);
  samples.push(Array.from({ length: len }, () => alphabet[Math.floor(random() * alphabet.length)]).join(''));
}
const encoded = samples.map((text) => {
  const ids = compact.encode(text);
  if (!isDeepStrictEqual(ids, reference.encode(text).ids)) throw new Error(`compact encoder differs from the reference library for ${JSON.stringify(text)}: refusing to record`);
  return [text, ids];
});

const cut = syntheticTokenizer(rng(3));
const windowProbes = [];
for (const [maxLength, text] of [[6, 'ab cd ab cd ab cd ab cd'], [2, 'ab cd'], [1, 'ab'], [3, 'ab'], [512, 'ab cd'], [0, 'ab cd']]) {
  windowProbes.push({ maxLength, text, ...(await capture(() => loadUnigramTokenizer(fileOf('cut.json', cut), { maxLength }).encode(text))) });
}
const defaultWindow = await capture(() => loadUnigramTokenizer(fileOf('cut.json', cut)).encode('ab cd'));

const unsupported = [];
const badFiles = {};
for (const [label, model] of [['BPE', { type: 'BPE', vocab: {}, merges: [] }], ['WordPiece', { type: 'WordPiece', vocab: {} }]]) {
  const json = syntheticTokenizer(rng(1));
  json.model = model;
  badFiles[`tokenizer-${label.toLowerCase()}.json`] = JSON.stringify(json);
  const out = await capture(() => loadUnigramTokenizer(fileOf('bad.json', json)));
  let thrown = null;
  try { loadUnigramTokenizer(fileOf('bad.json', json)); } catch (error) { thrown = { isUnsupportedTokenizerError: error instanceof UnsupportedTokenizerError, name: error.name, message: error.message }; }
  unsupported.push({ model: label, tokenizerFile: `tokenizer-${label.toLowerCase()}.json`, ...out, thrown });
}
rmSync(dir, { recursive: true, force: true });

finish(ctx, {
  url: import.meta.url,
  set: 'memory-embedding-tokenizer',
  files: { 'tokenizer-main.json': JSON.stringify(mainJson), 'tokenizer-cut.json': JSON.stringify(cut), ...badFiles },
  golden: {
    domain: 'memory-embedding-tokenizer',
    source: 'src/runtime/memory/lib/embedding-tokenizer.test.mjs',
    cases: [
      { name: 'compact Unigram encoder reproduces the reference library ids exactly', tokenizerFile: 'tokenizer-main.json', maxLength: 'Number.MAX_SAFE_INTEGER', encoded },
      { name: 'ids are cut to the model window like transformers truncation', tokenizerFile: 'tokenizer-cut.json', windowProbes, defaultWindow },
      { name: 'a non-Unigram layout is reported as unsupported', baseTokenizerSeed: 1, unsupported },
    ],
  },
  extra: {
    entry: { runs: 'loadUnigramTokenizer and UnsupportedTokenizerError (embedding-tokenizer.mjs) over the synthetic tokenizer.json files stored beside the golden; the reference library encodes every sample and the recorder stops on any difference', notRun: 'the model graph and pooling' },
    replay: 'mixdog-services memory: mem/embed/tokenizer.rs load + encode over tokenizer-main.json / tokenizer-cut.json; compares ids for every sample, the window cut, and the unsupported-model refusal (Node message in `unsupported`).',
    exclusions: 'none',
    normalised: { 'temp paths': 'files are temp; the golden names the stored tokenizer files' },
  },
});
process.exit(0);
