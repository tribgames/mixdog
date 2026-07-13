import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HELP_LINES } from '../src/help.mjs';
import { parseHeadlessRoleCommand } from '../src/app.mjs';
import { classifyCliInvocation } from '../src/headless-command.mjs';
import { runHeadlessRole } from '../src/headless-role.mjs';
import { boundProviderAuthPath } from '../src/runtime/shared/provider-auth-binding.mjs';
import { AGENT_PROVIDER_ENV_ALIASES } from '../src/runtime/shared/provider-api-key.mjs';
import {
  PRISTINE_EXECUTION_CONTRACT,
  buildMinimalPristineConfig,
  createPristineExecutionBoundary,
  validateExplicitPristineRoute,
} from '../src/runtime/shared/pristine-execution.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function fixtureHost() {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-headless-host-'));
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'openai-oauth.json'), JSON.stringify({
    access_token: 'access-secret',
    refresh_token: 'refresh-secret',
  }));
  writeFileSync(join(data, 'openai-oauth-models.json'), '{"models":[]}');
  writeFileSync(join(data, 'mixdog-config.json'), '{"personalBehavior":"must-not-load"}');
  for (const relative of [
    'skills/personal/SKILL.md',
    'sessions/prior.json',
    'plugins/registry.json',
    'memory/core.json',
    'profiles/personal.json',
    'channels/discord.json',
  ]) {
    const path = join(data, relative);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, 'personal-secret');
  }
  return { root, data };
}

