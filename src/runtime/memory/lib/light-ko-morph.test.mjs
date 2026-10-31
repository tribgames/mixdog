import test from 'node:test';
import assert from 'node:assert/strict';

import { lightKoMorphStems, normalizeLightKoreanToken, stripLightKoreanParticle } from './light-ko-morph.mjs';
import { buildFtsPrefixQuery, tokenizeRecallQuery } from './memory-text-utils.mjs';

test('light Korean normalization strips particles and high-confidence predicate endings', () => {
  assert.equal(stripLightKoreanParticle('메모리를'), '메모리');
  assert.equal(stripLightKoreanParticle('code_graph에'), 'code_graph');
  assert.equal(normalizeLightKoreanToken('분리했던'), '분리');
  assert.equal(normalizeLightKoreanToken('가져왔던'), '가져오');
  assert.equal(normalizeLightKoreanToken('숨겼던'), '숨기');
  assert.deepEqual(lightKoMorphStems('메모리를 최적화했던 계획'), ['메모리', '최적화', '계획']);
});

test('a query with several product names keeps its Korean content words', () => {
  const tokens = tokenizeRecallQuery('웹 검색을 적게 하는 원인 Claude Code Codex Hermes 비교');
  assert.deepEqual(tokens.slice(0, 4), ['claude', 'code', 'codex', 'herm']);
  for (const word of ['검색', '원인', '비교']) assert.ok(tokens.includes(word), word);
  assert.match(buildFtsPrefixQuery('웹 검색을 적게 하는 원인 Claude Code Codex Hermes 비교').query, /검색:\*/);
});

test('production recall uses light stems in prefix queries by default', () => {
  assert.deepEqual(tokenizeRecallQuery('PowerShell 코드를 분리했던 작업'), ['powershell', '코드', '분리', '작업']);
  assert.deepEqual(buildFtsPrefixQuery('임베딩 모델을 해제했던 결과'), {
    query: '임베딩:* | 모델:* | 해제:* | 결과:*',
    prefix: true,
  });
});
