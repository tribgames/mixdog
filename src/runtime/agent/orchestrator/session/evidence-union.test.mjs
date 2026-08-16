import assert from 'node:assert/strict';
import test from 'node:test';
import { projectProviderEvidence } from './evidence-union.mjs';

function call(id, name, args = {}) {
    return { role: 'assistant', content: '', toolCalls: [{ id, name, arguments: args }] };
}

function result(id, content) {
    return { role: 'tool', toolCallId: id, toolKind: 'normal', content };
}

test('keeps the first read and puts only new lines plus prior locations in later envelopes', () => {
    const beta = `beta ${'b'.repeat(96)}`;
    const gamma = `gamma ${'g'.repeat(96)}`;
    const first = result('read_1', `1→alpha\n2→${beta}\n3→${gamma}\n[lines 1-3]`);
    const second = result('read_2', `2→${beta}\n3→${gamma}\n4→delta\n[lines 2-4]`);
    const messages = [
        call('read_1', 'read', { file_path: 'src/a.mjs' }),
        first,
        call('read_2', 'read', { file_path: 'src/a.mjs' }),
        second,
    ];

    const projected = projectProviderEvidence(messages);
    assert.equal(projected.messages[1], first);
    assert.equal(projected.messages[3].toolCallId, 'read_2');
    assert.match(projected.messages[3].content, /\[evidence-ref tool_call_id="read_1" location=src\/a\.mjs:2-3\]/);
    assert.doesNotMatch(projected.messages[3].content, /(?:^|\n)2→beta/);
    assert.doesNotMatch(projected.messages[3].content, /(?:^|\n)3→gamma/);
    assert.match(projected.messages[3].content, /(?:^|\n)4→delta/);
    assert.equal(messages[3], second);
    assert.equal(messages[3].content, `2→${beta}\n3→${gamma}\n4→delta\n[lines 2-4]`);
    assert.equal(projected.stats.reusedRows, 2);
});

test('requires exact content at the same path and line', () => {
    const messages = [
        call('read_1', 'read', { file_path: 'src/a.mjs' }),
        result('read_1', '2→old'),
        call('read_2', 'read', { file_path: 'src/a.mjs' }),
        result('read_2', '2→new'),
    ];
    const projected = projectProviderEvidence(messages);
    assert.equal(projected.messages, messages);
    assert.equal(projected.stats.reusedRows, 0);
});

test('references exact repeated list, glob, and find results without changing envelopes', () => {
    const content = Array.from({ length: 24 }, (_, index) => `src/feature-${index}.mjs`).join('\n');
    for (const name of ['list', 'glob', 'find', 'find_files']) {
        const first = result(`${name}_1`, content);
        const second = result(`${name}_2`, content);
        const messages = [
            call(`${name}_1`, name),
            first,
            call(`${name}_2`, name),
            second,
        ];
        const projected = projectProviderEvidence(messages);
        assert.equal(projected.messages[1], first, name);
        assert.equal(projected.messages[3].toolCallId, `${name}_2`, name);
        assert.match(projected.messages[3].content, new RegExp(`tool_call_id="${name}_1"`), name);
        assert.match(projected.messages[3].content, /exact_bytes=\d+/, name);
        assert.doesNotMatch(projected.messages[3].content, /src\/feature-0\.mjs/, name);
        assert.equal(projected.stats.exactResultRefs, 1, name);
        assert.ok(projected.stats.exactResultBytesSaved > 0, name);
        assert.equal(messages[3], second, name);
    }
});

test('keeps tiny exact results when a reference would be larger', () => {
    const messages = [
        call('list_1', 'list'),
        result('list_1', 'src'),
        call('list_2', 'list'),
        result('list_2', 'src'),
    ];
    const projected = projectProviderEvidence(messages);
    assert.equal(projected.messages, messages);
    assert.equal(projected.stats.exactResultRefs, 0);
});

test('apply_patch, shell, and mutating git batches invalidate all earlier evidence', () => {
    const same = `same ${'s'.repeat(160)}`;
    const listing = Array.from({ length: 24 }, (_, index) => `src/item-${index}.mjs`).join('\n');
    for (const [mutationName, mutationArgs] of [
        ['apply_patch', {}],
        ['shell', {}],
        ['git', { command: 'git commit -m test' }],
        ['git', { command: "git reflog delete 'HEAD@{1}'", confirm: true }],
    ]) {
        const messages = [
            call('read_1', 'read', { file_path: 'src/a.mjs' }),
            result('read_1', `2→${same}`),
            call('list_1', 'list'),
            result('list_1', listing),
            call('mut_1', mutationName, mutationArgs),
            result('mut_1', 'ok'),
            call('read_2', 'read', { file_path: 'src/a.mjs' }),
            result('read_2', `2→${same}`),
            call('list_2', 'list'),
            result('list_2', listing),
        ];
        const projected = projectProviderEvidence(messages);
        assert.equal(projected.messages, messages, mutationName);
        assert.equal(projected.stats.reusedRows, 0, mutationName);
        assert.equal(projected.stats.exactResultRefs, 0, mutationName);
    }
});

test('read-only git operations preserve earlier evidence', () => {
    const beta = `beta ${'b'.repeat(96)}`;
    const gamma = `gamma ${'g'.repeat(96)}`;
    const messages = [
        call('read_1', 'read', { file_path: 'src/a.mjs' }),
        result('read_1', `1→alpha\n2→${beta}\n3→${gamma}\n[lines 1-3]`),
        call('git_1', 'git', { command: 'git status' }),
        result('git_1', '{"ok":true}'),
        call('read_2', 'read', { file_path: 'src/a.mjs' }),
        result('read_2', `2→${beta}\n3→${gamma}\n4→delta\n[lines 2-4]`),
    ];
    const projected = projectProviderEvidence(messages);
    assert.equal(projected.stats.reusedRows, 2);
    assert.match(projected.messages[5].content, /tool_call_id="read_1"/);
});

test('deduplicates deterministic grep context rows while preserving the tool envelope', () => {
    const eleven = `eleven ${'e'.repeat(96)}`;
    const twelve = `twelve ${'t'.repeat(96)}`;
    const messages = [
        call('grep_1', 'grep'),
        result('grep_1', `# src/a.mjs:11 [lines 10-12]\nten\n${eleven}\n${twelve}`),
        call('grep_2', 'grep'),
        result('grep_2', `# src/a.mjs:12 [lines 11-13]\n${eleven}\n${twelve}\nthirteen`),
    ];
    const projected = projectProviderEvidence(messages);
    assert.equal(projected.messages[3].toolCallId, 'grep_2');
    assert.match(projected.messages[3].content, /location=src\/a\.mjs:11-12/);
    assert.doesNotMatch(projected.messages[3].content, /(?:^|\n)eleven/);
    assert.doesNotMatch(projected.messages[3].content, /(?:^|\n)twelve/);
    assert.match(projected.messages[3].content, /(?:^|\n)thirteen(?:\n|$)/);
});

test('shadow mode reports savings without changing provider messages', () => {
    const same = `same ${'s'.repeat(160)}`;
    const messages = [
        call('read_1', 'read', { path: 'src/a.mjs' }),
        result('read_1', `1→${same}`),
        call('read_2', 'read', { path: 'src/a.mjs' }),
        result('read_2', `1→${same}`),
    ];
    const projected = projectProviderEvidence(messages, { apply: false });
    assert.equal(projected.messages, messages);
    assert.equal(projected.stats.reusedRows, 1);
    assert.ok(projected.stats.afterBytes < projected.stats.beforeBytes);
});
