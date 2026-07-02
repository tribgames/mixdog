import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStandaloneHookBus } from '../src/standalone/hook-bus.mjs';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'mixdog-hook-test-'));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('standard PreToolUse hook can deny and modify tool input', async () => {
  const root = tempRoot();
  const hookScript = join(root, 'pretool.mjs');
  writeFileSync(hookScript, `
import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const command = input.tool_input?.command || '';
if (command.includes('rm -rf')) {
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'blocked destructive command'
  }}));
} else if (command === 'rewrite-me') {
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    updatedInput: { command: 'rewritten' }
  }}));
}
`, 'utf8');
  const hooksFile = join(root, 'hooks.json');
  writeJson(hooksFile, {
    hooks: {
      PreToolUse: [{
        matcher: 'shell',
        hooks: [{ type: 'command', command: process.execPath, args: [hookScript] }],
      }],
    },
  });

  const prev = process.env.MIXDOG_HOOKS_FILE;
  process.env.MIXDOG_HOOKS_FILE = hooksFile;
  try {
    const bus = createStandaloneHookBus({ dataDir: root });
    const denied = await bus.beforeTool({ sessionId: 'sess_test', cwd: root, name: 'shell', args: { command: 'rm -rf build' } });
    assert.equal(denied.action, 'deny');
    assert.match(denied.reason, /blocked destructive/);

    const modified = await bus.beforeTool({ sessionId: 'sess_test', cwd: root, name: 'shell', args: { command: 'rewrite-me' } });
    assert.equal(modified.action, 'modify');
    assert.deepEqual(modified.args, { command: 'rewritten' });
  } finally {
    if (prev == null) delete process.env.MIXDOG_HOOKS_FILE;
    else process.env.MIXDOG_HOOKS_FILE = prev;
  }
});

test('UserPromptSubmit hook returns additional context', async () => {
  const root = tempRoot();
  const hookScript = join(root, 'prompt.mjs');
  writeFileSync(hookScript, `console.log('plain prompt context');\n`, 'utf8');
  const hooksFile = join(root, 'hooks.json');
  writeJson(hooksFile, {
    hooks: {
      UserPromptSubmit: [{
        hooks: [{ type: 'command', command: process.execPath, args: [hookScript] }],
      }],
    },
  });

  const prev = process.env.MIXDOG_HOOKS_FILE;
  process.env.MIXDOG_HOOKS_FILE = hooksFile;
  try {
    const bus = createStandaloneHookBus({ dataDir: root });
    const result = await bus.dispatch('UserPromptSubmit', { session_id: 'sess_test', cwd: root, prompt: 'hello' });
    assert.deepEqual(result.additionalContext, ['plain prompt context']);
  } finally {
    if (prev == null) delete process.env.MIXDOG_HOOKS_FILE;
    else process.env.MIXDOG_HOOKS_FILE = prev;
  }
});

test('legacy hook rule ask requests approval instead of allowing silently', async () => {
  const root = tempRoot();
  const rulesFile = join(root, 'hooks.json');
  writeJson(rulesFile, {
    toolBefore: [{
      tool: 'shell',
      action: 'ask',
      reason: 'legacy rule approval',
      enabled: true,
    }],
  });

  const bus = createStandaloneHookBus({ dataDir: root });
  const asked = await bus.beforeTool({ sessionId: 'sess_test', cwd: root, name: 'shell', args: { command: 'echo ok' } });
  assert.equal(asked.action, 'ask');
  assert.match(asked.reason, /legacy rule approval/);
});

