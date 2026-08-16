// Consolidated suite; sources: compact-file-reattach-test.mjs, compact-prior-context-flatten-test.mjs, compact-recall-digest-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'acorn';
import { analyze } from 'eslint-scope';
import { recallFastTrackCompactMessages, semanticCompactMessages } from '../src/runtime/agent/orchestrator/session/compact.mjs';
import { runSessionCompaction } from '../src/runtime/agent/orchestrator/session/manager/compaction-runner.mjs';
import {
  buildPostCompactFileAttachment,
  MAX_REATTACH_FILES,
  REATTACH_MAX_TOTAL_TOKENS,
} from '../src/runtime/agent/orchestrator/session/compact/file-reattach.mjs';
import { estimateTokens, sanitizeToolPairs } from '../src/runtime/agent/orchestrator/session/context-utils.mjs';
import test from 'node:test';
import {
    formatPriorCompactedContextBlock,
    stripPriorCompactedContextWrappers,
    stripNestedSummaryHeaderLines,
    fitRecallFastTrackSummaryMessage,
    fitRecallRootsMessage,
} from '../src/runtime/agent/orchestrator/session/compact/summary.mjs';
import {
  compactDigestRows,
  compactHandoffRows,
  renderEntryLines,
} from '../src/runtime/memory/lib/recall-format.mjs';
import {
  collectToolOutcomeLines,
  collectWorkingFileGroups,
  collectWorkingFiles,
  composeRecallHandoff,
  conversationLinesFromMemoryText,
  fitRecallHandoffText,
} from '../src/runtime/agent/orchestrator/session/compact/handoff.mjs';
import { createQueryHandlers } from '../src/runtime/memory/lib/query-handlers.mjs';

test('compaction runner has no unresolved non-global identifiers', () => {
  const source = readFileSync(
    new URL('../src/runtime/agent/orchestrator/session/manager/compaction-runner.mjs', import.meta.url),
    'utf8',
  );
  const ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ranges: true,
  });
  const scopeManager = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' });
  const unresolved = [...new Set(
    scopeManager.globalScope.through
      .map((reference) => reference.identifier.name)
      .filter((name) => !(name in globalThis)),
  )].sort();
  assert.deepEqual(unresolved, []);
});

test('manual manager recall-fasttrack succeeds locally after Memory browse', async () => {
  const sessionId = 'compact-manager-recall-success';
  const session = {
    id: sessionId,
    provider: 'compact-manager-recall-test',
    model: 'fake-model',
    contextWindow: 20_000,
    compactBoundaryTokens: 20_000,
    messages: [
      { role: 'system', content: 'system rules stay mandatory' },
      { role: 'user', content: 'older request that Memory already stored' },
      { role: 'assistant', content: 'older answer with implementation context' },
      { role: 'user', content: 'current request stays verbatim' },
    ],
    tools: [],
    compaction: {
      type: 'recall-fasttrack',
      compactType: 'recall-fasttrack',
      tailTurns: 1,
    },
  };
  let memoryCalls = 0;
  let providerCalls = 0;
  const result = await runSessionCompaction(session, {
    mode: 'manual',
    force: true,
    sessionId,
    provider: {
      name: 'compact-manager-recall-test',
      async send() {
        providerCalls += 1;
        throw new Error('semantic fallback must not run');
      },
    },
    executeInternalToolFn: async (toolName, args, callerCtx) => {
      memoryCalls += 1;
      assert.equal(toolName, 'memory');
      assert.equal(args.action, 'search');
      assert.equal(args.compactHandoff, true);
      assert.equal(args.sessionId, sessionId);
      assert.equal(callerCtx.callerSessionId, sessionId);
      return {
        text: [
          '[2026-08-16 10:00] u: older request that Memory already stored',
          '[2026-08-16 10:01] a: older answer with implementation context',
        ].join('\n'),
      };
    },
  });
  const summary = session.messages.find((message) => (
    message?.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith('A previous model worked on this task')
  ));
  assert.equal(memoryCalls, 1);
  assert.equal(providerCalls, 0);
  assert.equal(result.error, undefined);
  assert.equal(result.recallFastTrack, true);
  assert.equal(result.semanticCompact, false);
  assert.ok(summary);
  assert.ok(summary.content.includes(`[context compacted — session ${sessionId}]`));
  assert.ok(session.messages.some((message) => message.content === 'current request stays verbatim'));
});

// ==== from compact-file-reattach-test.mjs ====
const dir = mkdtempSync(join(tmpdir(), 'reattach-'));
const fileA = join(dir, 'a.mjs'); writeFileSync(fileA, 'export const A = 1;\n'.repeat(50));
const fileB = join(dir, 'b.mjs'); writeFileSync(fileB, 'export const B = 2;\n'.repeat(50));
const fileHuge = join(dir, 'huge.txt'); writeFileSync(fileHuge, 'h'.repeat(600 * 1024)); // > 512KB cap
const budgetFiles = Array.from({ length: 5 }, (_, i) => {
  const p = join(dir, `budget-${i}.mjs`);
  writeFileSync(p, `export const budget${i} = "${'token payload '.repeat(4000)}";\n`);
  return p;
});

