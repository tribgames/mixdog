import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateCase,
  parseRecallOutput,
  scorePageAfter,
  scoreRecencyOrdered,
  scoreTopNContains,
  scoreWithinPeriod,
} from './lib/recall-bench-eval.mjs';
import { inferRecallPeriod, renderEntryLines } from '../src/runtime/memory/lib/recall-format.mjs';
import { decodeRecallPageCursor, encodeRecallPageCursor } from '../src/runtime/memory/lib/recall-page-cursor.mjs';
import { mergeRecallConceptTokens, tokenizeRecallQuery } from '../src/runtime/memory/lib/memory-text-utils.mjs';
import { countQueryTokens, queryTokensLower } from '../src/runtime/memory/lib/recall-scoring.mjs';
import {
  annotateRecallRootContext,
  boundRecallRowsToTemporal,
  createQueryHandlers,
  hasLatestRecallIntent,
  latestRecallSearchTerms,
  latestRecallTopicTerms,
  mergeHistoricalRecallRows,
  preserveLatestConceptRows,
  prioritizeHistoricalRootEvidence,
  rankLatestRecallRows,
} from '../src/runtime/memory/lib/query-handlers.mjs';
import { mergeRecallEventRows } from '../src/runtime/memory/lib/recall-event-context.mjs';
import { preferLatestConceptRows } from '../src/runtime/memory/lib/memory-recall-store.mjs';

const sample = [
  '## session alpha',
  '[2026-08-13 20:43 Asia/Seoul (UTC+09:00; UTC 2026-08-13 11:43Z)] a: first result',
  '- continuation containing target phrase',
  '## markdown inside the result',
  '[2026-08-13 20:42 Asia/Seoul (UTC+09:00; UTC 2026-08-13 11:42Z)] u: second result',
  '## session beta',
  '[2026-08-13 19:00 Asia/Seoul (UTC+09:00; UTC 2026-08-13 10:00Z)] a: third result',
].join('\n');

test('parser counts logical timestamped items and preserves multiline bodies', () => {
  const parsed = parseRecallOutput(sample);
  assert.equal(parsed.items.length, 3);
  assert.equal(parsed.headers.length, 2);
  assert.match(parsed.items[0].text, /continuation containing target phrase/);
  assert.match(parsed.items[0].text, /markdown inside the result/);
});

test('quality rank and recency operate on items, not physical lines', () => {
  const { items } = parseRecallOutput(sample);
  const quality = scoreTopNContains(items, ['target phrase', 'third result'], 3);
  assert.deepEqual(quality.perSubstring.map((row) => row.rank), [1, 3]);
  assert.equal(quality.hitAtN, 1);
  assert.equal(scoreRecencyOrdered(items).ordered, true);
});