test('hook config ignores Claude settings paths and reads project .mixdog hooks', async () => {
  const root = tempRoot();
  const claudeDir = join(root, '.claude');
  const mixdogDir = join(root, '.mixdog');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(mixdogDir, { recursive: true });

  const denyScript = join(root, 'deny.mjs');
  writeFileSync(denyScript, `
console.log(JSON.stringify({ hookSpecificOutput: {
  hookEventName: 'PreToolUse',
  permissionDecision: 'deny',
  permissionDecisionReason: 'mixdog hook only'
}}));
`, 'utf8');

  writeJson(join(claudeDir, 'settings.json'), {
    hooks: {
      PreToolUse: [{
        matcher: 'shell',
        hooks: [{ type: 'command', command: process.execPath, args: [denyScript] }],
      }],
    },
  });

  const busWithoutMixdog = createStandaloneHookBus({ dataDir: join(root, 'data-empty') });
  const ignored = await busWithoutMixdog.beforeTool({ sessionId: 'sess_test', cwd: root, name: 'shell', args: { command: 'echo ok' } });
  assert.equal(ignored, null);
  assert.equal(busWithoutMixdog.status().configSources.some((p) => p.includes(`${join(root, '.claude')}`)), false);

  writeJson(join(mixdogDir, 'hooks.json'), {
    hooks: {
      PreToolUse: [{
        matcher: 'shell',
        hooks: [{ type: 'command', command: process.execPath, args: [denyScript] }],
      }],
    },
  });

  const busWithMixdog = createStandaloneHookBus({ dataDir: join(root, 'data-mixdog') });
  const denied = await busWithMixdog.beforeTool({ sessionId: 'sess_test', cwd: root, name: 'shell', args: { command: 'echo ok' } });
  assert.equal(denied.action, 'deny');
  assert.match(denied.reason, /mixdog hook only/);
});

