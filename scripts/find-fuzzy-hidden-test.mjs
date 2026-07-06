import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fuzzyRank } from '../src/runtime/agent/orchestrator/tools/builtin/fuzzy-match.mjs';
import { executeFuzzyFindTool } from '../src/runtime/agent/orchestrator/tools/builtin/list-tool.mjs';
import { runRg } from '../src/runtime/agent/orchestrator/tools/builtin/rg-runner.mjs';

// ── fuzzyRank score floor ────────────────────────────────────────────────

test('fuzzyRank keeps an exact basename/substring hit and drops scattered noise', () => {
    const items = [
        { path: '.mixdog/data/tool-events.log' },
        // subsequence-only junk: the query chars appear in order but scattered
        // mid-word across dirs, no contiguity or word boundaries.
        { path: 'pgadmin/xtx/oxoxl/exvxexnxtx/sxlxoxg/records.dat' },
    ];
    const ranked = fuzzyRank('tool-events.log', items);
    assert.ok(ranked.length >= 1, 'the real file must survive the floor');
    assert.equal(ranked[0].item.path, '.mixdog/data/tool-events.log');
    assert.ok(
        !ranked.some((r) => r.item.path.startsWith('pgadmin/')),
        'scattered subsequence junk must be filtered out',
    );
});

test('fuzzyRank floor drops a purely scattered subsequence but keeps a substring', () => {
    const strong = { path: 'src/abcdef.txt' };
    const junk = { path: 'xax/xbxcx/xdxexfx/z.bin' };
    const ranked = fuzzyRank('abcdef', [strong, junk]);
    assert.deepEqual(ranked.map((r) => r.item.path), ['src/abcdef.txt']);
});

// ── hidden-directory discovery via the find tool ─────────────────────────

function makeRepo() {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-find-hidden-'));
    mkdirSync(join(root, '.mixdog', 'data'), { recursive: true });
    writeFileSync(join(root, '.mixdog', 'data', 'tool-events.log'), 'x\n');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'unrelated.txt'), 'x\n');
    // .git noise must stay pruned even with hidden default true.
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'tool-events.log'), 'x\n');
    return root;
}

test('find surfaces a file under a dot-directory top-ranked (hidden default true)', async () => {
    const root = makeRepo();
    try {
        const out = await executeFuzzyFindTool({ query: 'tool-events.log' }, root);
        const lines = out.split('\n').filter(Boolean);
        assert.ok(lines.length >= 1, `expected a hit, got: ${out}`);
        assert.equal(lines[0], '.mixdog/data/tool-events.log');
        assert.ok(!out.includes('.git/'), '.git must stay pruned as noise');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('find hidden:false skips dot-directories', async () => {
    const root = makeRepo();
    try {
        const out = await executeFuzzyFindTool({ query: 'tool-events.log', hidden: false }, root);
        assert.ok(!out.includes('.mixdog'), `hidden:false must not descend dot-dirs: ${out}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// ── narrowed-pass merge / dedup backstop ─────────────────────────────────

test('exact-name hit survives among many decoys and is not duplicated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-find-merge-'));
    try {
        // A deep exact-name target plus a pile of unrelated decoys. The target
        // matches both the broad enumeration and the query-narrowed pass, so it
        // exercises the merge+dedup path.
        mkdirSync(join(root, 'deep', 'nested', 'here'), { recursive: true });
        writeFileSync(join(root, 'deep', 'nested', 'here', 'tool-events.log'), 'x\n');
        mkdirSync(join(root, 'noise'), { recursive: true });
        for (let i = 0; i < 200; i++) {
            writeFileSync(join(root, 'noise', `decoy-${i}.bin`), 'x\n');
        }
        const out = await executeFuzzyFindTool({ query: 'tool-events.log' }, root);
        const lines = out.split('\n').filter(Boolean);
        assert.equal(lines[0], 'deep/nested/here/tool-events.log');
        const hits = lines.filter((l) => l === 'deep/nested/here/tool-events.log');
        assert.equal(hits.length, 1, `merge must dedup, got ${hits.length}: ${out}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// ── truncation warning surfaces when the broad pass reports .truncated ────

test('truncated broad enumeration emits a visible warning, still ranks the exact hit, and is not cached', async () => {
    const root = makeRepo();
    try {
        // Test-only seam: wrap the real runRg so the BROAD pass (the one without
        // `--iglob`) reports truncation via the boxed-String contract the tool
        // relies on (.truncated=true), while the narrowed pass is left intact.
        // Production options never carry __runRg, so the real path is unchanged.
        const truncatingRunRg = async (argsList, execOptions) => {
            const out = await runRg(argsList, execOptions);
            if (argsList.includes('--iglob')) return out; // narrowed backstop unchanged
            const boxed = new String(String(out));
            boxed.truncated = true;
            return boxed;
        };
        const out = await executeFuzzyFindTool(
            { query: 'tool-events.log' }, root, { __runRg: truncatingRunRg },
        );
        assert.ok(out.includes('[warning]'), `truncated broad pass must warn: ${out}`);
        assert.ok(out.includes('truncated at 20MB cap'), `warning text must surface: ${out}`);
        const lines = out.split('\n').filter(Boolean);
        assert.equal(lines[0], '.mixdog/data/tool-events.log', 'exact hit must still rank first');
        // Not cached: a normal follow-up run (no injected truncation) must NOT
        // return the warning — proving the truncated result was never cached.
        const out2 = await executeFuzzyFindTool({ query: 'tool-events.log' }, root);
        assert.ok(!out2.includes('[warning]'), `truncated result must not be cached/served: ${out2}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// ── narrowed backstop treats the query as a literal (glob metachars) ──────

test('a query with glob metachars still gets the narrowed backstop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-find-glob-'));
    try {
        // "[slug].tsx" contains a character-class metachar; a raw *[slug].tsx*
        // iglob would match one of s/l/u/g, not the literal filename. The tool
        // must escape it so the exact-name file is still surfaced.
        mkdirSync(join(root, 'app'), { recursive: true });
        writeFileSync(join(root, 'app', '[slug].tsx'), 'x\n');
        writeFileSync(join(root, 'app', 'slug.tsx'), 'x\n'); // class-match decoy
        const out = await executeFuzzyFindTool({ query: '[slug].tsx' }, root);
        const lines = out.split('\n').filter(Boolean);
        assert.ok(lines.includes('app/[slug].tsx'), `literal metachar hit must surface: ${out}`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
