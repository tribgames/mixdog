import assert from 'node:assert/strict';

import {
    SUMMARY_PREFIX,
    freshContextCompactMessages,
    generateFreshHandoffSummary,
} from '../src/runtime/agent/orchestrator/session/compact.mjs';
import { resolveWorkerCompactPolicy } from '../src/runtime/agent/orchestrator/session/loop/compact-policy.mjs';
import { normalizeCompactionConfig } from '../src/session-runtime/config-helpers.mjs';

const HANDOFF = [
    '## Goal',
    '- continue',
    '',
    '## Constraints & Preferences',
    '- preserve context',
    '',
    '## Progress',
    '### Done',
    '- old work',
    '### In Progress',
    '- verification',
    '### Blocked',
    '- (none)',
    '',
    '## Key Decisions',
    '- one Compact contract',
    '',
    '## Next Steps',
    '1. finish',
    '',
    '## Critical Context',
    '- full session',
    '',
    '## Relevant Files',
    '- src/example.mjs',
].join('\n');

const provider = {
    name: 'smoke-provider',
    async send() {
        return {
            content: HANDOFF,
            usage: { inputTokens: 20, outputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0 },
        };
    },
};

const generated = await generateFreshHandoffSummary(
    provider,
    [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'old request' },
        { role: 'assistant', content: 'old answer' },
        { role: 'user', content: 'latest request' },
    ],
    'fake-model',
    40_000,
    { force: true, fullHandoff: true },
);
assert.equal(generated.handoffGenerated, true);
assert.ok(generated.summary.includes('one Compact contract'));

const compacted = freshContextCompactMessages([
    { role: 'system', content: 'rules' },
    {
        role: 'user',
        content: 'Reference files:\n\n### C:\\Project\\refs\\guide.md\n```\nREFERENCE_BODY\n```',
    },
    { role: 'assistant', content: '.' },
    { role: 'user', content: 'old request' },
    { role: 'assistant', content: 'old answer', providerReplay: { items: [{ type: 'reasoning' }] } },
    { role: 'user', content: 'LATEST_REQUEST' },
    { role: 'user', content: '[mixdog-runtime] Empty response (1/2).' },
], 40_000, {
    force: true,
    handoffText: generated.summary,
});
assert.equal(compacted.freshContext, true);
assert.equal(compacted.messages.at(-1)?.content, 'LATEST_REQUEST');
assert.ok(compacted.messages.some((message) => (
    typeof message?.content === 'string' && message.content.startsWith(SUMMARY_PREFIX)
)));
const encoded = JSON.stringify(compacted.messages);
assert.ok(encoded.includes('C:\\\\Project\\\\refs\\\\guide.md'));
assert.equal(encoded.includes('REFERENCE_BODY'), false);
assert.equal(encoded.includes('providerReplay'), false);

const policyMain = resolveWorkerCompactPolicy({
    contextWindow: 100_000,
    compaction: {},
}, []);
const policyAgent = resolveWorkerCompactPolicy({
    owner: 'agent',
    contextWindow: 100_000,
    compaction: {},
}, []);
assert.equal(Object.hasOwn(policyMain, 'compactType'), false);
assert.equal(Object.hasOwn(policyAgent, 'compactType'), false);
assert.equal(Object.hasOwn(policyMain, 'semantic'), false);
assert.equal(Object.hasOwn(policyMain, 'recallFastTrack'), false);

const migrated = normalizeCompactionConfig({
    type: 'semantic',
    compactType: 'recall-fasttrack',
    semantic: 'auto',
    prune: true,
    tailTurns: 5,
    auto: true,
});
for (const key of ['type', 'compactType', 'semantic', 'prune', 'tailTurns']) {
    assert.equal(Object.hasOwn(migrated, key), false);
}

console.log('compact smoke: ok');
