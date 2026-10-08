import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { loadUnigramTokenizer, UnsupportedTokenizerError } from './embedding-tokenizer.mjs';

// The reference: the tokenizer library transformers.js runs (and every stored
// vector was made with), resolved the way the runtime resolves transformers.
const require = createRequire(import.meta.url);
// require.resolve picks the CommonJS build, whose exports arrive on `default`.
const tokenizersModule = await import(
  pathToFileURL(createRequire(require.resolve('@huggingface/transformers')).resolve('@huggingface/tokenizers')).href
);
const { Tokenizer } = tokenizersModule.default ?? tokenizersModule;

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// An XLM-R shaped tokenizer.json: Precompiled + Replace normalizer, Metaspace,
// Unigram with a duplicated piece, <s> … </s> template, and an lstrip <mask>.
function syntheticTokenizer(random) {
  const letters = [...'abcdeklmnorst가나다라마바사아자한국어'];
  const vocab = [
    ['<s>', 0],
    ['<pad>', 0],
    ['</s>', 0],
    ['<unk>', 0],
  ];
  for (const c of letters) vocab.push([c, -8 - random() * 4], [`\u2581${c}`, -7 - random() * 4]);
  const pick = () => letters[Math.floor(random() * letters.length)];
  for (let i = 0; i < 400; i++) {
    const len = 2 + Math.floor(random() * 4);
    const piece = (random() < 0.5 ? '\u2581' : '') + Array.from({ length: len }, pick).join('');
    vocab.push([piece, -2 - random() * 9]);
  }
  vocab.push(['\u2581ab', -1.5], ['\u2581ab', -3.25]); // duplicate: the last id wins
  vocab.push(['<mask>', 0]);
  const special = (content, id, extra = {}) => ({
    id,
    content,
    single_word: false,
    lstrip: false,
    rstrip: false,
    normalized: false,
    special: true,
    ...extra,
  });
  return {
    version: '1.0',
    truncation: null,
    padding: null,
    added_tokens: [
      special('<s>', 0),
      special('<pad>', 1),
      special('</s>', 2),
      special('<unk>', 3),
      special('<mask>', vocab.length - 1, { lstrip: true }),
    ],
    normalizer: {
      type: 'Sequence',
      normalizers: [
        { type: 'Precompiled', precompiled_charsmap: '' },
        { type: 'Replace', pattern: { Regex: ' {2,}' }, content: ' ' },
      ],
    },
    pre_tokenizer: { type: 'Metaspace', replacement: '\u2581', add_prefix_space: true, prepend_scheme: 'always' },
    post_processor: {
      type: 'TemplateProcessing',
      single: [{ SpecialToken: { id: '<s>', type_id: 0 } }, { Sequence: { id: 'A', type_id: 0 } }, { SpecialToken: { id: '</s>', type_id: 0 } }],
      pair: [],
      special_tokens: {
        '<s>': { id: '<s>', ids: [0], tokens: ['<s>'] },
        '</s>': { id: '</s>', ids: [2], tokens: ['</s>'] },
      },
    },
    decoder: { type: 'Metaspace', replacement: '\u2581', add_prefix_space: true, prepend_scheme: 'always' },
    model: { type: 'Unigram', unk_id: 3, vocab },
  };
}

function withTokenizerFile(json, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-embed-tok-'));
  try {
    const path = join(dir, 'tokenizer.json');
    writeFileSync(path, JSON.stringify(json));
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('compact Unigram encoder reproduces the reference library ids exactly', () => {
  const random = rng(7);
  const json = syntheticTokenizer(random);
  const reference = new Tokenizer(json, { model_max_length: 512 });
  withTokenizerFile(json, (path) => {
    const compact = loadUnigramTokenizer(path, { maxLength: Number.MAX_SAFE_INTEGER });
    const alphabet = [...'abcdeklmnorst가나다라마바사아자한국어xyz日本😀～ｆＡ', ' ', ' ', '  ', '\t', '\n', '\u0001', '\u00a0', '<mask>', '<s>'];
    const fixed = ['', ' ', 'ab', ' ab  ab', 'xyz xyz', 'ab<mask> cd', '한국어   테스트', '～ａｂ～', '😀😀 ab'];
    const samples = [...fixed];
    for (let i = 0; i < 3000; i++) {
      const len = Math.floor(random() * 24);
      samples.push(Array.from({ length: len }, () => alphabet[Math.floor(random() * alphabet.length)]).join(''));
    }
    for (const text of samples) assert.deepEqual(compact.encode(text), reference.encode(text).ids, JSON.stringify(text));
  });
});

test('ids are cut to the model window like transformers truncation', () => {
  withTokenizerFile(syntheticTokenizer(rng(3)), (path) => {
    const ids = loadUnigramTokenizer(path, { maxLength: 6 }).encode('ab cd ab cd ab cd ab cd');
    assert.equal(ids.length, 6);
    assert.equal(ids[0], 0);
  });
});

test('a non-Unigram layout is reported as unsupported', () => {
  const json = syntheticTokenizer(rng(1));
  json.model = { type: 'BPE', vocab: {}, merges: [] };
  withTokenizerFile(json, (path) => assert.throws(() => loadUnigramTokenizer(path), UnsupportedTokenizerError));
});
