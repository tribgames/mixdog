import assert from 'node:assert/strict';
import test from 'node:test';

import { applyShellEgressPolicy } from './env-scrub.mjs';

test('web-search disabled preserves ordinary shell network environment', () => {
    const previous = process.env.MIXDOG_FEATURE_WEB_SEARCH;
    process.env.MIXDOG_FEATURE_WEB_SEARCH = '0';
    try {
        const env = {
            HTTP_PROXY: 'http://proxy.example:8080',
            HTTPS_PROXY: 'http://proxy.example:8080',
            NO_PROXY: 'localhost',
        };
        assert.equal(applyShellEgressPolicy(env), env);
        assert.deepEqual(env, {
            HTTP_PROXY: 'http://proxy.example:8080',
            HTTPS_PROXY: 'http://proxy.example:8080',
            NO_PROXY: 'localhost',
        });
    } finally {
        if (previous === undefined) delete process.env.MIXDOG_FEATURE_WEB_SEARCH;
        else process.env.MIXDOG_FEATURE_WEB_SEARCH = previous;
    }
});
