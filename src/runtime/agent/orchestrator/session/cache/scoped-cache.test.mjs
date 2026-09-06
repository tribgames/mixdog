import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { invalidateBuiltinResultCache } from '../../tools/builtin/cache-layers.mjs';
import {
    clearScopedToolsForSession,
    clearScopedToolsForSessionPaths,
    scopedCacheGeneration,
    SCOPED_CACHE_TTL_MS,
    setScopedToolCached,
    tryScopedToolCached,
} from './scoped-cache.mjs';

const root = resolve('virtual-cache-audit');
const request = (sessionId, path = 'src') => ({
    sessionId, toolName: 'grep', cwd: root, args: { path, pattern: 'needle' },
});
test.afterEach(() => invalidateBuiltinResultCache());

test('builtin path invalidation reaches all matching sessions, preserving other roots', () => {
    const requests = [request('first'), request('second'), request('unrelated', 'other')];
    for (const spec of requests) setScopedToolCached({ ...spec, content: 'before' });
    invalidateBuiltinResultCache([resolve(root, 'src/a.ts')]);
    assert.equal(tryScopedToolCached(requests[0]), null);
    assert.equal(tryScopedToolCached(requests[1]), null);
    assert.equal(tryScopedToolCached(requests[2]).content, 'before');
    invalidateBuiltinResultCache();
    assert.equal(tryScopedToolCached(requests[2]), null);
});

test('unobserved external changes have a bounded reuse window', () => {
    const clock = Date.now;
    let now = clock();
    Date.now = () => now;
    try {
        const spec = request('expiry');
        setScopedToolCached({ ...spec, content: 'before' });
        now += SCOPED_CACHE_TTL_MS - 1;
        assert.equal(tryScopedToolCached(spec).content, 'before');
        now += 1;
        assert.equal(tryScopedToolCached(spec), null);
    } finally { Date.now = clock; }
});

test('Windows aliases invalidate the same scope', { skip: process.platform !== 'win32' }, () => {
    const spec = request('case', 'Src');
    setScopedToolCached({ ...spec, content: 'before' });
    clearScopedToolsForSessionPaths(spec.sessionId, [resolve(root, 'SRC/a.ts').toUpperCase()]);
    assert.equal(tryScopedToolCached(spec), null);
});

test('case-sensitive platforms keep distinct paths distinct', { skip: process.platform === 'win32' }, () => {
    const spec = request('case', 'Src');
    setScopedToolCached({ ...spec, content: 'before' });
    clearScopedToolsForSessionPaths(spec.sessionId, [resolve(root, 'src/a.ts')]);
    assert.equal(tryScopedToolCached(spec).content, 'before');
});

test('removing an ancestor invalidates nested dependency roots', () => {
    const spec = request('parent', 'src/nested');
    setScopedToolCached({ ...spec, content: 'before' });
    clearScopedToolsForSessionPaths(spec.sessionId, ['src'], root);
    assert.equal(tryScopedToolCached(spec), null);
});

test('a pending result cannot repopulate after an invalidation or session close', () => {
    for (const invalidate of [
        () => invalidateBuiltinResultCache([resolve(root, 'src/a.ts')]),
        () => clearScopedToolsForSession('pending'),
    ]) {
        const generation = scopedCacheGeneration();
        invalidate();
        const spec = request('pending');
        setScopedToolCached({ ...spec, generation, content: 'obsolete' });
        assert.equal(tryScopedToolCached(spec), null);
        setScopedToolCached({ ...spec, generation: scopedCacheGeneration(), content: 'current' });
        assert.equal(tryScopedToolCached(spec).content, 'current');
    }
});