const readCall = (id, p) => ({ role: 'assistant', content: '', toolCalls: [{ id, name: 'read', arguments: JSON.stringify({ path: p }) }] });
const toolRes = (id) => ({ role: 'tool', toolCallId: id, content: 'old cached body '.repeat(100) });

function transcript() {
  const msgs = [{ role: 'system', content: 'rules' }];
  msgs.push({ role: 'user', content: 'fix bug in a.mjs' });
  msgs.push(readCall('c1', fileA), toolRes('c1'));
  msgs.push(readCall('c2', fileHuge), toolRes('c2'));
  msgs.push(readCall('c3', join(dir, 'missing.mjs')), toolRes('c3'));
  for (let i = 0; i < 12; i++) { msgs.push({ role: 'user', content: `iterate ${i} ` + 'pad '.repeat(300) }, { role: 'assistant', content: `ok ${i}` }); }
  // newest turn reads fileB — must survive in tail and be skipped
  msgs.push({ role: 'user', content: 'now check b.mjs' });
  msgs.push(readCall('c9', fileB), toolRes('c9'));
  msgs.push({ role: 'assistant', content: 'checked' });
  return msgs;
}

// 1) fasttrack: path index only, last-turn files stay for continuity
{
  const r = recallFastTrackCompactMessages(transcript(), 4000, { force: true, recallText: 'digest', allowEmptyRecall: true, tailTurns: 2, keepTokens: 2000, cwd: dir });
  const summary = r.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('## Working files'));
  assert.ok(summary, 'fasttrack: working-files section present');
  assert.ok(summary.content.includes('a.mjs'), 'fileA path listed');
  assert.ok(!summary.content.includes('export const A'), 'file bodies are not re-attached');
  assert.equal(JSON.stringify(sanitizeToolPairs(r.messages)), JSON.stringify(r.messages), 'pairing valid');
  assert.equal(r.diagnostics.fileReattached, false, 'file body reattach stays off');
}
// 2) semantic path with fake provider
{
  const provider = { name: 'fake', async send() { return { content: '## Goal\n- g\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- d\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- n\n\n## Critical Context\n- c\n\n## Relevant Files\n- a.mjs' }; } };
  const r = await semanticCompactMessages(provider, transcript(), 'fake-model', 4000, { force: true, tailTurns: 1, cwd: dir });
  const ref = r.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Reference files:'));
  assert.ok(ref, 'semantic: reference-files message injected');
  assert.ok(ref.content.includes('export const A'), 'semantic: fileA fresh content');
  assert.equal(r.diagnostics.fileReattached, true, 'semantic diagnostics flag');
}
// 3) no room -> no injection, still valid compact
{
  const r = recallFastTrackCompactMessages(transcript(), 1500, { force: true, recallText: 'digest', allowEmptyRecall: true, tailTurns: 1, keepTokens: 1200, cwd: dir });
  assert.ok(Array.isArray(r.messages), 'tight budget compact still succeeds');
  const ref = r.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Reference files:'));
  if (ref) assert.ok(r.diagnostics.finalTokens <= r.diagnostics.budgetTokens, 'reattach never exceeds budget');
}
// 4) env off-switch
{
  process.env.MIXDOG_COMPACT_FILE_REATTACH = '0';
  const off = buildPostCompactFileAttachment([readCall('x', fileA)], [], 10000, { cwd: dir });
  assert.equal(off, null, 'env kill-switch disables reattach');
  delete process.env.MIXDOG_COMPACT_FILE_REATTACH;
}
// 5) generous context room is still bounded by the compact re-attach envelope
{
  const calls = budgetFiles.map((p, i) => readCall(`budget-${i}`, p));
  const ref = buildPostCompactFileAttachment(calls, [], 50_000, { cwd: dir });
  assert.ok(ref, 'bounded attachment should include at least one recent file');
  assert.ok((ref.content.match(/^### /gm) || []).length <= MAX_REATTACH_FILES, 'attachment file count must stay capped');
  assert.ok(estimateTokens(ref.content) <= REATTACH_MAX_TOTAL_TOKENS, 'attachment total tokens must stay capped');
}
rmSync(dir, { recursive: true, force: true });
console.log('compact file-reattach test passed \u2713');

{
  const mem = [
    '[2026-08-13 16:40] a: later answer #2',
    '- final detail',
    '[2026-08-13 16:39] u: later question #1',
    '[2026-08-13 16:10] a: first answer #4',
    '[2026-08-13 16:09] u: first question #3',
  ].join('\n');
  const lines = conversationLinesFromMemoryText(mem);
  assert.equal(lines[0], 'u: first question');
  assert.equal(lines[3], 'a: later answer #2 - final detail');
  assert.match(lines[3], /final detail/);
  const files = collectWorkingFiles([
    { role: 'assistant', toolCalls: [{ name: 'read', arguments: { path: 'src/a.mjs' } }] },
    { role: 'assistant', toolCalls: [{ name: 'grep', arguments: { path: 'src' } }] },
    { role: 'assistant', toolCalls: [{ name: 'apply_patch', arguments: { patch: '*** Update File: src/b.mjs\n' } }] },
  ]);
  assert.deepEqual(files, ['src/b.mjs', 'src/a.mjs']);
  const groupedFiles = collectWorkingFileGroups([
    { role: 'assistant', createdAt: Date.parse('2026-01-03T00:00:00Z'), toolCalls: [{ name: 'apply_patch', arguments: { patch: '*** Update File: src/current.mjs\n' } }] },
    { role: 'assistant', createdAt: Date.parse('2026-01-04T00:00:00Z'), toolCalls: [{ name: 'read', arguments: { path: 'src/current-ref.mjs' } }] },
  ], 6, {
    previousSummary: [
      '## Working files',
      '### Modified',
      '- src/prior.mjs [editedAt=2026-01-01T00:00:00.000Z; seenAt=2026-01-01T00:00:00.000Z]',
      '### Referenced',
      '- logs/prior.log [seenAt=2026-01-02T00:00:00.000Z]',
    ].join('\n'),
  });
  assert.deepEqual(groupedFiles.modified.map((entry) => entry.path), ['src/current.mjs', 'src/prior.mjs']);
  assert.deepEqual(groupedFiles.referenced.map((entry) => entry.path), ['src/current-ref.mjs', 'logs/prior.log']);
  assert.equal(groupedFiles.modified[0].editedAt, '2026-01-03T00:00:00.000Z');
  assert.equal(groupedFiles.referenced[0].seenAt, '2026-01-04T00:00:00.000Z');
  const tools = collectToolOutcomeLines([
    { role: 'assistant', toolCalls: [{ id: 'p1', name: 'apply_patch', arguments: { patch: '*** Update File: src/b.mjs\n' } }] },
    { role: 'tool', toolCallId: 'p1', content: 'ok' },
    { role: 'assistant', toolCalls: [{ id: 's1', name: 'shell', arguments: { command: 'node --test scripts/x.mjs' } }] },
    { role: 'tool', toolCallId: 's1', content: '# tests 6\n# pass 6\n# fail 0' },
    { role: 'assistant', toolCalls: [{ id: 'g1', name: 'grep', arguments: { pattern: 'x' } }] },
    { role: 'tool', toolCallId: 'g1', content: 'lots of hits' },
  ]);
  assert.ok(tools.some((line) => /apply_patch src\/b.mjs → ok/.test(line)));
  assert.ok(tools.some((line) => /shell .* → tests /.test(line)));
  assert.ok(!tools.some((line) => /grep/.test(line)));
  const body = composeRecallHandoff({
    sessionId: 'sess_x',
    conversationLines: lines,
    toolLines: tools,
    workingFiles: groupedFiles,
  });
  assert.match(body, /## Previous conversation/);
  assert.match(body, /## Tool results/);
  assert.match(body, /## Working files/);
  assert.match(body, /### Modified[\s\S]*src\/current\.mjs/);
  assert.match(body, /### Referenced[\s\S]*src\/current-ref\.mjs/);
  assert.match(body, /editedAt=2026-01-03T00:00:00\.000Z/);
  assert.match(body, /seenAt=2026-01-04T00:00:00\.000Z/);
  const manyWorkingFiles = {
    modified: Array.from({ length: 20 }, (_, index) => ({
      path: `src/modified-${index}.mjs`,
      editedAt: '2026-01-05T00:00:00.000Z',
      seenAt: '2026-01-05T00:00:00.000Z',
    })),
    referenced: Array.from({ length: 100 }, (_, index) => ({
      path: `src/referenced-${index}.mjs`,
      seenAt: '2026-01-05T00:00:00.000Z',
    })),
  };
  const largeHandoff = composeRecallHandoff({
    sessionId: 'sess_large_files',
    conversationLines: ['u: preserve every modified file'],
    workingFiles: manyWorkingFiles,
  });
  const fittedHandoff = fitRecallHandoffText(largeHandoff, 1200);
  for (const entry of manyWorkingFiles.modified) {
    assert.ok(fittedHandoff.includes(entry.path), `${entry.path} must not be capped`);
  }
  assert.match(fittedHandoff, /\+\d+ omitted/, 'referenced files report token-budget omissions');
  assert.ok(estimateTokens(fittedHandoff) <= 1200, 'working-file handoff obeys its token budget');
  console.log('compact handoff shaping passed \u2713');
}

test('runner-level repeated compaction carries bounded prior context and working files', () => {
    const readCall = (id, path) => ({
        role: 'assistant',
        content: '',
        toolCalls: [{ id, name: 'read', arguments: JSON.stringify({ path }) }],
    });
    const toolResult = (id) => ({ role: 'tool', toolCallId: id, content: 'body' });
    let messages = [{ role: 'system', content: 'rules' }];
    let previousLatest = '';
    const requirements = [];
    const files = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
        const mid = `REQ-${cycle}-MID intervening requirement`;
        const latest = `REQ-${cycle}-LATEST latest requirement`;
        const file = `src/cycle-${cycle}.mjs`;
        requirements.push(mid, latest);
        files.push(file);
        messages.push(
            { role: 'user', content: mid },
            { role: 'assistant', content: `mid ${cycle} ack` },
            { role: 'user', content: latest },
            readCall(`read-${cycle}`, file),
            toolResult(`read-${cycle}`),
            { role: 'assistant', content: `cycle ${cycle} done` },
        );
        const recallRows = [
            `[2026-01-0${cycle + 1}] a: cycle ${cycle} done`,
            `[2026-01-0${cycle + 1}] u: ${latest}`,
            `[2026-01-0${cycle + 1}] u: ${mid}`,
        ];
        if (previousLatest) recallRows.push(`[2026-01-0${cycle + 1}] u: ${previousLatest}`);
        const result = recallFastTrackCompactMessages(messages, 12_000, {
            force: true,
            recallText: recallRows.join('\n'),
            allowEmptyRecall: false,
            tailTurns: 1,
            keepTokens: 1200,
            cwd: 'C:/repo',
            sessionId: 'sess_repeat',
        });
        const serialized = JSON.stringify(result.messages);
        for (const requirement of requirements) {
            assert.ok(serialized.includes(requirement), `cycle ${cycle} retained ${requirement}`);
        }
        for (const workingFile of files) {
            assert.ok(serialized.includes(workingFile), `cycle ${cycle} retained ${workingFile}`);
        }
        const summary = result.messages.find((message) => (
            typeof message.content === 'string' && message.content.includes('[context compacted')
        ));
        const summaryBody = String(summary?.content || '');
        assert.equal((summaryBody.match(/<prior-compacted-context>/g) || []).length <= 1, true);
        assert.equal((summaryBody.match(/## Working files/g) || []).length, 1);
        messages = result.messages;
        previousLatest = latest;
    }
});

// ==== from compact-prior-context-flatten-test.mjs ====
// Regression test for the repeated-compaction prior-context invariant: every
// generated recall-fasttrack summary carries AT MOST ONE
// <prior-compacted-context> wrapper (never nested/duplicated across cycles),
// preserves each prior requirement exactly once, and keeps repeated-cycle
// token size bounded even when the same content is re-fed every cycle.

const OPEN = '<prior-compacted-context>';
const CLOSE = '</prior-compacted-context>';
const countOpen = (s) => (String(s).match(/<prior-compacted-context>/g) || []).length;
const countClose = (s) => (String(s).match(/<\/prior-compacted-context>/g) || []).length;
const countAll = (s, needle) => (String(s).match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

// A stable, non-empty compaction head so compactHeader() is deterministic.
const OLD = [{ role: 'user', content: 'seed task' }, { role: 'assistant', content: 'ack' }];
// Large enough budget that no fit-time truncation fires — the flattening path,
// not the truncation path, is under test.
const BIG = 1_000_000;
// The engine feeds the previous summary body back as the next cycle's prior
// after stripping the summary header lines (compact/runner.mjs splitRecallFitInputs).
const nextPrior = (msg) => stripNestedSummaryHeaderLines(String(msg?.content || ''));

test('formatPriorCompactedContextBlock wraps bare prior text exactly once', () => {
    const out = formatPriorCompactedContextBlock('REQ-A keep files\nREQ-B run tests');
    assert.equal(countOpen(out), 1);
    assert.equal(countClose(out), 1);
    assert.match(out, /REQ-A keep files/);
    assert.match(out, /REQ-B run tests/);
});

test('formatPriorCompactedContextBlock flattens an already-wrapped prior to one wrapper', () => {
    const alreadyWrapped = `${OPEN}\nREQ-A\nREQ-B\n${CLOSE}\n\nREQ-C`;
    const out = formatPriorCompactedContextBlock(alreadyWrapped);
    assert.equal(countOpen(out), 1);
    assert.equal(countClose(out), 1);
    for (const req of ['REQ-A', 'REQ-B', 'REQ-C']) assert.match(out, new RegExp(req));
});

test('formatPriorCompactedContextBlock flattens deeply nested wrappers to one', () => {
    const nested = `${OPEN}\n${OPEN}\n${OPEN}\nDEEP\n${CLOSE}\nMID\n${CLOSE}\nTOP\n${CLOSE}`;
    const out = formatPriorCompactedContextBlock(nested);
    assert.equal(countOpen(out), 1);
    assert.equal(countClose(out), 1);
    for (const req of ['DEEP', 'MID', 'TOP']) assert.match(out, new RegExp(req));
});

test('formatPriorCompactedContextBlock keeps duplicate blocks exactly once', () => {
    const dupe = 'REQ-A keep\n\nREQ-B test\n\nREQ-A keep';
    const out = formatPriorCompactedContextBlock(dupe);
    assert.equal(countAll(out, 'REQ-A keep'), 1);
    assert.equal(countAll(out, 'REQ-B test'), 1);
});

test('dedupe is byte/content preserving: distinct-whitespace blocks are NOT merged', () => {
    // `printf 'a  b'` (two spaces) and `printf 'a b'` (one space) are DISTINCT
    // commands — collapsing whitespace for the dedupe key would wrongly merge
    // them and silently corrupt a preserved command. Both must survive verbatim.
    const prior = "printf 'a  b'\n\nprintf 'a b'";
    const out = formatPriorCompactedContextBlock(prior);
    assert.match(out, /printf 'a  b'/, 'two-space variant preserved verbatim');
    assert.match(out, /printf 'a b'/, 'one-space variant preserved verbatim');
    // Both distinct blocks are kept (neither is dropped as a "duplicate").
    assert.equal(countAll(out, "printf 'a  b'"), 1);
    // Exactly one structural wrapper around the two distinct blocks.
    assert.equal(countOpen(out), 1);
    assert.equal(countClose(out), 1);
});

test('dedupe removes only structurally identical blocks and preserves inner whitespace', () => {
    // The two byte-identical `run   step` blocks collapse to one (bounded
    // growth); a block with distinct inner whitespace is preserved untouched.
    const prior = 'run   step\n\nrun   step\n\nkeep\tthis  spacing';
    const out = formatPriorCompactedContextBlock(prior);
    assert.equal(countAll(out, 'run   step'), 1, 'exact repeats collapse to one');
    assert.match(out, /keep\tthis  spacing/, 'inner whitespace never collapsed/trimmed');
});

test('formatPriorCompactedContextBlock returns empty for blank / tag-only input', () => {
    assert.equal(formatPriorCompactedContextBlock(''), '');
    assert.equal(formatPriorCompactedContextBlock(`${OPEN}\n${CLOSE}`), '');
});

test('empty / blank / boundary-only prior yields ZERO wrappers (optimization-safe at-most-one)', () => {
    // The production summary body joins only non-empty parts, so an empty prior
    // is canonicalized to NO wrapper rather than an empty tag pair — "exactly
    // one wrapper" is realized as one-when-content-exists, none otherwise,
    // never more than one and never nested.
    assert.equal(formatPriorCompactedContextBlock(''), '');
    assert.equal(formatPriorCompactedContextBlock('   \n  \t '), '');
    assert.equal(formatPriorCompactedContextBlock(`${OPEN}\n${CLOSE}`), '');
    assert.equal(formatPriorCompactedContextBlock(`${OPEN}\n\n   \n${CLOSE}`), '');
    assert.equal(formatPriorCompactedContextBlock(`${OPEN}\n${OPEN}\n${CLOSE}\n${CLOSE}`), '');
});

test('flattening preserves inline marker-like content verbatim (no P1 corruption)', () => {
    // Regression: an earlier inline-strip regex turned "keep <prior-compacted-context>
    // literal" into "keepliteral". Only STRUCTURAL boundary lines may be removed;
    // inline marker-like user content must survive byte-for-byte.
    const note = 'keep <prior-compacted-context> literal in this note';
    const bare = stripPriorCompactedContextWrappers(`${OPEN}\n${note}\n${CLOSE}`);
    assert.equal(bare, note);
    assert.doesNotMatch(bare, /keepliteral/);
});

test('formatPriorCompactedContextBlock does not corrupt inline marker-like content', () => {
    const note = 'REQ keep <prior-compacted-context> literal';
    const out = formatPriorCompactedContextBlock(`${OPEN}\n${note}\n${CLOSE}`);
    // Exactly one STRUCTURAL wrapper: boundary tags each appear once on their
    // own line (the inline literal is content, not a boundary).
    const lines = out.split('\n');
    assert.equal(lines.filter((l) => l.trim() === OPEN).length, 1);
    assert.equal(lines.filter((l) => l.trim() === CLOSE).length, 1);
    assert.match(out, /REQ keep <prior-compacted-context> literal/);
});

test('stripPriorCompactedContextWrappers removes every wrapper tag', () => {
    const bare = stripPriorCompactedContextWrappers(`${OPEN}\ninner-A\ninner-B\n${CLOSE}`);
    assert.doesNotMatch(bare, /prior-compacted-context/);
    assert.equal(bare, 'inner-A\ninner-B');
});

test('stripNestedSummaryHeaderLines strips the prior-compacted-context wrapper', () => {
    const body = `${OPEN}\nREQ-A\n${CLOSE}\n\nREQ-B`;
    const out = stripNestedSummaryHeaderLines(body);
    assert.doesNotMatch(out, /prior-compacted-context/);
    assert.match(out, /REQ-A/);
    assert.match(out, /REQ-B/);
});

test('canonicalization preserves leading, trailing, and repeated newline bytes', () => {
    const prior = '\n\nleading\n\n\nmiddle\n\ntrailing\n';
    const out = formatPriorCompactedContextBlock(prior);
    assert.ok(out.includes(`${OPEN}\n${prior}\n${CLOSE}`), 'wrapper keeps the prior bytes untouched');
    assert.equal(stripNestedSummaryHeaderLines(out), prior,
        'structural header removal does not trim or collapse surrounding bytes');
});

test('both recall fitters retain prior whitespace byte-for-byte', () => {
    const prior = '\n  leading\n\n\ntrailing  \n';
    const fast = fitRecallFastTrackSummaryMessage(OLD, 'recall', BIG, {}, prior);
    const roots = fitRecallRootsMessage(OLD, '# chunk 1 root=1\nbody', BIG, {}, prior);
    for (const message of [fast, roots]) {
        assert.ok(String(message.content).includes(`${OPEN}\n${prior}\n${CLOSE}`));
    }
});

test('repeated recall-fasttrack compaction keeps one prior wrapper and every req once', () => {
    const reqs = [
        'REQ-1 initial spec',
        'REQ-2 second decision',
        'REQ-3 third step',
        'REQ-4 fourth fact',
        'REQ-5 fifth note',
    ];
    let prior = '';
    let last = '';
    for (let i = 0; i < reqs.length; i += 1) {
        const msg = fitRecallFastTrackSummaryMessage(OLD, reqs[i], BIG, {}, prior);
        assert.ok(msg, `cycle ${i} produced a summary message`);
        const body = String(msg.content || '');
        assert.ok(countOpen(body) <= 1, `cycle ${i} has at most one open wrapper`);
        assert.equal(countOpen(body), countClose(body), `cycle ${i} wrappers are balanced`);
        prior = nextPrior(msg);
        last = body;
    }
    for (const req of reqs) {
        assert.equal(countAll(last, req), 1, `${req} survives into the final summary exactly once`);
    }
});

test('repeated compaction with identical recall is byte-stable after the first canonical cycle', () => {
    const recall = 'STABLE REQUIREMENT preserve exactly one copy';
    let prior = '';
    const sizes = [];
    const serialized = [];
    for (let i = 0; i < 8; i += 1) {
        const msg = fitRecallFastTrackSummaryMessage(OLD, recall, BIG, {}, prior);
        const body = String(msg.content || '');
        assert.ok(countOpen(body) <= 1, `cycle ${i} never nests wrappers`);
        // At most one copy inside the prior wrapper + one live recall copy.
        assert.ok(countAll(body, 'STABLE REQUIREMENT') <= 2, `cycle ${i} keeps bounded copies`);
        sizes.push(body.length);
        serialized.push(body);
        prior = nextPrior(msg);
    }
    const stableSizes = sizes.slice(1);
    const stableBodies = serialized.slice(1);
    assert.ok(stableSizes.every((size) => size === stableSizes[0]),
        `serialized size is exactly stable after canonical cycle (sizes=${sizes.join(',')})`);
    assert.ok(stableBodies.every((body) => body === stableBodies[0]),
        'serialized output is exactly stable after canonical cycle');
});

test('many generated-summary refeeds add no newline bytes', () => {
    const recall = 'NO NEWLINE GROWTH';
    let prior = '';
    let canonical = null;
    for (let i = 0; i < 32; i += 1) {
        const message = fitRecallFastTrackSummaryMessage(OLD, recall, BIG, {}, prior);
        const body = String(message.content || '');
        if (i === 1) canonical = body;
        if (i > 1) assert.equal(body, canonical, `cycle ${i} must not add wrapper separator bytes`);
        prior = nextPrior(message);
    }
});

test('duplicate live recall never consumes prior-owned leading or trailing newlines', () => {
    const variants = [
        'X\n',
        'X\n\n',
        'X\n\n\n',
        '\nX',
        '\n\nX',
        '\nX\n\n',
    ];
    for (const initialPrior of variants) {
        let prior = initialPrior;
        let canonical = null;
        for (let i = 0; i < 32; i += 1) {
            const message = fitRecallFastTrackSummaryMessage(OLD, 'X', BIG, {}, prior);
            const body = String(message.content || '');
            if (i === 0) canonical = body;
            assert.equal(body, canonical, `variant=${JSON.stringify(initialPrior)} cycle=${i} changed bytes`);
            prior = nextPrior(message);
        }
    }
});

test('smart-arrival roots compaction also flattens the re-fed prior to one wrapper', () => {
    const roots = '# chunk 1 root=1\nmember a\n\n# chunk 2 root=2\nmember b';
    const first = fitRecallRootsMessage(OLD, roots, BIG, {}, '');
    let prior = nextPrior(first);
    const second = fitRecallRootsMessage(OLD, '# chunk 3 root=3\nmember c', BIG, {}, prior);
    const body = String(second.content || '');
    assert.equal(countOpen(body), 1);
    assert.equal(countClose(body), 1);
    // Feed once more to prove the wrapper never nests across a third cycle.
    prior = nextPrior(second);
    const third = fitRecallRootsMessage(OLD, '# chunk 4 root=4\nmember d', BIG, {}, prior);
    const body3 = String(third.content || '');
    assert.equal(countOpen(body3), 1);
    assert.equal(countClose(body3), 1);
});

// ==== from compact-recall-digest-test.mjs ====
const longPlan = 'cache recent session snapshots and display immediately while the runtime initializes in the background without a blocking veil';
const nearPlan = `${longPlan} and keep the newest click authoritative`;
const rows = [
  { id: 10, ts: 300, role: 'assistant', content: nearPlan, is_root: 0, chunk_root: null },
  { id: 9, ts: 290, role: 'assistant', content: longPlan, is_root: 0, chunk_root: null },
  { id: 8, ts: 280, role: 'assistant', content: longPlan, is_root: 0, chunk_root: null },
  { id: 7, ts: 270, role: 'user', content: '오케이', is_root: 0, chunk_root: null },
  { id: 6, ts: 260, role: 'user', content: '오케이', is_root: 0, chunk_root: null },
  { id: 5, ts: 250, role: 'assistant', content: 'distinct completed result', is_root: 0, chunk_root: null },
];

const compact = compactDigestRows(rows, 30);
assert.equal(compact.filter((row) => row.content === '오케이').length, 1, 'short exact duplicates collapse');
assert.equal(compact.filter((row) => row.content === longPlan).length, 0, 'older near-duplicate plans collapse');
assert.ok(compact.some((row) => row.content === nearPlan), 'newest near-duplicate plan is retained');
assert.ok(compact.some((row) => row.content === 'distinct completed result'), 'distinct state survives');

const handoffRows = compactHandoffRows([
  { id: 10, ts: 600, is_root: 1, element: 'classified decision', members: [{ id: 99 }] },
  { id: 9, ts: 500, source_turn: 5, role: 'assistant', content: 'second final', is_root: 0, chunk_root: null },
  { id: 8, ts: 450, source_turn: 4, role: 'assistant', content: 'second progress', is_root: 0, chunk_root: null },
  { id: 7, ts: 400, source_turn: 3, role: 'user', content: 'second question', is_root: 0, chunk_root: null },
  { id: 6, ts: 300, source_turn: 2, role: 'assistant', content: 'first final', is_root: 0, chunk_root: null },
  { id: 5, ts: 250, source_turn: 1, role: 'assistant', content: 'first progress', is_root: 0, chunk_root: null },
  { id: 4, ts: 200, source_turn: 0, role: 'user', content: 'first question', is_root: 0, chunk_root: null },
], 20);
assert.deepEqual(handoffRows.map((row) => row.id), [10, 9, 7, 6, 4], 'handoff keeps roots and event endpoints');
assert.equal(Object.hasOwn(handoffRows[0], 'members'), false, 'handoff renders classified roots as summaries');

const normalText = renderEntryLines(compact);
assert.match(normalText, /\[pending\]/, 'normal recall keeps raw-row pipeline status');
const digestText = renderEntryLines(compact, { pendingMarks: false });
assert.doesNotMatch(digestText, /\[pending\]/, 'compact digest omits misleading pipeline status');

const fakeDb = {
  async query(sql) {
    if (/SELECT source_turn t/.test(sql)) return { rows: [] };
    if (/id <> ALL/.test(sql)) return { rows: [] };
    if (/FROM entries/.test(sql)) return { rows };
    return { rows: [] };
  },
};
const { handleSearch } = createQueryHandlers({
  getDb: () => fakeDb,
  log: () => {},
  resolveProjectScope: () => null,
  embeddingWarmupCanStart: () => false,
  getBootTimestamp: () => 0,
  getTraceDb: () => null,
});
const integrated = await handleSearch({
  sessionId: 'compact-digest-session',
  limit: 30,
  includeMembers: true,
  includeRaw: true,
  compactDigest: true,
});
assert.doesNotMatch(integrated.text, /\[pending\]/, 'compact search path suppresses pipeline status');
assert.equal((integrated.text.match(/오케이/g) || []).length, 1, 'compact search path removes exact duplicates');
assert.equal((integrated.text.match(/cache recent session snapshots/g) || []).length, 1, 'compact search path removes near duplicates');

// Compaction digest must not apply the in-flight current-turn cutoff: the
// watcher-backed stored history may contain a newly finalized turn whose
// timestamp is still fresh and would otherwise be dropped from the digest.
const freshTurnRows = [
  { id: 21, ts: Date.now(), role: 'assistant', content: 'newest finalized answer', is_root: 0, chunk_root: null, source_turn: 7 },
  { id: 20, ts: Date.now() - 1000, role: 'user', content: 'older question', is_root: 0, chunk_root: null, source_turn: 6 },
];
const seenSql = [];
const freshDb = {
  // Honours the cutoff predicate the way the real DB would: when the executed
  // SQL carries `NOT (chunk_root IS NULL AND source_turn = $n)`, the excluded
  // turn's rows really disappear, so the survival assertion below fails on
  // pre-fix code instead of passing vacuously.
  async query(sql, params = []) {
    seenSql.push(sql);
    if (/SELECT source_turn t/.test(sql)) return { rows: [{ t: 7, last_ts: Date.now() }] };
    if (/id <> ALL/.test(sql)) return { rows: [] };
    if (/FROM entries/.test(sql)) {
      const cutoff = /NOT \(chunk_root IS NULL AND source_turn = \$(\d+)\)/.exec(sql);
      if (!cutoff) return { rows: freshTurnRows };
      const excluded = Number(params[Number(cutoff[1]) - 1]);
      return {
        rows: freshTurnRows.filter((row) => !(row.chunk_root == null && Number(row.source_turn) === excluded)),
      };
    }
    return { rows: [] };
  },
};
const freshHandlers = createQueryHandlers({
  getDb: () => freshDb,
  log: () => {},
  resolveProjectScope: () => null,
  embeddingWarmupCanStart: () => false,
  getBootTimestamp: () => 0,
  getTraceDb: () => null,
});
const digest = await freshHandlers.handleSearch({
  sessionId: 'compact-digest-fresh-session',
  limit: 30,
  includeRaw: true,
  compactDigest: true,
});
assert.match(digest.text, /newest finalized answer/, 'compact digest keeps the newest finalized turn');
assert.ok(
  !seenSql.some((sql) => /GROUP BY source_turn/.test(sql)),
  'compact digest never issues the current-turn discovery query',
);
assert.ok(
  !seenSql.some((sql) => /NOT \(chunk_root IS NULL AND source_turn/.test(sql)),
  'compact digest never applies the current-turn cutoff clause',
);

const ALL_RECALL_CATEGORIES = [
  'rule',
  'constraint',
  'decision',
  'fact',
  'goal',
  'preference',
  'task',
  'issue',
];
function createLastBrowseDb(rawRow, seenQueries) {
  return {
    async transaction(run) {
      return run(this);
    },
    async query(sql, params = []) {
      seenQueries.push({ sql, params });
      if (/GROUP BY (?:e\.)?session_id/.test(sql)) {
        return {
          rows: [{
            session_id: rawRow.session_id,
            first_ts: rawRow.ts,
            last_ts: rawRow.ts,
          }],
        };
      }
      if (/WHERE is_root = \$1/.test(sql)) return { rows: [] };
      if (/chunk_root IS NULL/.test(sql) && /is_root = 0/.test(sql)) return { rows: [rawRow] };
      return { rows: [] };
    },
  };
}
function createLastBrowseHandlers(db) {
  return createQueryHandlers({
    getDb: () => db,
    log: () => {},
    resolveProjectScope: () => null,
    embeddingWarmupCanStart: () => false,
    getBootTimestamp: () => 0,
    getTraceDb: () => null,
  });
}

const allCategoryQueries = [];
const allCategoryRaw = {
  id: 31,
  ts: Date.now() - 1000,
  role: 'assistant',
  content: 'fresh pending restart context',
  session_id: 'recent-all-category-session',
  source_turn: 9,
  chunk_root: null,
  is_root: 0,
  category: null,
};
const allCategoryBrowse = await createLastBrowseHandlers(
  createLastBrowseDb(allCategoryRaw, allCategoryQueries),
).handleSearch({
  query: 'restart context',
  period: 'last',
  limit: 1,
  includeMembers: true,
  includeRaw: true,
  category: ALL_RECALL_CATEGORIES,
  projectScope: 'mixdog',
});
assert.match(allCategoryBrowse.text, /fresh pending restart context/, 'all categories keep fresh unclassified raw turns');
assert.doesNotMatch(allCategoryBrowse.text, /0 entries/, 'all-category browse never emits an empty selected session');
const allCategorySelection = allCategoryQueries.find(({ sql }) => /GROUP BY (?:e\.)?session_id/.test(sql));
assert.ok(allCategorySelection, 'all-category browse selects recent sessions');
assert.doesNotMatch(allCategorySelection.sql, /coalesce\(category/, 'all categories normalize to an unrestricted session query');

const subsetCategoryQueries = [];
const subsetCategoryRaw = {
  ...allCategoryRaw,
  id: 32,
  content: 'fresh decision restart context',
  session_id: 'recent-decision-session',
  category: 'decision',
};
const subsetCategoryBrowse = await createLastBrowseHandlers(
  createLastBrowseDb(subsetCategoryRaw, subsetCategoryQueries),
).handleSearch({
  query: 'restart context',
  period: 'last',
  limit: 1,
  includeMembers: true,
  includeRaw: true,
  category: ['decision'],
  projectScope: 'mixdog',
});
assert.match(subsetCategoryBrowse.text, /fresh decision restart context/, 'subset category keeps matching raw turns');
const subsetCategorySelection = subsetCategoryQueries.find(({ sql }) => /GROUP BY (?:e\.)?session_id/.test(sql));
assert.ok(subsetCategorySelection, 'subset-category browse selects recent sessions');
assert.match(subsetCategorySelection.sql, /lower\(coalesce\((?:e\.)?category, ''\)\) IN/, 'subset category filters session selection');
assert.ok(subsetCategorySelection.params.includes('decision'), 'subset category selection binds the requested category');

console.log('compact recall digest test passed \u2713');
