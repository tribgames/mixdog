import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('headless session creation does not mention unregistered Skill or Goal tools', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-rule-capabilities-'));
    const previousDataDir = process.env.MIXDOG_DATA_DIR;
    process.env.MIXDOG_DATA_DIR = join(root, 'data');
    mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
    const { createSession } = await import('./session-lifecycle.mjs');
    const { deleteSession } = await import('../store.mjs');
    const { _withRegisteredProviderForTest } = await import('../../providers/registry.mjs');
    const { modelToolSchemaAllowlist } = await import('../../../../../session-runtime/tool-profile.mjs');
    let session;
    t.after(() => {
        if (session) assert.equal(deleteSession(session.id, { deferSummaryUpdate: true }), true);
        if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
        else process.env.MIXDOG_DATA_DIR = previousDataDir;
        rmSync(root, { recursive: true, force: true });
    });
    session = _withRegisteredProviderForTest('rule-capabilities-test', {
        name: 'rule-capabilities-test',
        contextWindow: 128000,
    }, () => createSession({
        provider: 'rule-capabilities-test',
        model: 'gpt-5.6-sol',
        cwd: root,
        skipSkills: true,
        schemaAllowedTools: modelToolSchemaAllowlist('headless'),
        workflow: { id: 'headless', delegatesAgents: false },
    }));
    const prompt = session.messages.filter(message => message.role === 'system')
        .map(message => message.content).join('\n');
    assert.match(prompt, /`read`/);
    assert.doesNotMatch(prompt, /\bSkills?\b|\bGoals?\b|`goal`|goal-management/);
    assert.equal(session.tools.some(tool => ['Skill', 'goal'].includes(tool.name)), false);
});
