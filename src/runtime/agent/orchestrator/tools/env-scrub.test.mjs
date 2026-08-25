import assert from 'node:assert/strict';
import test from 'node:test';

import { applyShellEgressPolicy, scrubRuntimeRootVars } from './env-scrub.mjs';

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

test('spawned children never inherit the Electron execution-mode switch', () => {
    // ELECTRON_RUN_AS_NODE=1 turns any Electron app the child launches into a
    // bare node interpreter, which swallows a leading `--` as its
    // end-of-options marker and rejects the app's own CLI flags.
    const env = {
        ELECTRON_RUN_AS_NODE: '1',
        PATH: '/usr/bin',
        MIXDOG_DATA_DIR: '/home/u/.mixdog/data',
    };
    scrubRuntimeRootVars(env);
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    // The child still needs to locate its tools and user data.
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.MIXDOG_DATA_DIR, '/home/u/.mixdog/data');
});

test('runtime-root scrub clears host identity and leaves user environment intact', () => {
    const env = {
        MIXDOG_ROOT: '/app/resources/runtime.asar',
        NODE_ENV: 'production',
        MIXDOG_DAEMON_HOST: '1',
        MIXDOG_WORKER_MODE: '1',
        MIXDOG_DAEMON_SPAWNED_FOR: 'session',
        MIXDOG_SUPERVISOR_PID: '4242',
        MIXDOG_SERVER_PID: '74976',
        ELECTRON_RUN_AS_NODE: '1',
        HOME: '/home/u',
    };
    assert.equal(scrubRuntimeRootVars(env), env);
    assert.deepEqual(env, { HOME: '/home/u' });
});