test('registered plugin hooks read from plugin root with plugin env aliases', async () => {
  const root = tempRoot();
  const dataDir = join(root, 'data');
  const pluginRoot = join(root, 'plugin-a');
  const hooksDir = join(pluginRoot, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(join(dataDir, 'plugins'), { recursive: true });

  const envScript = join(pluginRoot, 'env-check.mjs');
  writeFileSync(envScript, `
import { readFileSync } from 'node:fs';
JSON.parse(readFileSync(0, 'utf8'));
if (process.env.CLAUDE_PLUGIN_ROOT === ${JSON.stringify(pluginRoot)}
  && process.env.MIXDOG_PLUGIN_ROOT === ${JSON.stringify(pluginRoot)}
  && /plugin-a/.test(process.env.CLAUDE_PLUGIN_DATA || '')
  && /plugin-a/.test(process.env.MIXDOG_PLUGIN_DATA || '')) {
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'plugin root env ok'
  }}));
}
`, 'utf8');

  writeJson(join(dataDir, 'plugins', 'registry.json'), {
    version: 1,
    plugins: [{
      id: 'plugin-a',
      source: pluginRoot,
      sourceType: 'local',
      root: pluginRoot,
      name: 'plugin-a',
      managed: false,
    }],
  });
  writeJson(join(hooksDir, 'hooks.json'), {
    hooks: {
      PreToolUse: [{
        matcher: 'shell',
        hooks: [{ type: 'command', command: process.execPath, args: ['${CLAUDE_PLUGIN_ROOT}/env-check.mjs'] }],
      }],
    },
  });

  const bus = createStandaloneHookBus({ dataDir });
  const denied = await bus.beforeTool({ sessionId: 'sess_test', cwd: root, name: 'shell', args: { command: 'echo ok' } });
  assert.equal(denied.action, 'deny');
  assert.match(denied.reason, /plugin root env ok/);
});

test('standard PreToolUse ask requests approval instead of allowing silently', async () => {
  const root = tempRoot();
  const hookScript = join(root, 'ask.mjs');
  writeFileSync(hookScript, `
console.log(JSON.stringify({ hookSpecificOutput: {
  hookEventName: 'PreToolUse',
  permissionDecision: 'ask',
  permissionDecisionReason: 'needs human approval'
}}));
`, 'utf8');
  const hooksFile = join(root, 'hooks.json');
  writeJson(hooksFile, {
    hooks: {
      PreToolUse: [{
        matcher: 'shell',
        hooks: [{ type: 'command', command: process.execPath, args: [hookScript] }],
      }],
    },
  });

  const prev = process.env.MIXDOG_HOOKS_FILE;
  process.env.MIXDOG_HOOKS_FILE = hooksFile;
  try {
    const bus = createStandaloneHookBus({ dataDir: root });
    const asked = await bus.beforeTool({ sessionId: 'sess_test', cwd: root, name: 'shell', args: { command: 'echo ok' } });
    assert.equal(asked.action, 'ask');
    assert.match(asked.reason, /human approval/);
  } finally {
    if (prev == null) delete process.env.MIXDOG_HOOKS_FILE;
    else process.env.MIXDOG_HOOKS_FILE = prev;
  }
});

test('async command hook reports spawn errors without crashing', async () => {
  const root = tempRoot();
  const missingCommand = join(root, 'missing-async-hook-binary');
  const hooksFile = join(root, 'hooks.json');
  writeJson(hooksFile, {
    hooks: {
      Stop: [{
        hooks: [{
          type: 'command',
          command: missingCommand,
          args: [],
          async: true,
        }],
      }],
    },
  });

  const prev = process.env.MIXDOG_HOOKS_FILE;
  process.env.MIXDOG_HOOKS_FILE = hooksFile;
  try {
    const bus = createStandaloneHookBus({ dataDir: root });
    await bus.dispatch('Stop', { session_id: 'sess_test', cwd: root });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = bus.status();
    const spawnError = status.recent.find((entry) => entry.name === 'hook:error'
      && String(entry.payload?.error || '').includes('hook spawn failed'));
    assert.ok(spawnError, 'expected async spawn failure to emit hook:error');
  } finally {
    if (prev == null) delete process.env.MIXDOG_HOOKS_FILE;
    else process.env.MIXDOG_HOOKS_FILE = prev;
  }
});

test('PostToolUse dispatch omits updatedToolOutput when hook does not override', async () => {
  const root = tempRoot();
  const hookScript = join(root, 'posttool-noop.mjs');
  writeFileSync(hookScript, `console.log('{}');\n`, 'utf8');
  const hooksFile = join(root, 'hooks.json');
  writeJson(hooksFile, {
    hooks: {
      PostToolUse: [{
        hooks: [{ type: 'command', command: process.execPath, args: [hookScript] }],
      }],
    },
  });

  const prev = process.env.MIXDOG_HOOKS_FILE;
  process.env.MIXDOG_HOOKS_FILE = hooksFile;
  try {
    const bus = createStandaloneHookBus({ dataDir: root });
    const result = await bus.dispatch('PostToolUse', {
      session_id: 'sess_test',
      cwd: root,
      tool_name: 'list',
      tool_response: 'entries',
    });
    assert.equal('updatedToolOutput' in result, false);
  } finally {
    if (prev == null) delete process.env.MIXDOG_HOOKS_FILE;
    else process.env.MIXDOG_HOOKS_FILE = prev;
  }
});

test('PostToolUse dispatch preserves empty-string updatedToolOutput override', async () => {
  const root = tempRoot();
  const hookScript = join(root, 'posttool-clear.mjs');
  writeFileSync(hookScript, `
console.log(JSON.stringify({ hookSpecificOutput: {
  hookEventName: 'PostToolUse',
  updatedToolOutput: ''
}}));
`, 'utf8');
  const hooksFile = join(root, 'hooks.json');
  writeJson(hooksFile, {
    hooks: {
      PostToolUse: [{
        hooks: [{ type: 'command', command: process.execPath, args: [hookScript] }],
      }],
    },
  });

  const prev = process.env.MIXDOG_HOOKS_FILE;
  process.env.MIXDOG_HOOKS_FILE = hooksFile;
  try {
    const bus = createStandaloneHookBus({ dataDir: root });
    const result = await bus.dispatch('PostToolUse', {
      session_id: 'sess_test',
      cwd: root,
      tool_name: 'list',
      tool_response: 'entries',
    });
    assert.equal(result.updatedToolOutput, '');
  } finally {
    if (prev == null) delete process.env.MIXDOG_HOOKS_FILE;
    else process.env.MIXDOG_HOOKS_FILE = prev;
  }
});

test('mcp_tool handler routes output through parseHandlerOutput', async () => {
  const root = tempRoot();
  const hooksFile = join(root, 'hooks.json');
  writeJson(hooksFile, {
    hooks: {
      PreToolUse: [{
        matcher: 'shell',
        hooks: [{ type: 'mcp_tool', server: 'guard', tool: 'check' }],
      }],
    },
  });
  const prev = process.env.MIXDOG_HOOKS_FILE;
  process.env.MIXDOG_HOOKS_FILE = hooksFile;
  try {
    let seenName = null;
    const bus = createStandaloneHookBus({
      dataDir: root,
      mcpToolRunner: async ({ name }) => {
        seenName = name;
        return JSON.stringify({ hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'mcp denied',
        }});
      },
    });
    const denied = await bus.beforeTool({ sessionId: 's', cwd: root, name: 'shell', args: { command: 'x' } });
    assert.equal(seenName, 'mcp__guard__check');
    assert.equal(denied.action, 'deny');
    assert.match(denied.reason, /mcp denied/);
  } finally {
    if (prev == null) delete process.env.MIXDOG_HOOKS_FILE;
    else process.env.MIXDOG_HOOKS_FILE = prev;
  }
});

