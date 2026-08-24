import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rootScanIgnoreGlobs } from './search-builders.mjs';

test('root-anchored kernel-tree prunes apply only to a posix filesystem-root scan', () => {
    assert.deepEqual(
        rootScanIgnoreGlobs('/', 'linux'),
        ['!proc/**', '!sys/**', '!dev/**'],
    );
    // Scans rooted elsewhere — including inside a kernel tree — are untouched.
    assert.deepEqual(rootScanIgnoreGlobs('/proc', 'linux'), []);
    assert.deepEqual(rootScanIgnoreGlobs('/home/user/project', 'linux'), []);
    assert.deepEqual(rootScanIgnoreGlobs('', 'linux'), []);
    // Windows has no kernel-virtual mounts; the helper is a no-op there.
    assert.deepEqual(rootScanIgnoreGlobs('/', 'win32'), []);
});
