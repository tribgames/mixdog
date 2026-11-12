#!/usr/bin/env node
// Recording of apps/desktop/src/main/mcp-oauth-control-session.test.mjs (b6f10295a): the MCP OAuth sign-in through the desktop's
// session-less capability path (SessionHostTransport.invokeControlResult -> the real session service -> a session runtime built on the
// real createResourceApi with a fake MCP client whose interactive connect waits for the callback). Any failed control call replaces
// the control session, so begin, status polls and the paste land on different session runtimes. The flow id is a generated value and
// is named <flow>; the session ids are compared, never recorded.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-mcp-oauth-control-session-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';
import { scriptUuids } from './lib/scripted-uuid.mjs';

const scriptedUuids = scriptUuids();
const set = openSet('mcp-oauth-control-session-cases', import.meta.url);
const { createResourceApi } = await set.load('src/session-runtime/resource-api.mjs');
const { createSessionService } = await set.load('src/standalone/session-service.mjs');
const { SessionHostTransport } = await set.load('apps/desktop/src/main/session-host-transport.ts');

const AUTH_URL = 'http://127.0.0.1:9/authorize?state=s&code_challenge_method=S256';
const CALLBACK = 'http://127.0.0.1:9/oauth/callback?code=c&state=s';
const REDIRECT_URL = 'http://127.0.0.1:9/oauth/callback';
const STATE = 's';
const { MCP_OAUTH_CALLBACK_NOT_PENDING, parsePastedMcpOAuthCallback } = await set.load('src/runtime/agent/orchestrator/mcp/oauth-callback.mjs');

function sessionRuntime(world) {
  let state = { sessionId: '', items: [], queued: [], busy: false };
  const servers = { fixture: { type: 'http', url: 'http://127.0.0.1:9/mcp' } };
  let answer;
  const api = createResourceApi({
    getConfig: () => ({ mcpServers: servers }), getSession: () => null, getCurrentCwd: () => process.cwd(), cfgMod: {}, hooks: {}, saveConfigAndAdopt: () => {},
    async connectConfiguredMcp(options) {
      let connected = false;
      if (options.login) {
        const outcome = new Promise((resolve) => { answer = resolve; });
        await options.login.openBrowser(AUTH_URL);
        connected = await outcome;
      }
      return { servers: [{ name: options.only, connected, error: null }] };
    },
    cancelMcpLogin: () => answer?.(false),
    // The pasted URL is judged by the product's own parser (the fake client has only the network to fake): the refusal sentence is Node's.
    completeMcpLogin: (_name, callbackUrl) => {
      if (!answer) throw new Error(MCP_OAUTH_CALLBACK_NOT_PENDING);
      const pasted = parsePastedMcpOAuthCallback(callbackUrl, { redirectUrl: REDIRECT_URL, state: STATE });
      answer(!pasted.denied);
    },
    clearMcpServerOAuth: async () => {}, getMcpServerOAuthState: () => ({ signedIn: false }), probeMcpServerAuth: async () => ({ auth: 'oauth' }),
    resolveMcpCatalog: () => ({ servers, adoption: null, plugins: {}, entries: {} }), invalidatePreSessionToolSurface: () => {},
    normalizeMcpServerInput: () => { throw new Error('not used'); },
    mcpStatus: () => { if (world.failNextRead) { world.failNextRead = false; throw new Error('status unavailable'); } return { servers: [] }; },
    skillsStatus: () => ({ skills: [] }), pluginsStatus: () => ({ plugins: [] }), reloadFullConfig: () => {}, awaitKeychainPrewarm: async () => {},
  });
  world.runtimes += 1;
  return { ...api, isWireSafe: true, getState: () => state, subscribe: () => () => {}, async reserveSession(id) { state = { ...state, sessionId: id }; return true; }, dispose: async () => api.disposeGlobalExtensionSubscription() };
}
function desktopTransport() {
  const world = { runtimes: 0, failNextRead: false };
  const service = createSessionService({ createSessionRuntime: async () => sessionRuntime(world) });
  const client = { list: (args) => service.listSessions?.(args), create: (args) => service.createSession(args), read: (args) => service.readSession(args), subscribe: (args) => service.subscribeSession(args), unsubscribe: (args) => service.unsubscribeSession(args), submit: async () => ({}), abort: async () => ({}), approve: async () => ({}), configure: (args) => service.configureSession(args, { revision: 1 }), close: async () => {} };
  const transport = new SessionHostTransport(client, { isDisposed: () => false, taskWorkspace: async () => process.cwd(), openHints: () => ({}), transcriptWindow: () => ({}), projection: () => undefined, applySessionResult: () => null, heldTranscript: () => null, applyTranscriptPage: () => null, deleteProjection: () => {} });
  const call = async (method, args) => transport.invokeControlResult(method, args);
  return { world, transport, call, stop: () => service.stop() };
}
let flowId;

await set.run('a remote sign-in survives the control session being replaced between begin, status polls and the paste', async () => {
  const { world, transport, call, stop } = desktopTransport();
  try {
    const out = { authUrl: AUTH_URL, callback: CALLBACK };
    out.signOut = await call('signOutMcpServer', ['fixture']);
    const begun = await call('beginMcpOAuthLogin', ['fixture', { openBrowser: false }]);
    flowId = begun.value.flowId;
    out.begun = begun;
    const beganOn = transport.controlSessionId;
    world.failNextRead = true;
    out.statusRead = await call('mcpStatus', []).then((v) => ({ value: v }), (e) => ({ threw: e }));
    out.controlSessionReplaced = transport.controlSessionId !== beganOn;
    out.runtimesAfterFailedRead = world.runtimes;
    out.statusAfterReplace = await call('getMcpOAuthLoginStatus', [begun.value.flowId]);
    out.invalidPaste = await call('completeMcpOAuthLogin', [begun.value.flowId, 'garbage']).then((v) => ({ value: v }), (e) => ({ threw: e }));
    out.statusAfterInvalidPaste = await call('getMcpOAuthLoginStatus', [begun.value.flowId]);
    out.runtimesAfterInvalidPaste = world.runtimes;
    out.correctedPaste = await call('completeMcpOAuthLogin', [begun.value.flowId, CALLBACK]);
    out.finalStatus = await call('getMcpOAuthLoginStatus', [begun.value.flowId]);
    return out;
  } finally { await stop(); }
});

await set.finish({
  entry: { runs: 'desktop SessionHostTransport.invokeControlResult -> standalone session-service.mjs createSessionService -> session-runtime/resource-api.mjs createResourceApi (the sign-in registry is real); the MCP client is fake', notRun: 'no network, no real MCP server or browser', scripted: { source: scriptedUuids.source, why: 'the daemon session ids are sess_daemon_<ms>_<uuid without dashes>' } },
  replay: { entry: 'mixdog-app-server / mixdog-mcp: the sign-in flow keeps its pending/complete state across control-session replacement; compare each result with the flow id and session ids abstracted', normalised: { flowId: 'generated by the sign-in registry; written <flow> wherever it occurs (paths listed in normalised.paths)' } },
  replaceInText: [[flowId, '<flow>']],
});
process.exit(0);
