import assert from 'node:assert/strict';
import {
    mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createRulesSourceCache } from './rules-source-cache.mjs';

async function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-rules-cache-'));
    const previous = {
        MIXDOG_ROOT: process.env.MIXDOG_ROOT,
        MIXDOG_DATA_DIR: process.env.MIXDOG_DATA_DIR,
    };
    process.env.MIXDOG_ROOT = join(root, 'plugin');
    process.env.MIXDOG_DATA_DIR = join(root, 'data');
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(root, { recursive: true, force: true });
    });
    const write = (relative, content, stamp = '2030-01-01') => {
        const path = join(root, relative);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        utimesSync(path, new Date(stamp), new Date(stamp));
        return path;
    };
    // Load after selecting the isolated roots. The normal source fallback
    // still loads the production rules builder, not a test replacement.
    const rules = await import('./rules-cache.mjs');
    return { root, write, rules };
}

test('legacy instruction files never enter the memory-only prompt path', async (t) => {
    const { write, rules } = await fixture(t);
    write('data/user-workflow.md', 'LEGACY_FALLBACK');
    const current = write('data/instructions.md', 'DELETED_INSTRUCTION', '2031-01-01');

    assert.doesNotMatch(rules._buildLeadMetaContext(), /DELETED_INSTRUCTION|LEGACY_FALLBACK/);
    unlinkSync(current);
    const after = rules._buildLeadMetaContext();
    assert.doesNotMatch(after, /DELETED_INSTRUCTION/);
    assert.doesNotMatch(after, /LEGACY_FALLBACK/);
});

test('every rules layer detects edits hidden by newer sources and timestamp rollback', async (t) => {
    const { write, rules } = await fixture(t);
    write('plugin/rules/shared/00-anchor.md', 'shared anchor', '2032-01-01');
    write('plugin/rules/shared/01-policy.md', 'SHARED_BEFORE');
    write('plugin/rules/agent/00-core.md', 'agent anchor', '2032-01-01');
    write('plugin/rules/agent/00-common.md', 'AGENT_BEFORE');
    write('plugin/rules/lead/01-general.md', 'lead anchor', '2032-01-01');
    write('plugin/rules/lead/02-persona.md', 'LEAD_BEFORE');
    const config = (title, language) => JSON.stringify({ agent: { profile: { title, language } } });
    write('data/mixdog-config.json', config('PROFILE_BEFORE', 'ko'), '2031-01-01');
    assert.match(rules._buildSharedRules(), /SHARED_BEFORE/);
    assert.match(rules._buildAgentRules(), /AGENT_BEFORE/);
    assert.match(rules._buildLeadRules(), /LEAD_BEFORE/);
    assert.match(rules._buildLeadMetaContext(), /PROFILE_BEFORE/);
    assert.match(rules._buildLeadLanguageContext(), /Korean/);

    write('plugin/rules/shared/01-policy.md', 'SHARED_AFTER', '2029-01-01');
    write('plugin/rules/agent/00-common.md', 'AGENT_AFTER', '2029-01-01');
    write('plugin/rules/lead/02-persona.md', 'LEAD_AFTER', '2029-01-01');
    write('data/mixdog-config.json', config('PROFILE_AFTER', 'ja'), '2029-01-01');
    for (const [build, expected, stale] of [
        [rules._buildSharedRules, /SHARED_AFTER/, /SHARED_BEFORE/],
        [rules._buildAgentRules, /AGENT_AFTER/, /AGENT_BEFORE/],
        [rules._buildLeadRules, /LEAD_AFTER/, /LEAD_BEFORE/],
        [rules._buildLeadMetaContext, /PROFILE_AFTER/, /PROFILE_BEFORE/],
        [rules._buildLeadLanguageContext, /Japanese/, /Korean/],
    ]) {
        const value = build();
        assert.match(value, expected);
        assert.doesNotMatch(value, stale);
    }
});

test('unchanged source variants stay warm and failed builds remain retryable', async (t) => {
    const { write } = await fixture(t);
    const source = write('data/instructions.md', 'stable policy');
    const cache = createRulesSourceCache();
    const builds = new Map();
    const get = (variant, fail = false) => cache([source], variant, () => {
        builds.set(variant, (builds.get(variant) || 0) + 1);
        if (fail) throw new Error('transient build error');
        return `${variant}: ${readFileSync(source, 'utf8')}`;
    });
    assert.equal(get('full'), 'full: stable policy');
    assert.equal(get('small'), 'small: stable policy');
    assert.equal(get('full'), 'full: stable policy');
    assert.equal(get('small'), 'small: stable policy');
    assert.equal(builds.get('full'), 1);
    assert.equal(builds.get('small'), 1);
    assert.throws(() => get('retry', true), /transient build error/);
    assert.equal(get('retry'), 'retry: stable policy');
    assert.equal(builds.get('retry'), 2);
});
