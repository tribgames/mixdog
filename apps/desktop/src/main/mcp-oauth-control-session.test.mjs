// The MCP OAuth sign-in through the path the desktop uses: a session-less
// capability call (invokeCapability -> control session) reaches the daemon's
// session service, which runs it on that session's runtime. The control
// session is replaced after any failed call, so a begin and the status polls /
// pasted callback that follow can land on different session runtimes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceApi } from '../../../../src/session-runtime/resource-api.mjs';
import { createSessionService } from '../../../../src/standalone/session-service.mjs';
import { SessionHostTransport } from './session-host-transport.ts';

const AUTH_URL = 'http://127.0.0.1:9/authorize?state=s&code_challenge_method=S256';
const CALLBACK = 'http://127.0.0.1:9/oauth/callback?code=c&state=s';
const INVALID_PASTE = 'The pasted sign-in URL is invalid.';

// One session runtime: the real MCP resource API (sign-in registry included)
// over a fake MCP client whose interactive connect waits for the callback.
function sessionRuntime(world) {
  let state = { sessionId: '', items: [], queued: [], busy: false };
  const servers = { fixture: { type: 'http', url: 'http://127.0.0.1:9/mcp' } };
  let answer;
  const api = createResourceApi({
    getConfig: () => ({ mcpServers: servers }),
    getSession: () => null,
    getCurrentCwd: () => process.cwd(),
    cfgMod: {},
    hooks: {},
    saveConfigAndAdopt: () => {},
    async connectConfiguredMcp(options) {
      let connected = false;
      if (options.login) {
        const outcome = new Promise((resolve) => {
          answer = resolve;
        });
        await options.login.openBrowser(AUTH_URL);
        connected = await outcome;
      }
      return { servers: [{ name: options.only, connected, error: null }] };
    },
    cancelMcpLogin: () => answer?.(false),
    completeMcpLogin: (_name, callbackUrl) => {
      if (!answer || callbackUrl !== CALLBACK) throw new Error(INVALID_PASTE);
      answer(true);
    },
    clearMcpServerOAuth: async () => {},
    getMcpServerOAuthState: () => ({ signedIn: false }),
    probeMcpServerAuth: async () => ({ auth: 'oauth' }),
    resolveMcpCatalog: () => ({ servers, adoption: null, plugins: {}, entries: {} }),
    invalidatePreSessionToolSurface: () => {},
    normalizeMcpServerInput: () => {
      throw new Error('not used');
    },
    mcpStatus: () => {
      if (world.failNextRead) {
        world.failNextRead = false;
        throw new Error('status unavailable');
      }
      return { servers: [] };
    },
    skillsStatus: () => ({ skills: [] }),
    pluginsStatus: () => ({ plugins: [] }),
    reloadFullConfig: () => {},
    awaitKeychainPrewarm: async () => {},
  });
  world.runtimes += 1;
  return {
    ...api,
    isWireSafe: true,
    getState: () => state,
    subscribe: () => () => {},
    async reserveSession(id) {
      state = { ...state, sessionId: id };
      return true;
    },
    dispose: async () => api.disposeGlobalExtensionSubscription(),
  };
}

function desktopTransport(t) {
  const world = { runtimes: 0, failNextRead: false };
  const service = createSessionService({ createSessionRuntime: async () => sessionRuntime(world) });
  t.after(() => service.stop());
  const client = {
    list: (args) => service.listSessions?.(args),
    create: (args) => service.createSession(args),
    read: (args) => service.readSession(args),
    subscribe: (args) => service.subscribeSession(args),
    unsubscribe: (args) => service.unsubscribeSession(args),
    submit: async () => ({}),
    abort: async () => ({}),
    approve: async () => ({}),
    configure: (args) => service.configureSession(args, { revision: 1 }),
    close: async () => {},
  };
  const transport = new SessionHostTransport(client, {
    isDisposed: () => false,
    taskWorkspace: async () => process.cwd(),
    openHints: () => ({}),
    transcriptWindow: () => ({}),
    projection: () => undefined,
    applySessionResult: () => null,
    heldTranscript: () => null,
    applyTranscriptPage: () => null,
    deleteProjection: () => {},
  });
  const call = async (method, args) => (await transport.invokeControlResult(method, args)).value;
  return { world, transport, call };
}

test('a remote sign-in survives the control session being replaced between begin, status polls and the paste', async (t) => {
  const { world, transport, call } = desktopTransport(t);
  await call('signOutMcpServer', ['fixture']);
  const begun = await call('beginMcpOAuthLogin', ['fixture', { openBrowser: false }]);
  assert.equal(begun.state, 'pending');
  assert.equal(begun.url, AUTH_URL);
  const beganOn = transport.controlSessionId;
  // Any failed control call (here one settings read) replaces the control
  // session: the next calls run on a new session runtime.
  world.failNextRead = true;
  await call('mcpStatus', []);
  assert.notEqual(transport.controlSessionId, beganOn);
  assert.equal(world.runtimes, 2);
  assert.deepEqual(await call('getMcpOAuthLoginStatus', [begun.flowId]), {
    flowId: begun.flowId,
    state: 'pending',
    step: 'browser',
    url: AUTH_URL,
  });
  // An invalid paste throws (and replaces the control session once more); the
  // flow stays pending and the corrected paste completes it.
  await assert.rejects(call('completeMcpOAuthLogin', [begun.flowId, 'garbage']), /pasted sign-in URL is invalid/);
  assert.equal((await call('getMcpOAuthLoginStatus', [begun.flowId])).state, 'pending');
  assert.equal(world.runtimes, 3);
  assert.deepEqual(await call('completeMcpOAuthLogin', [begun.flowId, CALLBACK]), {
    flowId: begun.flowId,
    state: 'complete',
  });
  assert.deepEqual(await call('getMcpOAuthLoginStatus', [begun.flowId]), { flowId: begun.flowId, state: 'complete' });
});
