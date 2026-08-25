import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    _sessionForDisk,
    _storedSessionFromFile,
} from './serialize.mjs';

test('provider prefix guard remains runtime-local across media-safe persistence', () => {
    const guard = {
        messageHashes: ['live-image-hash'],
        requestPrefixHash: 'live-tools-hash',
    };
    const session = {
        id: 'sess_prefix_guard',
        messages: [{
            role: 'tool',
            content: [{
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,AAAA' },
            }],
        }],
        _providerPrefixGuardState: guard,
    };

    const stored = _sessionForDisk(session);

    assert.equal(Object.hasOwn(stored, '_providerPrefixGuardState'), false);
    assert.equal(session._providerPrefixGuardState, guard);
    assert.match(JSON.stringify(stored.messages), /Image omitted from stored history: image\/png/);
});

test('legacy stored provider prefix guards are discarded on load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mixdog-prefix-guard-store-'));
    const id = 'sess_legacy_prefix_guard';
    try {
        await writeFile(join(dir, `${id}.json`), JSON.stringify({
            id,
            generation: 0,
            closed: false,
            messages: [{ role: 'user', content: 'kept' }],
            tools: [],
            _providerPrefixGuardState: {
                messageHashes: ['stale'],
                requestPrefixHash: 'stale',
            },
        }), 'utf8');

        const loaded = _storedSessionFromFile(dir, `${id}.json`);

        assert.ok(loaded);
        assert.equal(Object.hasOwn(loaded, '_providerPrefixGuardState'), false);
        assert.equal(loaded.messages[0].content, 'kept');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
