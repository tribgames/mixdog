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

// Frozen copy of the pre-optimization scorer: this must not call production
// fuzzy helpers, so rank parity also detects scoring regressions.
function legacyFuzzyScore(query, str) {
    if (!query) return 0;
    const normalizedQuery = String(query).replace(/[\/\\_.\-\s]+/g, '');
    if (!normalizedQuery) return 0;
    const q = normalizedQuery.toLowerCase();
    const s = str.toLowerCase();
    const qlen = q.length;
    const slen = s.length;
    if (qlen === 0) return 0;
    if (qlen > slen) return null;

    const lastSep = Math.max(str.lastIndexOf('/'), str.lastIndexOf('\\'));
    let score = 0;
    let si = 0;
    let prevMatch = -2;
    let firstMatchIdx = -1;
    for (let qi = 0; qi < qlen; qi++) {
        const qc = q[qi];
        let found = -1;
        for (let k = si; k < slen; k++) {
            if (s[k] === qc) { found = k; break; }
        }
        if (found === -1) return null;
        if (firstMatchIdx === -1) firstMatchIdx = found;
        score += 1;
        if (found === prevMatch + 1) score += 5;
        const prevCh = found > 0 ? str[found - 1] : undefined;
        if (prevCh === undefined
            || prevCh === '/' || prevCh === '\\' || prevCh === '_' || prevCh === '-'
            || prevCh === '.' || prevCh === ' '
            || (/[a-z0-9]/.test(prevCh) && /[A-Z]/.test(str[found]))) {
            score += 8;
        }
        if (str[found] === normalizedQuery[qi]) score += 1;
        prevMatch = found;
        si = found + 1;
    }
    if (firstMatchIdx > lastSep) score += 10;
    score -= Math.floor(slen / 16);
    score -= Math.floor(firstMatchIdx / 8);
    return score;
}

function referenceFuzzyRank(query, items, limit = 0) {
    const normQuery = String(query || '').toLowerCase().replace(/[\/\\_.\-\s]+/g, '');
    const floor = normQuery.length * 4;
    const scored = [];
    for (const item of items) {
        const p = String(item.path || '');
        const pathScore = legacyFuzzyScore(query, p);
        const base = p.split(/[\\/]/).pop() || '';
        const baseScore = legacyFuzzyScore(query, base);
        const score = Math.max(pathScore ?? -Infinity, baseScore === null ? -Infinity : baseScore + 40);
        if (!Number.isFinite(score)) continue;
        const strong = normQuery.length > 0
            && (String(base || '').toLowerCase().replace(/[\/\\_.\-\s]+/g, '').includes(normQuery)
                || String(p || '').toLowerCase().replace(/[\/\\_.\-\s]+/g, '').includes(normQuery));
        if (!strong && score < floor) continue;
        scored.push({ item, score });
    }
    scored.sort((a, b) => (b.score - a.score)
        || (a.item.path < b.item.path ? -1 : a.item.path > b.item.path ? 1 : 0));
    return limit > 0 ? scored.slice(0, limit) : scored;
}

test('fuzzyRank exactly matches the frozen legacy full-sort reference ranker', () => {
    const fragments = ['alpha', 'Beta', 'tool-events', 'src', 'x_y', 'log', 'camelCase', 'archive'];
    const items = Array.from({ length: 1200 }, (_, i) => ({
        path: i % 97 === 0
            ? 'duplicate/tool-events.log'
            : `${fragments[i % fragments.length]}/${fragments[(i * 7) % fragments.length]}-${i}.mjs`,
    }));
    for (const query of ['', 'tool', 'ToolEvents', 'a_b', 'camel']) {
        for (const limit of [-5, 0, 0.5, 1, 2, 25, 300, 2000]) {
            const expected = referenceFuzzyRank(query, items, limit);
            const actual = fuzzyRank(query, items, limit);
            assert.deepEqual(
                actual.map(({ item, score }) => ({ index: items.findIndex((candidate) => candidate === item), score })),
                expected.map(({ item, score }) => ({ index: items.findIndex((candidate) => candidate === item), score })),
                `query=${JSON.stringify(query)}, limit=${limit}`,
            );
        }
    }
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

test('find respects .gitignore on the common path, then deterministically falls back for an exact ignored filename', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-find-gitignore-'));
    try {
        writeFileSync(join(root, '.gitignore'), 'ignored-tree/\n');
        mkdirSync(join(root, 'src'), { recursive: true });
        mkdirSync(join(root, 'ignored-tree'), { recursive: true });
        writeFileSync(join(root, 'src', 'common-visible.mjs'), 'x\n');
        writeFileSync(join(root, 'ignored-tree', 'common-ignored.mjs'), 'x\n');
        writeFileSync(join(root, 'src', 'needle-target.mjs.bak'), 'x\n');
        writeFileSync(join(root, 'ignored-tree', 'needle-target.mjs'), 'x\n');
        writeFileSync(join(root, 'ignored-tree', 'LICENSE'), 'x\n');
        writeFileSync(join(root, 'ignored-tree', '[slug].tsx'), 'x\n');
        writeFileSync(join(root, 'ignored-tree', 'my file.txt'), 'x\n');

        const common = await executeFuzzyFindTool({ query: 'common-visible.mjs', head_limit: 1 }, root);
        assert.ok(common.includes('src/common-visible.mjs'), `common path must keep visible files: ${common}`);
        assert.ok(!common.includes('ignored-tree/common-ignored.mjs'), `common path must skip .gitignored trees: ${common}`);
        assert.ok(common.includes('[gitignored trees not searched; retry with include_noise:true]'), `filled common path must disclose skipped trees: ${common}`);

        const exact = await executeFuzzyFindTool({ query: 'needle-target.mjs' }, root);
        assert.ok(exact.includes('src/needle-target.mjs.bak'), `visible fuzzy decoy must remain in pass one: ${exact}`);
        assert.ok(exact.includes('ignored-tree/needle-target.mjs'), `exact ignored filename must trigger fallback: ${exact}`);
        assert.ok(!exact.includes('[gitignored trees not searched'), `fallback result must not claim ignored trees were skipped: ${exact}`);

        const extensionless = await executeFuzzyFindTool({ query: 'LICENSE' }, root);
        assert.ok(extensionless.includes('ignored-tree/LICENSE'), `extensionless exact filename must trigger fallback: ${extensionless}`);
        const literalGlob = await executeFuzzyFindTool({ query: '[slug].tsx' }, root);
        assert.ok(literalGlob.includes('ignored-tree/[slug].tsx'), `literal-glob exact filename must trigger fallback: ${literalGlob}`);
        const spaced = await executeFuzzyFindTool({ query: 'my file.txt' }, root);
        assert.ok(spaced.includes('ignored-tree/my file.txt'), `space-containing exact filename must trigger fallback: ${spaced}`);
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
