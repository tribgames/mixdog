import assert from 'node:assert/strict';
import test from 'node:test';

const SERVERS = [{ name: 'notion' }, { name: 'linear' }];

async function runMcp(command) {
  const { createSlashExecutor } = await import('./composer-slash-executor.ts');
  const calls = [];
  const notices = [];
  const errors = [];
  const settings = [];
  const events = [];
  const previousWindow = globalThis.window;
  globalThis.window = {
    dispatchEvent: (event) => events.push(event.type),
    CustomEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    clearTimeout,
    setTimeout,
    mixdogDesktop: {
      invokeCapability: async ({ capability, args }) => {
        calls.push([capability, args]);
        if (capability === 'beginMcpOAuthLogin') throw new Error('stop here');
        return { value: capability === 'mcpStatus' ? { servers: SERVERS } : {} };
      },
    },
  };
  try {
    const run = createSlashExecutor({
      sessionId: 'session-1',
      draftMode: false,
      turnBusy: false,
      provider: 'openai',
      model: 'gpt-6-sol',
      effort: 'high',
      fast: false,
      fastCapable: false,
      invokeResult: async (action) => await action(),
      invokeCapabilityResult: async (capability, args) => {
        calls.push([capability, args]);
        return { value: capability === 'mcpStatus' ? { servers: SERVERS } : {} };
      },
      applySnapshot() {},
      submit: async () => {},
      setAttachmentError: (message) => message && errors.push(message),
      clearNotice() {},
      showNotice: (message) => notices.push(message),
      openGoalDialog() {},
      onNewTask() {},
      onResumeSession() {},
      onOpenSessions() {},
      onOpenProjects() {},
      onOpenSettings: (section) => settings.push(section),
      onOpenCommandSurface() {},
    });
    const accepted = await run(command);
    return { accepted, calls, notices, errors, settings, events };
  } finally {
    globalThis.window = previousWindow;
  }
}

test('plain /mcp still opens MCP settings', async () => {
  const { accepted, calls, settings } = await runMcp('/mcp');
  assert.equal(accepted, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(settings, ['mcp']);
});

test('/mcp logout signs the named server out', async () => {
  const { accepted, calls, notices, settings } = await runMcp('/mcp logout notion');
  assert.equal(accepted, true);
  assert.deepEqual(calls, [
    ['mcpStatus', []],
    ['signOutMcpServer', ['notion']],
  ]);
  assert.deepEqual(notices, ['MCP signed out of notion']);
  assert.deepEqual(settings, []);
});

test('/mcp login begins the connector sign-in and opens the connectors tab', async () => {
  const { accepted, calls, events } = await runMcp('/mcp login linear');
  assert.equal(accepted, true);
  assert.deepEqual(calls, [
    ['mcpStatus', []],
    ['beginMcpOAuthLogin', ['linear']],
  ]);
  assert.ok(events.includes('mixdog:open-connectors'));
});

test('/mcp login and logout reject an unknown server', async () => {
  for (const action of ['login', 'logout']) {
    const { accepted, calls, errors } = await runMcp(`/mcp ${action} nope`);
    assert.equal(accepted, false);
    assert.deepEqual(calls, [['mcpStatus', []]]);
    assert.deepEqual(errors, ['Unknown MCP server: nope']);
  }
});

test('/mcp login and logout need a server name', async () => {
  for (const action of ['login', 'logout']) {
    const { accepted, calls, errors } = await runMcp(`/mcp ${action}`);
    assert.equal(accepted, false);
    assert.deepEqual(calls, []);
    assert.deepEqual(errors, [`usage: /mcp ${action} <name>`]);
  }
});
