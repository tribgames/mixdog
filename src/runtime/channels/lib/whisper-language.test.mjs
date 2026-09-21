import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeWhisperLanguage } from './whisper-language.mjs';

test('whisper language normalization preserves supported prefixes', () => {
  const cases = [
    [' ko-KR ', 'ko'],
    ['ja_JP.UTF-8', 'ja'],
    ['EN-us', 'en'],
    ['zh-Hant', 'zh'],
    ['de-DE', 'de'],
    ['fr-FR', 'fr'],
    ['es-ES', 'es'],
    ['it-IT', 'it'],
    ['pt-BR', 'pt'],
    ['ru-RU', 'ru'],
    ['korean', 'ko'],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeWhisperLanguage(input), expected);
});

test('automatic and POSIX pseudo-locales carry no whisper language signal', () => {
  for (const input of [undefined, null, '', '  ', 'AUTO', 'C', 'C.UTF-8', 'POSIX', 'posix.UTF-8']) {
    assert.equal(normalizeWhisperLanguage(input), null);
  }
});

test('unknown whisper languages retain normalized input', () => {
  assert.equal(normalizeWhisperLanguage(' NL-nl '), 'nl-nl');
  assert.equal(normalizeWhisperLanguage('posix-custom'), 'posix-custom');
  assert.equal(normalizeWhisperLanguage(42), '42');
});
