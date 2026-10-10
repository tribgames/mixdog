import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Each scenario runs in its own process against a private data dir.
function isolated(prefix, source) {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MIXDOG_DATA_DIR: dataDir,
        MIXDOG_CONFIG_READ_TTL_MS: '0',
        MIXDOG_USER_DATA_BACKUP_ROOT: join(dataDir, 'user-data-backups'),
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const PRELUDE = `
  import assert from 'node:assert/strict';
  import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
  import { join } from 'node:path';
  import {
    createConfigPatch, loadConfig, saveConfig, saveConfigPatch,
  } from './src/runtime/agent/orchestrator/config.mjs';
  import { withAgentDisabled } from './src/runtime/shared/agent-route-config.mjs';
  import { DEFAULTS_VERSION, backupConfigBeforeDefaultsSeparation } from './src/runtime/shared/defaults-separation.mjs';
  const dataDir = process.env.MIXDOG_DATA_DIR;
  const path = join(dataDir, 'mixdog-config.json');
  const read = () => JSON.parse(readFileSync(path, 'utf8'));
  const write = (value) => writeFileSync(path, JSON.stringify(value));
  const backups = () => existsSync(join(dataDir, 'backups'))
    ? readdirSync(join(dataDir, 'backups')).filter((name) => name.startsWith('defaults-separation-'))
    : [];
`;

test('separation removes old defaults, keeps hand-edited and foreign sections, backs up once, and is idempotent', () => {
  isolated(
    'mixdog-separation-old-',
    `${PRELUDE}
    const original = {
      outputStyle: 'simple',
      channels: {
        access: { dmPolicy: 'allowlist', allowFrom: [], channels: {} },
        webhook: { enabled: true, port: 3333 },
      },
      desktop: { keepAwake: true, usagePinned: true },
      voice: { language: 'ko', model: 'standard', enabled: true },
      gateway: { mode: 'x' },
      memory: { embedding: { provider: 'local' } },
      agent: {
        orchestrationMode: 'none',
        autoClear: { enabled: true, minContextPercent: 10 },
        compaction: { auto: true },
        update: { auto: true },
        recap: { enabled: true },
        memoryTools: { enabled: true },
        modules: { webSearch: { enabled: true }, git: { enabled: true } },
        // Roster shipped before advisor existed.
        disabledAgents: ['front-worker', 'heavy-worker', 'maintainer', 'reviewer', 'security', 'worker', 'writer'],
        maintenance: { webhook: { provider: 'anthropic-oauth', model: 'claude-haiku-4-5-20251001' } },
        onboarding: { completed: true, version: 1 },
        builtins: { git: { installed: true } },
        profile: { title: 'T', language: 'ko', experienceLevel: '' },
      },
    };
    write(original);
    const loaded = loadConfig({ secrets: false });
    const after = read();
    assert.equal(after.defaultsVersion, DEFAULTS_VERSION);
    assert.equal(Object.hasOwn(after, 'outputStyle'), false);
    assert.equal(Object.hasOwn(after, 'channels'), false);
    for (const key of ['orchestrationMode', 'autoClear', 'compaction', 'update', 'recap', 'memoryTools', 'modules', 'disabledAgents', 'enabledAgents']) {
      assert.equal(Object.hasOwn(after.agent, key), false, key);
    }
    // The shipped maintenance route is a default too.
    assert.equal(Object.hasOwn(after.agent, 'maintenance'), false);
    assert.deepEqual(loaded.maintenance.webhook, original.agent.maintenance.webhook);
    // Untouched: desktop, hand-edited keys, onboarding, install flags, profile.
    assert.deepEqual(after.desktop, original.desktop);
    assert.deepEqual(after.voice, original.voice);
    assert.deepEqual(after.gateway, original.gateway);
    assert.deepEqual(after.memory, original.memory);
    for (const key of ['onboarding', 'builtins', 'profile']) {
      assert.deepEqual(after.agent[key], original.agent[key], key);
    }
    // The newly default-off advisor starts off; the user's choices are unchanged.
    assert.ok(loaded.disabledAgents.includes('advisor'));
    assert.equal(loaded.orchestrationMode, 'balanced');
    assert.equal(loaded.autoClear.enabled, true);

    // Backup is the pre-change file.
    const dirs = backups();
    assert.equal(dirs.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'backups', dirs[0], 'mixdog-config.json'), 'utf8')), original);

    // Second run changes nothing and takes no further backup.
    const text = readFileSync(path, 'utf8');
    loadConfig({ secrets: false });
    assert.equal(readFileSync(path, 'utf8'), text);
    assert.equal(backups().length, 1);
    `
  );
});

test('separation keeps user-changed values and preserves effective agent choices', () => {
  isolated(
    'mixdog-separation-user-',
    `${PRELUDE}
    write({
      outputStyle: 'verbose',
      channels: { webhook: { enabled: true, port: 4000 } },
      agent: {
        orchestrationMode: 'focused',
        autoClear: { enabled: false, minContextPercent: 25 },
        compaction: { auto: false },
        update: { auto: false },
        recap: { enabled: false },
        memoryTools: { enabled: false },
        modules: { webSearch: { enabled: false }, git: { enabled: true } },
        // Writer was turned on; 'custom' was turned off.
        disabledAgents: ['custom', 'front-worker', 'heavy-worker', 'maintainer', 'reviewer', 'security', 'worker'],
      },
    });
    const loaded = loadConfig({ secrets: false });
    const after = read();
    assert.equal(after.outputStyle, 'verbose');
    assert.deepEqual(after.channels, { webhook: { port: 4000 } });
    assert.equal(after.agent.orchestrationMode, 'focused');
    assert.deepEqual(after.agent.autoClear, { enabled: false, minContextPercent: 25 });
    assert.deepEqual(after.agent.compaction, { auto: false });
    assert.deepEqual(after.agent.update, { auto: false });
    assert.deepEqual(after.agent.recap, { enabled: false });
    assert.deepEqual(after.agent.memoryTools, { enabled: false });
    assert.deepEqual(after.agent.modules, { webSearch: { enabled: false } });
    assert.deepEqual(after.agent.disabledAgents, ['custom']);
    assert.deepEqual(after.agent.enabledAgents, ['writer']);
    assert.ok(loaded.disabledAgents.includes('custom'));
    assert.ok(loaded.disabledAgents.includes('advisor'));
    assert.equal(loaded.disabledAgents.includes('writer'), false);
    assert.equal(backups().length, 1);
    `
  );
});

test('separation turns an old explicit workflow into an explicit mode, drops the Solo default, and reads a missing roster as all on', () => {
  isolated(
    'mixdog-separation-legacy-',
    `${PRELUDE}
    write({ agent: { workflow: { active: 'custom-workflow' } } });
    let loaded = loadConfig({ secrets: false });
    assert.equal(read().agent.orchestrationMode, 'swarm');
    assert.equal(loaded.orchestrationMode, 'swarm');
    // Every agent the old roster had on stays on; only advisor is newly off.
    assert.deepEqual(loaded.disabledAgents, ['advisor']);

    rmSync_(path);
    write({ agent: { workflow: { active: 'solo' } } });
    loaded = loadConfig({ secrets: false });
    assert.equal(Object.hasOwn(read().agent, 'orchestrationMode'), false);
    assert.equal(loaded.orchestrationMode, 'balanced');

    function rmSync_(file) { writeFileSync(file, '{}'); }
    `
  );
});

test('version 2 on an already separated file: shipped presets, maintenance and workflow defaults and legacy keys go; the stored delta is not reinterpreted', () => {
  isolated(
    'mixdog-separation-v2-',
    `${PRELUDE}
    import { mkdirSync } from 'node:fs';
    import { DEFAULT_PRESETS, DEFAULT_MAINTENANCE } from './src/runtime/agent/orchestrator/config.mjs';
    mkdirSync(join(dataDir, 'agents', 'explore'), { recursive: true });
    writeFileSync(join(dataDir, 'agents', 'explore', 'AGENT.md'), '---\\nname: explore\\n---\\nMine.');
    const custom = { id: 'mine', name: 'MINE', type: 'agent', provider: 'openai', model: 'gpt-x', tools: 'full' };
    const changedOpus = { ...DEFAULT_PRESETS[4], effort: 'xhigh' };
    write({
      defaultsVersion: 1,
      channels: { access: { channels: { c1: { requireMention: false, allowFrom: ['u'] } } } },
      agent: {
        presets: [...DEFAULT_PRESETS.slice(0, 4), changedOpus, custom],
        maintenance: { ...DEFAULT_MAINTENANCE },
        workflow: { active: 'default' },
        disabledAgents: ['custom-agent'],
        builtins: { browser: { installed: false, firstUseApproval: false } },
        agents: {
          debugger: { provider: 'openai', model: 'gpt-x' },
          explore: { provider: 'openai', model: 'gpt-x' },
          worker: { provider: 'openai', model: 'gpt-x' },
        },
      },
    });
    const loaded = loadConfig({ secrets: false });
    const after = read();
    assert.equal(after.defaultsVersion, DEFAULTS_VERSION);
    assert.deepEqual(after.agent.presets, [changedOpus, custom]);
    for (const key of ['maintenance', 'workflow']) assert.equal(Object.hasOwn(after.agent, key), false, key);
    assert.deepEqual(after.agent.builtins, { browser: { installed: false } });
    assert.deepEqual(after.channels, { access: { channels: { c1: { allowFrom: ['u'] } } } });
    // A retired built-in's route goes unless the user defines that agent.
    assert.deepEqual(Object.keys(after.agent.agents).sort(), ['explore', 'worker']);
    // The v1 delta stays a delta: defaults stay off, the user's extra stays off.
    assert.deepEqual(after.agent.disabledAgents, ['custom-agent']);
    assert.ok(loaded.disabledAgents.includes('worker') && loaded.disabledAgents.includes('custom-agent'));
    // Effective presets: stored entries in stored order, then the missing shipped ones.
    assert.deepEqual(loaded.presets.map((p) => p.id), ['opus-high', 'mine', 'haiku', 'sonnet-mid', 'sonnet-high', 'opus-mid']);
    assert.equal(loaded.presets[0].effort, 'xhigh');
    assert.deepEqual(loaded.maintenance.webhook, DEFAULT_MAINTENANCE.webhook);
    assert.equal(loaded.workflow.active, 'default');
    assert.equal(backups().length, 1);

    // Saving the loaded config writes the same delta back.
    saveConfig(loaded);
    assert.deepEqual(read().agent.presets, [changedOpus, custom]);
    assert.equal(Object.hasOwn(read().agent, 'maintenance'), false);
    assert.equal(Object.hasOwn(read().agent, 'workflow'), false);
    `
  );
});

test('a numeric default is resolved against the stored order and persisted as the preset id', () => {
  isolated(
    'mixdog-separation-numeric-default-',
    `${PRELUDE}
    import { DEFAULT_PRESETS } from './src/runtime/agent/orchestrator/config.mjs';
    const custom = { id: 'mine', name: 'MINE', type: 'agent', provider: 'openai', model: 'gpt-x', tools: 'full' };
    // Effective list is stored order first: mine, haiku, sonnet-mid, ...
    write({ agent: { presets: [custom, DEFAULT_PRESETS[0]], default: 1 } });
    const loaded = loadConfig({ secrets: false });
    assert.equal(read().agent.default, 'haiku');
    assert.deepEqual(read().agent.presets, [custom]);
    assert.equal(loaded.default, 'haiku');
    assert.deepEqual(loaded.presets.map((p) => p.id).slice(0, 3), ['mine', 'haiku', 'sonnet-mid']);
    `
  );
});

test('a failed separation keeps reading and writing the legacy form', () => {
  isolated(
    'mixdog-separation-failed-',
    `${PRELUDE}
    import { mkdirSync } from 'node:fs';
    // A file where the backup folder belongs makes the pass fail before it writes.
    writeFileSync(join(dataDir, 'backups'), 'blocked');
    write({ agent: { disabledAgents: ['custom', 'worker'], workflow: { active: 'default' } } });
    let loaded = loadConfig({ secrets: false });
    assert.equal(Object.hasOwn(read(), 'defaultsVersion'), false);
    // The legacy list is the whole roster: no default-off agent is added.
    assert.deepEqual(loaded.disabledAgents, ['custom', 'worker']);
    saveConfigPatch(createConfigPatch(loaded, withAgentDisabled(loaded, 'custom', false)));
    assert.deepEqual(read().agent.disabledAgents, ['worker']);
    assert.equal(Object.hasOwn(read().agent, 'enabledAgents'), false);
    loaded = loadConfig({ secrets: false });
    assert.deepEqual(loaded.disabledAgents, ['worker']);
    saveConfig(loaded);
    assert.deepEqual(read().agent.disabledAgents, ['worker']);
    assert.equal(Object.hasOwn(read().agent, 'enabledAgents'), false);
    assert.equal(Object.hasOwn(read(), 'defaultsVersion'), false);
    `
  );
});

test('with separation failing, patch saves round-trip agent toggles in the legacy list', () => {
  isolated(
    'mixdog-separation-failed-patch-',
    `${PRELUDE}
    import { saveConfigPatchAsync } from './src/runtime/agent/orchestrator/config.mjs';
    writeFileSync(join(dataDir, 'backups'), 'blocked');
    write({ agent: { disabledAgents: ['worker', 'reviewer'] } });
    let loaded = loadConfig({ secrets: false });
    assert.equal(Object.hasOwn(read(), 'defaultsVersion'), false);
    const toggle = async (id, disabled, async) => {
      const before = loadConfig({ secrets: false });
      const patch = createConfigPatch(before, withAgentDisabled(before, id, disabled));
      if (async) await saveConfigPatchAsync(patch); else saveConfigPatch(patch);
      return loadConfig({ secrets: false }).disabledAgents ?? [];
    };
    assert.deepEqual(await toggle('worker', false, false), ['reviewer']);
    assert.deepEqual(read().agent.disabledAgents, ['reviewer']);
    assert.deepEqual(await toggle('advisor', true, true), ['advisor', 'reviewer']);
    assert.deepEqual(await toggle('custom', true, false), ['advisor', 'custom', 'reviewer']);
    assert.deepEqual(await toggle('reviewer', false, true), ['advisor', 'custom']);
    assert.deepEqual(await toggle('custom', false, true), ['advisor']);
    assert.deepEqual(await toggle('advisor', false, false), []);
    assert.equal(Object.hasOwn(read().agent, 'disabledAgents'), false);
    assert.equal(Object.hasOwn(read().agent, 'enabledAgents'), false);
    assert.equal(Object.hasOwn(read(), 'defaultsVersion'), false);
    `
  );
});

test('a retired agent keeps its route when the user defines it through agent.json entry', () => {
  isolated(
    'mixdog-separation-entry-',
    `${PRELUDE}
    import { mkdirSync } from 'node:fs';
    mkdirSync(join(dataDir, 'agents', 'debugger'), { recursive: true });
    writeFileSync(join(dataDir, 'agents', 'debugger', 'agent.json'), JSON.stringify({ entry: 'main.md' }));
    writeFileSync(join(dataDir, 'agents', 'debugger', 'main.md'), 'My debugger.');
    // An empty AGENT.md next to it does not define an agent.
    mkdirSync(join(dataDir, 'agents', 'explore'), { recursive: true });
    writeFileSync(join(dataDir, 'agents', 'explore', 'AGENT.md'), '');
    const route = { provider: 'openai', model: 'gpt-x' };
    write({ defaultsVersion: 1, agent: { agents: { debugger: route, explore: route, worker: route } } });
    loadConfig({ secrets: false });
    assert.deepEqual(Object.keys(read().agent.agents).sort(), ['debugger', 'worker']);
    `
  );
});

test('the canonicalize path stores no defaults', () => {
  isolated(
    'mixdog-canonicalize-defaults-',
    `${PRELUDE}
    write({
      defaultsVersion: DEFAULTS_VERSION,
      agent: { compaction: { enabled: true }, modules: { webSearch: true, git: { enabled: false } }, profile: { title: 'T' } },
    });
    loadConfig({ secrets: false });
    const agent = read().agent;
    assert.equal(Object.hasOwn(agent, 'compaction'), false);
    assert.deepEqual(agent.modules, { git: { enabled: false } });
    write({ defaultsVersion: DEFAULTS_VERSION, agent: { modules: { webSearch: { enabled: true } }, shell: { path: 'sh' } } });
    loadConfig({ secrets: false });
    assert.equal(Object.hasOwn(read().agent, 'modules'), false);
    assert.deepEqual(read().agent.shell, { command: 'sh' });
    `
  );
});

test('a backup never overwrites an earlier one', () => {
  isolated(
    'mixdog-separation-backup-',
    `${PRELUDE}
    write({ agent: { profile: { title: 'one' } } });
    const now = new Date('2024-01-02T03:04:05.678Z');
    const first = backupConfigBeforeDefaultsSeparation({ now });
    write({ agent: { profile: { title: 'two' } } });
    const second = backupConfigBeforeDefaultsSeparation({ now });
    assert.notEqual(first, second);
    assert.equal(JSON.parse(readFileSync(first, 'utf8')).agent.profile.title, 'one');
    assert.equal(JSON.parse(readFileSync(second, 'utf8')).agent.profile.title, 'two');
    `
  );
});

test('a file born from this code is stamped and needs no separation or backup', () => {
  isolated(
    'mixdog-separation-fresh-',
    `${PRELUDE}
    saveConfig({ profile: { title: 'New' } });
    assert.equal(read().defaultsVersion, DEFAULTS_VERSION);
    loadConfig({ secrets: false });
    assert.equal(backups().length, 0);
    assert.equal(backupConfigBeforeDefaultsSeparation().includes('defaults-separation-'), true);
    `
  );
});

test('disabled agents are stored as a delta; a first save writes no roster; default-equal values are not written', () => {
  isolated(
    'mixdog-delta-',
    `${PRELUDE}
    const fresh = loadConfig({ secrets: false });
    assert.ok(fresh.disabledAgents.includes('advisor') && fresh.disabledAgents.includes('maintainer'));
    // Unrelated first save: neither roster key is written.
    saveConfigPatch(createConfigPatch(fresh, { ...fresh, profile: { ...fresh.profile, title: 'A' } }));
    assert.equal(Object.hasOwn(read().agent, 'disabledAgents'), false);
    assert.equal(Object.hasOwn(read().agent, 'enabledAgents'), false);

    let current = loadConfig({ secrets: false });
    let next = withAgentDisabled(withAgentDisabled(current, 'custom', true), 'worker', false);
    saveConfigPatch(createConfigPatch(current, next));
    assert.deepEqual(read().agent.disabledAgents, ['custom']);
    assert.deepEqual(read().agent.enabledAgents, ['worker']);
    current = loadConfig({ secrets: false });
    assert.ok(current.disabledAgents.includes('custom'));
    assert.equal(current.disabledAgents.includes('worker'), false);
    assert.ok(current.disabledAgents.includes('advisor'));

    // Back to the defaults removes the keys again.
    next = withAgentDisabled(withAgentDisabled(current, 'custom', false), 'worker', true);
    saveConfigPatch(createConfigPatch(current, next));
    assert.equal(Object.hasOwn(read().agent, 'disabledAgents'), false);
    assert.equal(Object.hasOwn(read().agent, 'enabledAgents'), false);

    // Default-equal toggles are omitted; a non-default value is written and removed again.
    current = loadConfig({ secrets: false });
    const toggled = {
      ...current,
      orchestrationMode: 'swarm',
      autoClear: { enabled: false, minContextPercent: 30 },
      compaction: { auto: false },
      update: { auto: false },
      recap: { enabled: false },
      modules: { git: { enabled: false } },
    };
    saveConfigPatch(createConfigPatch(current, toggled));
    let agent = read().agent;
    assert.equal(agent.orchestrationMode, 'swarm');
    assert.deepEqual(agent.autoClear, { enabled: false, minContextPercent: 30 });
    assert.deepEqual(agent.modules, { git: { enabled: false } });
    const restored = {
      ...toggled,
      orchestrationMode: 'balanced',
      autoClear: { enabled: true, minContextPercent: 10 },
      compaction: { auto: true },
      update: { auto: true },
      recap: { enabled: true },
      modules: { git: { enabled: true } },
    };
    saveConfigPatch(createConfigPatch(toggled, restored));
    agent = read().agent;
    for (const key of ['orchestrationMode', 'autoClear', 'compaction', 'update', 'recap', 'modules']) {
      assert.equal(Object.hasOwn(agent, key), false, key);
    }
    // A whole-section save of defaults writes none of them either.
    saveConfig(restored);
    agent = read().agent;
    for (const key of ['orchestrationMode', 'autoClear', 'compaction', 'update', 'recap', 'modules', 'disabledAgents', 'enabledAgents']) {
      assert.equal(Object.hasOwn(agent, key), false, key);
    }
    `
  );
});

test('memoryTools.enabled=false persists and survives a reload; enabling removes the key', () => {
  isolated(
    'mixdog-memory-tools-',
    `${PRELUDE}
    import { setMemoryToolsEnabledInConfig, memoryToolsEnabled } from './src/runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
    const fresh = loadConfig({ secrets: false });
    const off = setMemoryToolsEnabledInConfig(fresh, false);
    saveConfigPatch(createConfigPatch(fresh, off));
    assert.deepEqual(read().agent.memoryTools, { enabled: false });
    const reloaded = loadConfig({ secrets: false });
    assert.equal(memoryToolsEnabled(reloaded), false);
    saveConfigPatch(createConfigPatch(reloaded, setMemoryToolsEnabledInConfig(reloaded, true)));
    assert.equal(Object.hasOwn(read().agent, 'memoryTools'), false);
    assert.equal(memoryToolsEnabled(loadConfig({ secrets: false })), true);
    `
  );
});

test('channel and output-style writes omit values equal to the default', () => {
  isolated(
    'mixdog-channels-style-',
    `${PRELUDE}
    import { setWebhookConfig, setWebhookConfigAsync } from './src/session-runtime/services/channel-admin.mjs';
    import { configWithOutputStyle } from './src/session-runtime/config-lifecycle/config-writers.mjs';
    const effective = setWebhookConfig({ port: 4000 });
    assert.equal(effective.webhook.enabled, true);
    assert.deepEqual(read().channels, { webhook: { port: 4000 } });
    await setWebhookConfigAsync({ enabled: false });
    assert.deepEqual(read().channels, { webhook: { enabled: false, port: 4000 } });
    await setWebhookConfigAsync({ enabled: true, port: 3333 });
    assert.deepEqual(read().channels, {});

    assert.equal(configWithOutputStyle({ outputStyle: 'verbose' }, 'simple').outputStyle, undefined);
    assert.equal(configWithOutputStyle({}, 'verbose').outputStyle, 'verbose');
    `
  );
});
