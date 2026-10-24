// The Reactions setting (Settings → General → Features), wired like the
// heartbeat switch: on by default, only the opt-out is stored, the setup tool
// and the session surface reach it, and while it is off a bot's react call is
// refused and new chats are not offered the tool.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSessionApi } from '../tui/session/session-api.mjs';
import { createInternalToolExecutor } from './internal-tool-executor.mjs';
import { createSettingsApi } from './settings-api.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the reactions setting end to end over the real config file: setup, stored key, status and settings read', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-reaction-setting-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import assert from 'node:assert/strict';
        import { existsSync, readFileSync } from 'node:fs';
        import { join } from 'node:path';
        import { loadConfig, saveConfig } from './src/runtime/agent/orchestrator/config.mjs';
        import { featureDisallowedToolsFor } from './src/runtime/agent/orchestrator/runtime-core/builtin-features.mjs';
        import { createSettingsApi } from './src/session-runtime/settings-api.mjs';
        import { createSetupToolExecutor } from './src/session-runtime/setup-tool/executor.mjs';

        const configPath = join(process.env.MIXDOG_DATA_DIR, 'mixdog-config.json');
        const stored = () => (existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')).agent ?? {} : {});
        const api = createSettingsApi({
          getConfig: () => loadConfig({ secrets: false }),
          saveConfigAndAdopt: (next) => saveConfig(next),
        });
        const setup = async (args, facade = api) =>
          JSON.parse(
            await createSetupToolExecutor({ getApi: () => facade, getConfig: () => loadConfig({ secrets: false }) }).execute(args, {})
          );
        const features = async () => (await setup({ action: 'status', domain: 'features' }, {})).reactions;
        saveConfig({ ...loadConfig({ secrets: false }), profile: { title: 'Kept', language: 'ko' } });

        assert.equal(loadConfig({ secrets: false }).reactions, true);
        assert.equal(Object.hasOwn(stored(), 'reactions'), false);
        assert.deepEqual(api.getReactionSettings(), { reactions: true });
        assert.deepEqual(await features(), { enabled: true });
        assert.equal(featureDisallowedToolsFor(loadConfig({ secrets: false })).includes('react'), false);

        const off = await setup({ action: 'set_reactions_enabled', enabled: false });
        assert.equal(off.reactions, false);
        assert.equal(stored().reactions, false, 'only the opt-out is stored');
        assert.deepEqual(await features(), { enabled: false });
        assert.deepEqual(api.getReactionSettings(), { reactions: false });
        assert.equal(featureDisallowedToolsFor(loadConfig({ secrets: false })).includes('react'), true);
        assert.equal(stored().profile.title, 'Kept');

        await assert.rejects(setup({ action: 'set_reactions_enabled', enabled: 'no' }), /boolean/);
        await assert.rejects(setup({ action: 'set_reactions_enabled' }), /enabled is required/);
        assert.equal(stored().reactions, false);

        const on = await setup({ action: 'set_reactions_enabled', enabled: true });
        assert.equal(on.reactions, true);
        assert.equal(Object.hasOwn(stored(), 'reactions'), false, 'turning it on removes the stored key');
        assert.deepEqual(await features(), { enabled: true });
        assert.equal(stored().profile.title, 'Kept');
        `,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          MIXDOG_DATA_DIR: dataDir,
          MIXDOG_CONFIG_READ_TTL_MS: '0',
          MIXDOG_USER_DATA_BACKUP_ROOT: join(dataDir, 'backups'),
        },
        encoding: 'utf8',
      }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the session surface forwards the reactions setting, and reads on when the runtime does not know it', async () => {
  let config = {};
  const settings = createSettingsApi({
    getConfig: () => config,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
  });
  const bag = (runtime) =>
    new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === 'runtime') return runtime;
          if (key === 'flags') return {};
          if (key === 'listeners') return new Set();
          if (key === 'pending') return [];
          return () => ({});
        },
        has: () => true,
      }
    );
  const api = createSessionApi(bag(settings));
  assert.deepEqual(api.getReactionSettings(), { reactions: true });
  assert.deepEqual(await api.setReactionsEnabled(false), { reactions: false });
  assert.equal(config.reactions, false);
  assert.deepEqual(await api.setReactionsEnabled(true), { reactions: true });
  assert.deepEqual(settings.setReactionsEnabled('yes'), { reactions: false }, 'only a literal true turns it on');
  assert.deepEqual(createSessionApi(bag({})).getReactionSettings(), { reactions: true });
});

test("while the setting is off a bot's react call is refused before it runs; reactions already left stay", async () => {
  const message = {
    role: 'user',
    content: 'hi',
    meta: { transcript: { messageId: 'm1', reactions: [{ agentId: 'reviewer', emoji: '👍', at: 1 }] } },
  };
  const rt = { config: { reactions: false }, session: { id: 'sess_home_reviewer', messages: [message] } };
  const execute = createInternalToolExecutor({ rt, channels: { isChannelTool: () => false } });
  await assert.rejects(
    execute('react', { emoji: '❤️' }, { invocationSource: 'model-tool', callerSessionId: 'sess_home_reviewer' }),
    /reactions are turned off in settings/
  );
  assert.equal(rt.session.messages[0], message, 'nothing changed');
  // The gate holds for any invocation source, including an omitted one.
  for (const callerCtx of [{}, { invocationSource: 'cli' }, { invocationSource: 'internal' }]) {
    await assert.rejects(
      execute('react', { emoji: '❤️' }, { ...callerCtx, callerSessionId: 'sess_home_reviewer' }),
      /reactions are turned off in settings/,
      JSON.stringify(callerCtx)
    );
  }
  assert.equal(rt.session.messages[0], message, 'still nothing changed');
  rt.config.reactions = true;
  assert.match(
    await execute('react', { emoji: '❤️' }, { invocationSource: 'model-tool', callerSessionId: 'sess_home_reviewer' }),
    /^Reacted ❤️/
  );
});
