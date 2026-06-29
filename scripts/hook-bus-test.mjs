import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
