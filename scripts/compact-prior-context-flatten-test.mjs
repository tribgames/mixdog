#!/usr/bin/env node
// Regression test for the repeated-compaction prior-context invariant: every
// generated recall-fasttrack summary carries AT MOST ONE
// <prior-compacted-context> wrapper (never nested/duplicated across cycles),
// preserves each prior requirement exactly once, and keeps repeated-cycle
// token size bounded even when the same content is re-fed every cycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    formatPriorCompactedContextBlock,
    stripPriorCompactedContextWrappers,
    stripNestedSummaryHeaderLines,
    fitRecallFastTrackSummaryMessage,
    fitRecallRootsMessage,
} from '../src/runtime/agent/orchestrator/session/compact/summary.mjs';

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
// after stripping the summary header lines (compact/engine.mjs splitRecallFitInputs).
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
