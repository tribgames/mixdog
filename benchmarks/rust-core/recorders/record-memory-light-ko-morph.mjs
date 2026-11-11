#!/usr/bin/env node
// Node's light Korean morphology (src/runtime/memory/lib/light-ko-morph.test.mjs, 3 cases) from the real
// light-ko-morph.mjs and memory-text-utils.mjs: particle stripping, token normalisation, stems, the recall query
// tokens and the FTS prefix query, for the test file's phrases and a spread of Korean/Latin/mixed tokens.
//
//   node benchmarks/rust-core/recorders/record-memory-light-ko-morph.mjs --tree <dir>
import { begin, capture, finish, importFrom } from './lib/mc-record.mjs';

const ctx = begin();
const { lightKoMorphStems, normalizeLightKoreanToken, stripLightKoreanParticle } = await importFrom(ctx.tree, 'src/runtime/memory/lib/light-ko-morph.mjs');
const { buildFtsPrefixQuery, tokenizeRecallQuery } = await importFrom(ctx.tree, 'src/runtime/memory/lib/memory-text-utils.mjs');

const TOKENS = [
  '메모리를', 'code_graph에', '분리했던', '가져왔던', '숨겼던', '메모리', '최적화했던', '계획', '검색을', '원인', '비교', '코드를', '작업', '임베딩', '모델을', '해제했던', '결과',
  '하는', '적게', '웹', '는', '을', '에서', '으로', '에게', '합니다', '했다', '됩니다', '있는', '없던', '만들었던', '읽었던', '쓰던', '먹었던', '와', '과', '의', '도', '만',
  'Claude', 'codex', 'Hermes', 'PowerShell', 'abc123', '한글abc', 'ㅎ', '', ' ', '메모리를,', '메모리를.', '가', '이', '은',
];
const tokens = [];
for (const token of TOKENS) {
  tokens.push({ token, strip: await capture(() => stripLightKoreanParticle(token)), normalize: await capture(() => normalizeLightKoreanToken(token)) });
}
const PHRASES = [
  '메모리를 최적화했던 계획',
  '웹 검색을 적게 하는 원인 Claude Code Codex Hermes 비교',
  'PowerShell 코드를 분리했던 작업',
  '임베딩 모델을 해제했던 결과',
  '', '   ', 'hello world', '한글만 있는 질의입니다', 'code_graph에 대한 메모리를 가져왔던 이유', 'a b c', 'the quick brown fox 그리고 메모리',
];
const phrases = [];
for (const text of PHRASES) {
  phrases.push({ text, stems: await capture(() => lightKoMorphStems(text)), tokens: await capture(() => tokenizeRecallQuery(text)), fts: await capture(() => buildFtsPrefixQuery(text)) });
}

finish(ctx, {
  url: import.meta.url,
  set: 'memory-light-ko-morph',
  golden: {
    domain: 'memory-light-ko-morph',
    source: 'src/runtime/memory/lib/light-ko-morph.test.mjs',
    cases: [
      { name: 'light Korean normalization strips particles and high-confidence predicate endings', tokens: tokens.slice(0, 6), stems: phrases[0] },
      { name: 'a query with several product names keeps its Korean content words', phrase: phrases[1] },
      { name: 'production recall uses light stems in prefix queries by default', phrases: [phrases[2], phrases[3]] },
      { name: 'further tokens and phrases (beyond the test file)', tokens, phrases },
    ],
  },
  extra: {
    entry: { runs: 'stripLightKoreanParticle, normalizeLightKoreanToken, lightKoMorphStems (light-ko-morph.mjs) and tokenizeRecallQuery, buildFtsPrefixQuery (memory-text-utils.mjs)', notRun: 'the SQL that consumes the prefix query' },
    replay: "mixdog-services memory/ko_morph.rs: pub fn strip_light_korean_particle (:61), pub fn normalize_light_korean_token (:90); memory/query_terms.rs: pub fn build_fts_prefix_query (:164), called by recall/hybrid.rs:297 for queries of at least 3 UTF-16 units. A replay compares each recorded token and query result exactly",
    exclusions: 'the last case holds extra probes the test file does not run',
    normalised: { none: 'no run-dependent value' },
  },
});
process.exit(0);