test('prompt handler ok:false maps to deny', async () => {
  const root = tempRoot();
  const hooksFile = join(root, 'hooks.json');
  writeJson(hooksFile, {
    hooks: {
      PreToolUse: [{
        matcher: 'shell',
        hooks: [{ type: 'prompt', prompt: 'is this safe?' }],
      }],
    },
  });
  const prev = process.env.MIXDOG_HOOKS_FILE;
  process.env.MIXDOG_HOOKS_FILE = hooksFile;
  try {
    const bus = createStandaloneHookBus({
      dataDir: root,
      promptRunner: async () => JSON.stringify({ ok: false, reason: 'unsafe' }),
    });
    const denied = await bus.beforeTool({ sessionId: 's', cwd: root, name: 'shell', args: { command: 'x' } });
    assert.equal(denied.action, 'deny');
    assert.match(denied.reason, /unsafe/);
  } finally {
    if (prev == null) delete process.env.MIXDOG_HOOKS_FILE;
    else process.env.MIXDOG_HOOKS_FILE = prev;
  }
});

test('unconfigured prompt/mcp_tool and unsupported agent emit hook:error and skip', async () => {
  const root = tempRoot();
  const hooksFile = join(root, 'hooks.json');
  writeJson(hooksFile, {
    hooks: {
      PreToolUse: [{
        matcher: 'shell',
        hooks: [
          { type: 'prompt', prompt: 'x' },
          { type: 'mcp_tool', server: 'g', tool: 't' },
          { type: 'agent', agent: 'a' },
        ],
      }],
    },
  });
  const prev = process.env.MIXDOG_HOOKS_FILE;
  process.env.MIXDOG_HOOKS_FILE = hooksFile;
  try {
    const bus = createStandaloneHookBus({ dataDir: root });
    const result = await bus.beforeTool({ sessionId: 's', cwd: root, name: 'shell', args: { command: 'x' } });
    assert.equal(result, null);
    const errs = bus.status().recent.filter((e) => e.name === 'hook:error');
    assert.ok(errs.some((e) => /prompt not configured/.test(e.payload?.error || '')));
    assert.ok(errs.some((e) => /mcp_tool not configured/.test(e.payload?.error || '')));
    assert.ok(errs.some((e) => /unsupported hook type: agent/.test(e.payload?.error || '')));
  } finally {
    if (prev == null) delete process.env.MIXDOG_HOOKS_FILE;
    else process.env.MIXDOG_HOOKS_FILE = prev;
  }
});

