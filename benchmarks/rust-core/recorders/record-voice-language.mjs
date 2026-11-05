#!/usr/bin/env node
// Golden twin of Whisper language selection (`channels/lib/whisper-language.mjs`): the answer
// of Node's real `normalizeWhisperLanguage` for each probe value. Rust
// `voice::language::normalize_whisper_language` must give the same answers.
//
//   node benchmarks/rust-core/recorders/record-voice-language.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { normalizeWhisperLanguage } = await importFrom(tree, 'src/runtime/channels/lib/whisper-language.mjs');

const PROBES = [
  '', ' ', 'auto', 'AUTO', ' Auto ', 'c', 'C', 'POSIX', 'posix', 'C.UTF-8', 'c.utf-8', 'POSIX.UTF-8',
  'cs', 'cs_CZ', 'ca', 'ko', 'ko-KR', ' ko_KR.UTF-8 ', 'KO', 'ja_JP', 'en', 'en_US.UTF-8', 'EN-gb',
  'zh-CN', 'zh_TW', 'de_DE', 'fr', 'es-419', 'it', 'pt-BR', 'ru_RU', 'sv-SE', 'sv', 'nl', 'enx',
  'ptolemaic', '\u00a0ko\u00a0', '\u3000ja\u3000', '\ufeffen', 'İstanbul', 'ÇA', 'ß', 'x', 'C-UTF', 'c_US',
];
const cases = [...PROBES.map((value) => ({ value })), { value: null }, { value: undefined }].map((c) => ({
  input: c.value === undefined ? { absent: true } : c.value,
  output: normalizeWhisperLanguage(c.value),
}));

writeJson(join(FIXTURES_ROOT, 'services', 'voice-language-twin.json'), {
  domain: 'voice-language-twin',
  recorder: 'benchmarks/rust-core/recorders/record-voice-language.mjs',
  cases,
});
console.log(`recorded ${cases.length} cases`);