test('headless command parsing remains role-focused while route validation is explicit', () => {
  assert.deepEqual(
    parseHeadlessRoleCommand(['--provider', 'openai-oauth', '--model', 'gpt-x', 'review', 'check', 'it']),
    { agent: 'reviewer', message: 'check it' },
  );
  assert.match(validateExplicitPristineRoute({}), /require both --provider/);
  assert.match(
    validateExplicitPristineRoute({ provider: 'openai-oauth' }),
    /host route fallback is disabled/,
  );
  assert.equal(
    validateExplicitPristineRoute({ provider: 'openai-oauth', model: 'gpt-x', effort: 'high', fast: true }),
    null,
  );
  assert.ok(HELP_LINES.some((line) => line.includes('--provider <name> --model <name>')));
  assert.ok(HELP_LINES.some((line) => line.includes('host behavioral config')));
  const missingProviderValue = classifyCliInvocation([
    '--provider', '--model', 'gpt-x', 'worker', 'fixture',
  ]);
  assert.equal(missingProviderValue.kind, 'error');
  assert.equal(missingProviderValue.skipHostPrelude, true);
  assert.match(missingProviderValue.error, /--provider requires a non-option value/);
  const missingModelValue = classifyCliInvocation([
    '--provider', 'openai-oauth', '--model', '--fast', 'worker', 'fixture',
  ]);
  assert.equal(missingModelValue.kind, 'error');
  assert.equal(missingModelValue.skipHostPrelude, true);
  assert.match(missingModelValue.error, /--model requires a non-option value/);
  const roleConsumedAsModel = classifyCliInvocation([
    '--provider', 'openai-oauth', '--model', 'worker', 'fixture',
  ]);
  assert.equal(roleConsumedAsModel.kind, 'error');
  assert.equal(roleConsumedAsModel.skipHostPrelude, true);
  assert.match(roleConsumedAsModel.error, /route value before headless role/);
  const roleConsumedAsEffort = classifyCliInvocation([
    '--provider', 'openai-oauth', '--model', 'gpt-x', '--effort', 'worker', 'fixture',
  ]);
  assert.equal(roleConsumedAsEffort.kind, 'error');
  assert.equal(roleConsumedAsEffort.skipHostPrelude, true);
  assert.match(roleConsumedAsEffort.error, /--effort requires a route value before headless role/);
  const unknownHeadlessOption = classifyCliInvocation([
    '--provider', 'openai-oauth', '--model', 'gpt-x', 'worker', 'fixture', '--bogus',
  ]);
  assert.equal(unknownHeadlessOption.kind, 'error');
  assert.equal(unknownHeadlessOption.skipHostPrelude, true);
  assert.match(unknownHeadlessOption.error, /unknown option --bogus/);
  const unknownBeforeHeadlessRole = classifyCliInvocation([
    '--provider', 'openai', '--model', 'gpt', '--bogus', 'worker', 'task',
  ]);
  assert.equal(unknownBeforeHeadlessRole.kind, 'error');
  assert.equal(unknownBeforeHeadlessRole.skipHostPrelude, true);
  assert.match(unknownBeforeHeadlessRole.error, /unknown option --bogus/);
  const forbiddenWorkflow = classifyCliInvocation([
    '--provider', 'openai-oauth', '--model', 'gpt-x', '--workflow', 'default', 'worker', 'fixture',
  ]);
  assert.equal(forbiddenWorkflow.kind, 'error');
  assert.equal(forbiddenWorkflow.skipHostPrelude, true);
  assert.match(forbiddenWorkflow.error, /--workflow is not supported for headless role commands/);
  const workflowMustNotConsumeRole = classifyCliInvocation(['--workflow', 'worker', 'task']);
  assert.equal(workflowMustNotConsumeRole.kind, 'error');
  assert.equal(workflowMustNotConsumeRole.skipHostPrelude, true);
  assert.match(workflowMustNotConsumeRole.error, /--workflow is not supported for headless role commands/);
  const ordinaryGeneral = classifyCliInvocation(['chat', 'task']);
  assert.equal(ordinaryGeneral.kind, 'general');
  assert.equal(ordinaryGeneral.skipHostPrelude, undefined);
  const ordinaryUnknownOption = classifyCliInvocation(['--bogus', 'chat', 'task']);
  assert.equal(ordinaryUnknownOption.kind, 'error');
  assert.equal(ordinaryUnknownOption.skipHostPrelude, undefined);
  const plainConflict = classifyCliInvocation(['--plain', 'worker', 'fixture']);
  assert.equal(plainConflict.kind, 'plain');
  assert.equal(plainConflict.skipHostPrelude, undefined);
  assert.equal(parseHeadlessRoleCommand(['--plain', 'worker', 'fixture']), null);
  const plainUnknownOption = classifyCliInvocation(['--plain', 'worker', 'fixture', '--bogus']);
  assert.equal(plainUnknownOption.kind, 'error');
  assert.equal(plainUnknownOption.skipHostPrelude, undefined);
  const reactWorkflowRole = classifyCliInvocation(['--react', '--workflow', 'worker', 'task']);
  assert.equal(reactWorkflowRole.kind, 'react');
  assert.equal(reactWorkflowRole.skipHostPrelude, undefined);
});