test('equal-millisecond turns sort newest source turn first after chunking', () => {
  const ts = Date.parse('2026-08-13T11:43:30.123Z');
  const rendered = renderEntryLines([{
    id: 100,
    ts,
    session_id: 'same-session',
    is_root: 1,
    members: [
      { id: 1, ts, session_id: 'same-session', source_turn: 1, role: 'user', content: 'older' },
      { id: 2, ts, session_id: 'same-session', source_turn: 2, role: 'assistant', content: 'newer' },
    ],
  }], { recencyOrder: true });
  assert.deepEqual(rendered.split('\n').map((line) => line.match(/#(\d+)$/)?.[1]), ['2', '1']);
  assert.match(rendered, /^\[2026-08-13 \d{2}:\d{2}:30\.123 /);
});

test('last-page cursor is opaque, stable, and scope-bound', () => {
  const context = { projectScope: 'mixdog', query: '', includeMembers: true };
  const cursor = encodeRecallPageCursor({ lastTs: 1234, sessionId: 'session-b', context });
  assert.match(cursor, /^r1\./);
  assert.deepEqual(decodeRecallPageCursor(cursor, context), { lastTs: 1234, sessionId: 'session-b' });
  assert.throws(() => decodeRecallPageCursor(cursor, { ...context, projectScope: 'common' }), /does not match/);
});

test('time provenance distinguishes collected and unknown legacy rows', () => {
  const ts = Date.parse('2026-08-13T11:43:30.123Z');
  const text = renderEntryLines([
    { id: 1, ts, role: 'user', content: 'collected', is_root: 0, time_source: 'collected' },
    { id: 2, ts, role: 'user', content: 'legacy', is_root: 0, source_ref: 'transcript:old#1' },
    { id: 3, ts, role: 'user', content: 'recorded', is_root: 0, time_source: 'recorded' },
  ]);
  assert.match(text, /collected.*\[time=collected\]/);
  assert.match(text, /legacy.*\[time=legacy; event-time=unverified\]/);
  assert.doesNotMatch(text, /recorded.*\[time=/);
});

test('page ordering rejects duplicate sessions and newer next pages', () => {
  const first = parseRecallOutput(sample);
  const orderedNext = parseRecallOutput([
    '## session gamma',
    '[2026-08-13 18:00 Asia/Seoul (UTC+09:00; UTC 2026-08-13 09:00Z)] a: next page',
  ].join('\n'));
  assert.equal(scorePageAfter(first, orderedNext).ok, true);

  const duplicate = parseRecallOutput([
    '## session beta',
    '[2026-08-13 18:00 Asia/Seoul (UTC+09:00; UTC 2026-08-13 09:00Z)] a: duplicate',
  ].join('\n'));
  assert.equal(scorePageAfter(first, duplicate).ok, false);

  const inverted = parseRecallOutput([
    '## session gamma',
    '[2026-08-13 20:00 Asia/Seoul (UTC+09:00; UTC 2026-08-13 11:00Z)] a: newer page',
  ].join('\n'));
  assert.equal(scorePageAfter(first, inverted).inverted, true);
});

test('zero-result results cases fail unless explicitly allowed', () => {
  const strict = evaluateCase({ expect: { kind: 'results' } }, { count: 0, ms: 1, isError: false });
  assert.equal(strict.status, 'WARN');
  const optional = evaluateCase({ expect: { kind: 'results', allowEmpty: true } }, { count: 0, ms: 1, isError: false });
  assert.equal(optional.status, 'PASS');
});

test('period checks report out-of-range items', () => {
  const { items } = parseRecallOutput(sample);
  const result = scoreWithinPeriod(items, {
    startMs: Date.parse('2026-08-13T20:00:00'),
    endMs: Date.parse('2026-08-13T21:00:00'),
  });
  assert.equal(result.checked, 3);
  assert.equal(result.offenders.length, 1);
});

test('recall concept tokens come from analyzer output while identifiers survive', () => {
  assert.deepEqual(
    mergeRecallConceptTokens('work about existing DB migration cause', ['existing', 'migration']),
    ['db', 'exist', 'migration'],
  );
  assert.deepEqual(
    mergeRecallConceptTokens('이 작업에서 기존 DB 마이그레이션 문제 원인이 뭐였지', ['기존', '마이그레이션']),
    ['db', '기존', '마이그레이션'],
  );
  assert.deepEqual(
    mergeRecallConceptTokens('harbor operation -n 8 details', ['harbor']),
    ['-n', '8', 'harbor'],
  );
  assert.deepEqual(
    mergeRecallConceptTokens('remote 싱글톤 좌석', ['remote', '싱글', '톤', '좌석']),
    ['싱글톤', 'remote', '싱글', '좌석'],
  );
  assert.deepEqual(
    mergeRecallConceptTokens('code_graph에 symbols를', []),
    ['code_graph', 'symbol'],
  );
  assert.deepEqual(
    mergeRecallConceptTokens('방식은 사용자가 타입으로 고정값이', []),
    ['방식', '사용자', '타입', '고정값'],
  );
  assert.ok(tokenizeRecallQuery('cycle1 ECONNRESET failure cause').includes('cycle1'));
  assert.ok(queryTokensLower('embedding worker isolation failure').includes('embedd'));
  assert.ok(countQueryTokens('harbor operation -n 8 details') >= 3);
});

test('natural time expressions map to structural recall periods', () => {
  assert.equal(inferRecallPeriod('어제 harbor 벤치 worker 몇 개였지'), 'yesterday');
  assert.equal(inferRecallPeriod('what changed in the last 3 hours'), '3h');
  assert.equal(inferRecallPeriod('이번 주 작업 결정'), 'this_week');
  assert.equal(inferRecallPeriod('방금 수정한 결과'), '3h');
  assert.equal(hasLatestRecallIntent('방금 한 중요한 작업'), true);
  assert.equal(hasLatestRecallIntent('Mixdog Codex 비용 비교 최신 상태'), true);
  assert.equal(hasLatestRecallIntent('current fast8 cost'), true);
  assert.equal(hasLatestRecallIntent('8월 11일 당시 비용 비교'), false);
});

test('latest recall separates time/status context and chooses the newest equally relevant event', () => {
  assert.deepEqual(
    latestRecallTopicTerms('current npm publish latest version status now'),
    ['npm', 'publish', 'version'],
  );
  assert.deepEqual(latestRecallTopicTerms('2026-07-04 npm latest 태그 결과'), ['npm', '태그']);
  assert.deepEqual(latestRecallTopicTerms('Maintainer 다이얼로그 현재 최종 결정'), ['maintainer', '다이얼로그']);
  assert.deepEqual(latestRecallSearchTerms('Windows mixdog-spawn 현재 성능 결과'), ['mixdog-spawn']);
  assert.deepEqual(
    latestRecallSearchTerms('code_graph에 symbols를 주면 지금 실제 결과도 해당 심볼만 나오나?'),
    ['code_graph', 'symbol'],
  );
  assert.deepEqual(
    latestRecallSearchTerms('현재 워크플로 라우팅 슬롯에 explorer도 포함돼 있어?'),
    ['explorer'],
  );
  assert.deepEqual(
    latestRecallSearchTerms('OpenAI 요청을 만들 때 reasoning summary도 현재 같이 보내고 있어?'),
    ['openai', 'reason', 'summary'],
  );
  const ranked = rankLatestRecallRows([
    { id: 1, ts: 100, retrievalScore: 0.9, content: 'session switch flicker diagnosis' },
    { id: 2, ts: 300, retrievalScore: 0.7, content: 'session switch final improvement' },
    { id: 3, ts: 400, retrievalScore: 1.0, content: 'current session switch flicker status' },
  ], 'current session switch flicker status');
  assert.deepEqual(ranked.map((row) => row.id), [2, 1, 3]);
  const strictEntities = rankLatestRecallRows([
    { id: 1, ts: 300, content: 'SSE current status' },
    { id: 2, ts: 200, content: 'SSE callId reconnect final state' },
  ], 'SSE callId current status');
  assert.deepEqual(strictEntities.map((row) => row.id), [2, 1]);
});

test('latest concept expansion replaces an older hit with its newest stored conclusion', () => {
  const rows = [
    { id: 10, concept_ids: [7, 8], ts: 100, summary: 'old value' },
    { id: 20, concept_id: 20, summary: 'independent fact' },
  ];
  const latest = [
    { id: 12, matched_concept_id: 7, concept_id: 7, ts: 200, supersedes_id: 10, summary: 'new value' },
    { id: 13, matched_concept_id: 8, concept_id: 99, ts: 300, supersedes_id: 11, summary: 'newest multi-concept value' },
  ];
  assert.deepEqual(preferLatestConceptRows(rows, latest).map(row => row.id), [13, 20]);
});

test('latest concept evidence survives event-context expansion', () => {
  const merged = preserveLatestConceptRows(
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    [
      { id: 9, _conceptExpanded: true, retrievalScore: 0.2 },
      { id: 8, _conceptExpanded: true, retrievalScore: 0.8 },
    ],
    4,
  );
  assert.deepEqual(merged.map((row) => row.id), [1, 8, 2, 3]);
});

test('historical recall reserves classified roots without duplicating primary hits', () => {
  const merged = mergeHistoricalRecallRows(
    [
      { id: 1, is_root: 0, content: 'raw progress one' },
      { id: 2, is_root: 0, content: 'raw progress two' },
      { id: 10, is_root: 1, summary: 'primary root' },
      { id: 3, is_root: 0, content: 'raw progress three' },
    ],
    [
      { id: 10, is_root: 1, summary: 'classified root one' },
      { id: 11, is_root: 1, summary: 'classified root two' },
      { id: 12, is_root: 1, summary: 'classified root three' },
    ],
    6,
  );
  assert.equal(new Set(merged.map((row) => row.id)).size, merged.length);
  assert.equal(merged.filter((row) => row.is_root === 1).length >= 1, true);
  assert.deepEqual(merged.filter((row) => row.is_root === 0).map((row) => row.id), [1, 2, 3]);
  assert.equal(merged.find((row) => row.id === 10)?.summary, 'primary root');
  const withSummary = mergeHistoricalRecallRows(
    [{ id: 10, is_root: 1, members: [{ id: 20, ts: Date.parse('2026-08-13T12:00:00Z'), role: 'assistant', content: 'raw evidence' }] }],
    [{ id: 10, is_root: 1, element: 'decision', summary: '@@ anchors' }],
    5,
    { includeMatchedRootSummary: true },
  );
  const rendered = renderEntryLines(withSummary);
  assert.equal(parseRecallOutput(rendered).items.length, 1);
  assert.match(rendered, /raw evidence \[event: decision — @@ anchors\]/u);
  const ownSummary = mergeHistoricalRecallRows(
    [{ id: 10, is_root: 1, element: 'own decision', summary: 'own summary', members: [{ id: 20, ts: Date.parse('2026-08-13T12:00:00Z'), role: 'assistant', content: 'raw evidence' }] }],
    [],
    5,
    { includeMatchedRootSummary: true },
  );
  assert.match(renderEntryLines(ownSummary), /\[event: own decision — own summary\]/u);
  const withFallback = mergeHistoricalRecallRows(
    [{ id: 1, is_root: 0 }, { id: 2, is_root: 0 }],
    [{ id: 11, is_root: 1 }, { id: 12, is_root: 1 }, { id: 13, is_root: 1 }],
    5,
    { rootReserve: 3 },
  );
  assert.deepEqual(withFallback.map((row) => row.id), [1, 11, 12, 13, 2]);
});

test('temporal recall bounds root members before rendering', () => {
  const bounded = boundRecallRowsToTemporal([
    {
      id: 10,
      ts: 150,
      members: [
        { id: 20, ts: 90, content: 'before' },
        { id: 21, ts: 150, content: 'inside' },
        { id: 22, ts: 210, content: 'after' },
      ],
    },
    { id: 30, ts: 220, content: 'outside root' },
  ], { startMs: 100, endMs: 200 });
  assert.deepEqual(bounded.map((row) => row.id), [10]);
  assert.deepEqual(bounded[0].members.map((row) => row.id), [21]);
});

test('historical evidence places each root before its matching member', () => {
  const prioritized = prioritizeHistoricalRootEvidence([
    { id: 20, chunk_root: 10, is_root: 0 },
    { id: 10, is_root: 1 },
    { id: 30, is_root: 0 },
  ]);
  assert.deepEqual(prioritized.map((row) => row.id), [10, 20, 30]);
});

test('latest root context is attached without adding a result row', () => {
  const annotated = annotateRecallRootContext([
    { id: 10, is_root: 1, element: 'latest decision', summary: 'verified', members: [{ id: 20 }] },
  ]);
  assert.equal(annotated.length, 1);
  assert.equal(annotated[0]._historicalRootSummary, 'verified');
});

test('event expansion emits the selected session tail before matching evidence', () => {
  const ranked = [
    { id: 1, is_root: 1, session_id: 'a', ts: 100, element: 'decision', summary: 'verified', content: 'matching evidence' },
    { id: 2, session_id: 'b', ts: 90, content: 'other evidence' },
  ];
  const tails = [
    { id: 3, _anchor_order: 0, session_id: 'a', ts: 300, source_turn: 3, content: 'final result' },
    { id: 4, _anchor_order: 0, session_id: 'a', ts: 200, source_turn: 2, content: 'verification' },
    { id: 5, _anchor_order: 1, session_id: 'b', ts: 250, source_turn: 4, content: 'other final' },
  ];
  const merged = mergeRecallEventRows(ranked, tails);
  assert.deepEqual(merged.map((row) => row.id), [3, 1, 5, 2]);
  assert.equal(merged[0]._historicalRootSummary, 'verified');
  assert.match(renderEntryLines([merged[0]]), /\[event: decision — verified\]/u);
});

test('event expansion preserves ranked evidence even within one user-turn event', () => {
  const ranked = [
    { id: 1, session_id: 'a', ts: 100 },
    { id: 2, session_id: 'a', ts: 90 },
    { id: 6, session_id: 'b', ts: 80 },
  ];
  const tails = [
    { id: 3, _anchor_order: 0, _event_key: 'a:4', session_id: 'a', ts: 300 },
    { id: 4, _anchor_order: 1, _event_key: 'a:4', session_id: 'a', ts: 290 },
    { id: 5, _anchor_order: 2, _event_key: 'b:5', session_id: 'b', ts: 250 },
  ];
  assert.deepEqual(mergeRecallEventRows(ranked, tails).map((row) => row.id), [3, 1, 4, 2, 5, 6]);
  assert.deepEqual(
    mergeRecallEventRows(ranked, tails, { dedupeEvents: true }).map((row) => row.id),
    [3, 1, 5, 6],
  );
});

test('core recall binds the requested temporal window', async () => {
  const calls = [];
  const db = {
    async transaction(run) { return run(this); },
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  const { handleSearch } = createQueryHandlers({
    getDb: () => db,
    log: () => {},
    resolveProjectScope: () => null,
    embeddingWarmupCanStart: () => false,
    getBootTimestamp: () => 0,
    getTraceDb: () => null,
  });
  await handleSearch({
    query: 'reasoning summary 설정 변경',
    period: '2026-07-03 09:00~12:00',
    projectScope: 'mixdog',
    includeRaw: false,
    limit: 5,
  });
  const coreCall = calls.find(({ sql }) => /FROM core_entries/.test(sql));
  assert.ok(coreCall);
  assert.match(coreCall.sql, /COALESCE\(updated_at, created_at\) >= \$/);
  assert.match(coreCall.sql, /COALESCE\(updated_at, created_at\) <= \$/);
  assert.equal(coreCall.params.filter(Number.isFinite).length >= 2, true);
});