test('setRewakeHandler fires on async child exit code 2', async () => {
  const root = tempRoot();
  const hookScript = join(root, 'rewake.mjs');
  writeFileSync(hookScript, `process.stderr.write('needs rewake'); process.exit(2);`, 'utf8');
  const hooksFile = join(root, 'hooks.json');
  writeJson(hooksFile, {
    hooks: {
      Stop: [{
        hooks: [{ type: 'command', command: process.execPath, args: [hookScript], asyncRewake: true }],
      }],
    },
  });
  const prev = process.env.MIXDOG_HOOKS_FILE;
  process.env.MIXDOG_HOOKS_FILE = hooksFile;
  try {
    const bus = createStandaloneHookBus({ dataDir: root });
    const fired = new Promise((resolve) => bus.setRewakeHandler((info) => resolve(info)));
    await bus.dispatch('Stop', { session_id: 's', cwd: root });
    const info = await fired;
    assert.equal(info.eventName, 'Stop');
    assert.match(info.text, /needs rewake/);
  } finally {
    if (prev == null) delete process.env.MIXDOG_HOOKS_FILE;
    else process.env.MIXDOG_HOOKS_FILE = prev;
  }
});

test('prompt handler plain-text "no" denies', async () => {
  const root = tempRoot();
  const hooksFile = join(root, 'hooks.json');
  writeJson(hooksFile, {
    hooks: {
      PreToolUse: [{ matcher: 'shell', hooks: [{ type: 'prompt', prompt: 'safe?' }] }],
    },
  });
  const prev = process.env.MIXDOG_HOOKS_FILE;
  process.env.MIXDOG_HOOKS_FILE = hooksFile;
  try {
    const bus = createStandaloneHookBus({ dataDir: root, promptRunner: async () => 'no' });
    const denied = await bus.beforeTool({ sessionId: 's', cwd: root, name: 'shell', args: { command: 'x' } });
    assert.equal(denied.action, 'deny');
    assert.match(denied.reason, /no/i);
  } finally {
    if (prev == null) delete process.env.MIXDOG_HOOKS_FILE;
    else process.env.MIXDOG_HOOKS_FILE = prev;
  }
});

test('prompt handler timeout does not hang and reports error', async () => {
  const root = tempRoot();
  const hooksFile = join(root, 'hooks.json');
  writeJson(hooksFile, {
    hooks: {
      PreToolUse: [{ matcher: 'shell', hooks: [{ type: 'prompt', prompt: 'x', timeout: 0.05 }] }],
    },
  });
  const prev = process.env.MIXDOG_HOOKS_FILE;
  process.env.MIXDOG_HOOKS_FILE = hooksFile;
  try {
    const bus = createStandaloneHookBus({
      dataDir: root,
      promptRunner: () => new Promise(() => {}),
    });
    const result = await bus.beforeTool({ sessionId: 's', cwd: root, name: 'shell', args: { command: 'x' } });
    assert.equal(result, null);
    const errs = bus.status().recent.filter((e) => e.name === 'hook:error');
    assert.ok(errs.some((e) => /timed out/i.test(e.payload?.error || '')));
  } finally {
    if (prev == null) delete process.env.MIXDOG_HOOKS_FILE;
    else process.env.MIXDOG_HOOKS_FILE = prev;
  }
});

test('prompt deny uses universal exit-2 path on Stop event', async () => {
  const root = tempRoot();
  const hooksFile = join(root, 'hooks.json');
  writeJson(hooksFile, {
    hooks: {
      Stop: [{ hooks: [{ type: 'prompt', prompt: 'done?' }] }],
    },
  });
  const prev = process.env.MIXDOG_HOOKS_FILE;
  process.env.MIXDOG_HOOKS_FILE = hooksFile;
  try {
    const bus = createStandaloneHookBus({
      dataDir: root,
      promptRunner: async () => JSON.stringify({ ok: false, reason: 'not done' }),
    });
    const result = await bus.dispatch('Stop', { session_id: 's', cwd: root });
    assert.equal(result.blocked, true);
    assert.match(result.reason, /not done/);
  } finally {
    if (prev == null) delete process.env.MIXDOG_HOOKS_FILE;
    else process.env.MIXDOG_HOOKS_FILE = prev;
  }
});