test('boundary binds only provider auth, copies only its catalog, and cleans all ephemeral state', () => {
  const host = fixtureHost();
  const previous = {
    data: process.env.MIXDOG_DATA_DIR,
    home: process.env.MIXDOG_HOME,
    auth: process.env.OPENAI_OAUTH_CREDENTIALS_PATH,
    behavior: process.env.MIXDOG_PERSONAL_BEHAVIOR,
    debug: process.env.MIXDOG_DEBUG_AGENT,
    anthropic: process.env.ANTHROPIC_API_KEY,
  };
  process.env.MIXDOG_DATA_DIR = host.data;
  process.env.MIXDOG_PERSONAL_BEHAVIOR = 'must-be-scrubbed';
  process.env.MIXDOG_DEBUG_AGENT = 'must-be-scrubbed';
  process.env.ANTHROPIC_API_KEY = 'unrelated-api-secret';
  delete process.env.OPENAI_OAUTH_CREDENTIALS_PATH;
  let boundary;
  try {
    boundary = createPristineExecutionBoundary({
      provider: 'openai-oauth',
      model: 'gpt-explicit',
      effort: 'xhigh',
      fast: true,
    });
    const names = readdirSync(boundary.dataDir).sort();
    assert.deepEqual(names, [
      'mixdog-config.json',
      'openai-oauth-models.json',
    ]);
    assert.equal(process.env.OPENAI_OAUTH_CREDENTIALS_PATH, undefined);
    assert.equal(
      boundProviderAuthPath('openai-oauth'),
      join(host.data, 'openai-oauth.json'),
    );
    assert.equal(process.env.MIXDOG_PERSONAL_BEHAVIOR, undefined);
    assert.equal(process.env.MIXDOG_DEBUG_AGENT, undefined);
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.MIXDOG_DISABLE_MCP, '1');
    assert.equal(process.env.MIXDOG_DISABLE_SKILLS, '1');
    assert.equal(process.env.MIXDOG_BOOT_CORE_MEMORY, '0');
    assert.equal(process.env.MIXDOG_DISABLE_CHANNEL_START, '1');
    assert.deepEqual(
      JSON.parse(readFileSync(join(boundary.dataDir, 'mixdog-config.json'), 'utf8')),
      buildMinimalPristineConfig({
        provider: 'openai-oauth',
        model: 'gpt-explicit',
        effort: 'xhigh',
        fast: true,
      }),
    );
    const serialized = JSON.stringify(boundary.audit);
    assert.ok(!serialized.includes('access-secret'));
    assert.ok(!serialized.includes('refresh-secret'));
    assert.equal(boundary.audit.personalState.hostConfigRead, false);
    assert.ok(Object.values(boundary.audit.featuresEnabled).every((value) => value === false));
    assert.equal(boundary.audit.authArtifactFilesCopied, 0);
    const runtimeConfig = boundary.loadConfig();
    assert.deepEqual(Object.keys(runtimeConfig.providers), ['openai-oauth']);
    assert.equal(runtimeConfig.providers['openai-oauth'].apiKey, undefined);
    const ephemeralRoot = boundary.rootDir;
    boundary.cleanup();
    assert.equal(existsSync(ephemeralRoot), false);
    boundary = null;
  } finally {
    boundary?.cleanup();
    if (previous.data === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous.data;
    if (previous.home === undefined) delete process.env.MIXDOG_HOME;
    else process.env.MIXDOG_HOME = previous.home;
    if (previous.auth === undefined) delete process.env.OPENAI_OAUTH_CREDENTIALS_PATH;
    else process.env.OPENAI_OAUTH_CREDENTIALS_PATH = previous.auth;
    if (previous.behavior === undefined) delete process.env.MIXDOG_PERSONAL_BEHAVIOR;
    else process.env.MIXDOG_PERSONAL_BEHAVIOR = previous.behavior;
    if (previous.debug === undefined) delete process.env.MIXDOG_DEBUG_AGENT;
    else process.env.MIXDOG_DEBUG_AGENT = previous.debug;
    if (previous.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous.anthropic;
    rmSync(host.root, { recursive: true, force: true });
  }
});

test('API-key auth is captured only for the selected provider and approved overrides are explicit', () => {
  const previous = {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    behavior: process.env.MIXDOG_OUTPUT_STYLE,
    timeout: process.env.MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    prompt: process.env.MIXDOG_PROMPT,
    workflow: process.env.MIXDOG_WORKFLOW,
  };
  process.env.OPENAI_API_KEY = 'selected-openai-secret';
  process.env.ANTHROPIC_API_KEY = 'unrelated-anthropic-secret';
  process.env.MIXDOG_OUTPUT_STYLE = 'personal-style';
  process.env.MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS = '12345';
  process.env.MIXDOG_PROMPT = 'host behavioral prompt';
  process.env.MIXDOG_WORKFLOW = 'host behavioral workflow';
  let boundary;
  try {
    boundary = createPristineExecutionBoundary({
      provider: 'openai',
      model: 'gpt-explicit',
    });
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.MIXDOG_OUTPUT_STYLE, undefined);
    assert.equal(process.env.MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS, '12345');
    assert.equal(process.env.MIXDOG_PROMPT, undefined);
    assert.equal(process.env.MIXDOG_WORKFLOW, undefined);
    const runtimeConfig = boundary.loadConfig();
    assert.deepEqual(Object.keys(runtimeConfig.providers), ['openai']);
    assert.equal(runtimeConfig.providers.openai.apiKey, 'selected-openai-secret');
    assert.ok(!JSON.stringify(boundary.audit).includes('selected-openai-secret'));
    assert.throws(
      () => createPristineExecutionBoundary({
        provider: 'openai',
        model: 'gpt-explicit',
        approvedExecutionEnv: { MIXDOG_OUTPUT_STYLE: 'forbidden' },
      }),
      /unapproved pristine execution environment override/,
    );
  } finally {
    boundary?.cleanup();
    if (previous.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.openai;
    if (previous.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous.anthropic;
    if (previous.behavior === undefined) delete process.env.MIXDOG_OUTPUT_STYLE;
    else process.env.MIXDOG_OUTPUT_STYLE = previous.behavior;
    if (previous.timeout === undefined) delete process.env.MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS;
    else process.env.MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS = previous.timeout;
    if (previous.prompt === undefined) delete process.env.MIXDOG_PROMPT;
    else process.env.MIXDOG_PROMPT = previous.prompt;
    if (previous.workflow === undefined) delete process.env.MIXDOG_WORKFLOW;
    else process.env.MIXDOG_WORKFLOW = previous.workflow;
  }
});

test('selected API-key lookup is provider-scoped and xAI aliases are scrubbed after capture', () => {
  const previous = {
    grok: process.env.GROK_API_KEY,
    xai: process.env.XAI_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };
  process.env.GROK_API_KEY = 'selected-grok-alias-secret';
  delete process.env.XAI_API_KEY;
  process.env.OPENAI_API_KEY = 'unrelated-openai-secret';
  const calls = [];
  let boundary;
  try {
    boundary = createPristineExecutionBoundary({
      provider: 'xai',
      model: 'grok-explicit',
      apiKeyResolver(provider) {
        calls.push(provider);
        return process.env.GROK_API_KEY;
      },
    });
    assert.deepEqual(calls, ['xai']);
    assert.deepEqual(AGENT_PROVIDER_ENV_ALIASES.xai, ['GROK_API_KEY']);
    assert.equal(boundary.loadConfig().providers.xai.apiKey, 'selected-grok-alias-secret');
    assert.equal(process.env.GROK_API_KEY, undefined);
    assert.equal(process.env.XAI_API_KEY, undefined);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.ok(!JSON.stringify(boundary.audit).includes('selected-grok-alias-secret'));
  } finally {
    boundary?.cleanup();
    if (previous.grok === undefined) delete process.env.GROK_API_KEY;
    else process.env.GROK_API_KEY = previous.grok;
    if (previous.xai === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previous.xai;
    if (previous.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.openai;
  }
});

test('API-key 401 recovery modules cannot reload general behavioral config', () => {
  for (const relative of [
    '../src/runtime/agent/orchestrator/providers/anthropic.mjs',
    '../src/runtime/agent/orchestrator/providers/gemini.mjs',
    '../src/runtime/agent/orchestrator/providers/openai-compat.mjs',
    '../src/runtime/agent/orchestrator/providers/openai-ws.mjs',
  ]) {
    const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /\bloadConfig\b/, relative);
    assert.match(source, /\bgetAgentApiKey\b/, relative);
  }
});

test('runHeadlessRole audits the isolated boundary and never invokes a provider in this test', async () => {
  const host = fixtureHost();
  const previousData = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = host.data;
  let ephemeralRoot;
  let spawnArgs;
  const errors = [];
  let factoryCalls = 0;
  const signalListenerBaseline = process.listenerCount('SIGTERM');
  let closeKeptSignalHandler = false;
  let boundaryCleanupKeptSignalHandler = false;
  try {
    const code = await runHeadlessRole({
      agent: 'worker',
      message: 'fixture only',
      provider: 'openai-oauth',
      model: 'gpt-explicit',
      effort: 'high',
      fast: true,
      write: () => {},
      writeErr: (text) => errors.push(text),
      agentRunnerFactory: async (_cwd, boundary) => {
        factoryCalls += 1;
        ephemeralRoot = process.env.MIXDOG_HOME;
        assert.deepEqual(Object.keys(boundary.loadConfig().providers), ['openai-oauth']);
        const originalCleanup = boundary.cleanup;
        boundary.cleanup = () => {
          boundaryCleanupKeptSignalHandler = process.listenerCount('SIGTERM') > signalListenerBaseline;
          originalCleanup();
        };
        return {
          async execute(args) {
            if (args.type === 'spawn') {
              spawnArgs = args;
              return 'fixture completed without provider';
            }
            if (args.type === 'close') {
              closeKeptSignalHandler = process.listenerCount('SIGTERM') > signalListenerBaseline;
            }
            return '';
          },
        };
      },
    });
    assert.equal(code, 0);
    assert.equal(factoryCalls, 1);
    assert.equal(spawnArgs.provider, 'openai-oauth');
    assert.equal(spawnArgs.model, 'gpt-explicit');
    assert.equal(spawnArgs.effort, 'high');
    assert.equal(spawnArgs.fast, true);
    assert.match(errors.join(''), /pristine-execution-audit v1/);
    assert.match(errors.join(''), /personal-files=0/);
    assert.equal(existsSync(ephemeralRoot), false);
    assert.equal(closeKeptSignalHandler, true);
    assert.equal(boundaryCleanupKeptSignalHandler, true);
    assert.equal(process.listenerCount('SIGTERM'), signalListenerBaseline);

    const missing = [];
    const missingCode = await runHeadlessRole({
      agent: 'worker',
      message: 'fixture',
      writeErr: (text) => missing.push(text),
      agentRunnerFactory: async () => {
        throw new Error('must not run');
      },
    });
    assert.equal(missingCode, 1);
    assert.match(missing.join(''), /require both --provider/);
  } finally {
    if (previousData === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousData;
    rmSync(host.root, { recursive: true, force: true });
  }
});

function childExit(child, label) {
  return new Promise((resolveExit, reject) => {
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => resolveExit({ code, stderr, label }));
  });
}

test('headless child signals close the runner and remove the pristine boundary', async () => {
  for (const [signal, expectedCode] of [['SIGTERM', 143], ['SIGHUP', 129]]) {
    const host = fixtureHost();
    const readyPath = join(host.root, `${signal}.ready`);
    const rootPath = join(host.root, `${signal}.root`);
    const closedPath = join(host.root, `${signal}.closed`);
    const childSource = `
import { writeFileSync } from 'node:fs';
import { runHeadlessRole } from ${JSON.stringify(new URL('../src/headless-role.mjs', import.meta.url).href)};
await runHeadlessRole({
  agent: 'worker',
  message: 'signal fixture',
  provider: 'openai-oauth',
  model: 'gpt-explicit',
  write: () => {},
  writeErr: () => {},
  agentRunnerFactory: async (_cwd, boundary) => ({
    async execute(args) {
      if (args.type === 'spawn') {
        writeFileSync(process.env.ROOT_PATH, boundary.rootDir);
        writeFileSync(process.env.READY_PATH, 'ready');
        setTimeout(() => process.emit(process.env.TEST_SIGNAL), 20);
        return 'agent task: signal-fixture';
      }
      if (args.type === 'close') {
        writeFileSync(process.env.CLOSED_PATH, 'closed');
        return '';
      }
      return new Promise(() => {});
    }
  })
});
`;
    try {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          MIXDOG_DATA_DIR: host.data,
          READY_PATH: readyPath,
          ROOT_PATH: rootPath,
          CLOSED_PATH: closedPath,
          TEST_SIGNAL: signal,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const result = await childExit(child, signal);
      assert.equal(result.code, expectedCode, result.stderr);
      assert.equal(readFileSync(closedPath, 'utf8'), 'closed');
      const ephemeralRoot = readFileSync(rootPath, 'utf8');
      assert.equal(existsSync(ephemeralRoot), false);
      assert.equal(existsSync(readyPath), true);
    } finally {
      rmSync(host.root, { recursive: true, force: true });
    }
  }
});

test('official CLI rejects a missing route without touching the host data tree', () => {
  const host = fixtureHost();
  try {
    const before = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `
        import { readdirSync, readFileSync } from 'node:fs';
        import { join } from 'node:path';
        const root = process.argv[1];
        const walk = (dir, base = '') => readdirSync(dir, { withFileTypes: true })
          .flatMap((entry) => entry.isDirectory()
            ? walk(join(dir, entry.name), join(base, entry.name))
            : [[join(base, entry.name).replaceAll('\\\\', '/'), readFileSync(join(dir, entry.name), 'utf8')]])
          .sort((a, b) => a[0].localeCompare(b[0]));
        process.stdout.write(JSON.stringify(walk(root)));
      `, host.data],
      { encoding: 'utf8' },
    );
    for (const args of [
      ['worker', 'fixture'],
      ['worker', 'fixture', '--provider', '--model', 'gpt-x'],
      ['--provider', 'openai-oauth', '--model', 'worker', 'fixture'],
      ['--provider', 'openai-oauth', '--model', 'gpt-x', '--effort', 'worker', 'fixture'],
      ['--provider', 'openai-oauth', '--model', 'gpt-x', 'worker', 'fixture', '--bogus'],
      ['--provider', 'openai-oauth', '--model', 'gpt-x', '--workflow', 'default', 'worker', 'fixture'],
      ['--provider', 'openai', '--model', 'gpt', '--bogus', 'worker', 'task'],
      ['--workflow', 'worker', 'task'],
    ]) {
      const result = spawnSync(process.execPath, ['src/cli.mjs', ...args], {
        cwd: REPO_ROOT,
        env: { ...process.env, MIXDOG_HOME: host.root, MIXDOG_DATA_DIR: host.data },
        encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /require both --provider|requires a non-option value|route value before headless role|unknown option --bogus|--workflow is not supported/,
      );
    }
    const after = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `
        import { readdirSync, readFileSync } from 'node:fs';
        import { join } from 'node:path';
        const root = process.argv[1];
        const walk = (dir, base = '') => readdirSync(dir, { withFileTypes: true })
          .flatMap((entry) => entry.isDirectory()
            ? walk(join(dir, entry.name), join(base, entry.name))
            : [[join(base, entry.name).replaceAll('\\\\', '/'), readFileSync(join(dir, entry.name), 'utf8')]])
          .sort((a, b) => a[0].localeCompare(b[0]));
        process.stdout.write(JSON.stringify(walk(root)));
      `, host.data],
      { encoding: 'utf8' },
    );
    assert.equal(after, before);
  } finally {
    rmSync(host.root, { recursive: true, force: true });
  }
});

test('Terminal-Bench and Node consume the same pristine contract document', () => {
  assert.equal(PRISTINE_EXECUTION_CONTRACT.schemaVersion, 1);
  assert.deepEqual(
    Object.keys(PRISTINE_EXECUTION_CONTRACT.oauthProviders).sort(),
    ['anthropic-oauth', 'grok-oauth', 'openai-oauth'],
  );
  for (const behavioralName of [
    'MIXDOG_PROMPT',
    'MIXDOG_PROVIDER',
    'MIXDOG_MODEL',
    'MIXDOG_EFFORT',
    'MIXDOG_FAST',
    'MIXDOG_WORKFLOW',
  ]) {
    assert.ok(!PRISTINE_EXECUTION_CONTRACT.approvedExecutionEnv.includes(behavioralName));
    assert.ok(PRISTINE_EXECUTION_CONTRACT.benchmarkRouteEnv.includes(behavioralName));
  }
});
