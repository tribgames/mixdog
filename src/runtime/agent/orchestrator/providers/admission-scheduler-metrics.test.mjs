import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    ProviderAdmissionScheduler,
    wrapProviderAdmission,
} from './admission-scheduler.mjs';

test('provider admission reports active concurrency at dispatch', async () => {
    const scheduler = new ProviderAdmissionScheduler({ concurrency: 2 });
    const seen = [];
    let releaseFirst;

    const first = scheduler.run('openai:test', async (_signal, metrics) => {
        seen.push(metrics);
        await new Promise((resolve) => { releaseFirst = resolve; });
        return 'first';
    });
    const second = scheduler.run('openai:test', async (_signal, metrics) => {
        seen.push(metrics);
        return 'second';
    });

    assert.equal(await second, 'second');
    releaseFirst();
    assert.equal(await first, 'first');
    assert.deepEqual(seen.map((metrics) => metrics.active), [1, 2]);
    assert.ok(seen.every((metrics) => metrics.queueWaitMs >= 0));
});

test('provider wrapper passes admission metrics to the provider send options', async () => {
    const scheduler = new ProviderAdmissionScheduler({ concurrency: 2 });
    const provider = {
        name: 'openai-oauth',
        send(_messages, _model, _tools, opts) {
            return opts._providerAdmission;
        },
    };
    wrapProviderAdmission(provider, provider.name, scheduler);

    const metrics = await provider.send([], 'gpt-test', [], {
        sessionId: 'foreground-test',
    });
    assert.equal(metrics.active, 1);
    assert.equal(metrics.queued, 0);
    assert.ok(metrics.queueWaitMs >= 0);
});
