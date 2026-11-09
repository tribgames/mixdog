// Inputs and the flow harness shared by record.mjs (which runs them against Node's TUI modules at b6f10295a) and the
// tests that replay the recorded results against this tree's modules.

// Provider setup rows: whether the welcome hint counts a provider as usable and how the setup footer marks it.
export const PROVIDER_ROWS = [
  { id: 'openai', type: 'api-key', enabled: true, authenticated: true, stored: true, env: false },
  { id: 'anthropic', type: 'api-key', enabled: true, authenticated: false, stored: false, env: false },
  { id: 'gemini', type: 'api-key', enabled: false, authenticated: false, stored: false, env: false },
  { id: 'deepseek', type: 'api-key', enabled: true, authenticated: true, stored: false, env: true },
  { id: 'anthropic-oauth', type: 'oauth', enabled: true, authenticated: true, usable: true, reauthRequired: false },
  { id: 'grok-oauth', type: 'oauth', enabled: true, authenticated: true, usable: false, reauthRequired: false },
  { id: 'openai-oauth', type: 'oauth', enabled: false, authenticated: false, usable: false, reauthRequired: true },
  { id: 'cursor-oauth', type: 'oauth', enabled: true, authenticated: false, usable: false, reauthRequired: true },
  { id: 'mixdog-local', type: 'local', enabled: true, detected: true, authenticated: true, usable: true },
  { id: 'mixdog-local', type: 'local', enabled: false, detected: true, authenticated: true, usable: false },
  { id: 'mixdog-local', type: 'local', enabled: true, detected: false, authenticated: false, usable: false },
];

export const setupWith = (row) => ({
  api: row.type === 'api-key' ? [row] : [],
  oauth: row.type === 'oauth' ? [row] : [],
  local: row.type === 'local' ? [row] : [],
});

// The `/mcp login` flow: the runtime's sign-in actions are stubs; what is observed is the prompt the flow opens and the
// notices it posts.
const CALLBACK = 'http://127.0.0.1:1/oauth/callback?code=c&state=s';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const MCP_FLOWS = [
  {
    name: 'a pasted callback posts exactly one sign-in completion notice',
    runtime() {
      let flowState = 'pending';
      return {
        beginMcpOAuthLogin: async () => ({ flowId: 'mcp_oauth_1', state: 'pending', url: 'https://auth.example/a' }),
        getMcpOAuthLoginStatus: (flowId) => ({ flowId, state: flowState }),
        cancelMcpOAuthLogin: async (flowId) => ({ flowId, state: 'cancelled' }),
        completeMcpOAuthLogin: async (flowId) => {
          flowState = 'complete';
          return { flowId, state: 'complete' };
        },
      };
    },
    async drive({ login, ctx, submitProviderPrompt, prompt }) {
      await login.loginMcpServer('srv');
      const opened = prompt();
      const accepted = submitProviderPrompt(ctx, opened, CALLBACK);
      await sleep(40);
      return { opened: opened?.kind ?? null, accepted, promptAfter: prompt() };
    },
  },
  {
    name: 'a sign-in completed by stored tokens posts exactly one completion notice',
    runtime: () => ({
      beginMcpOAuthLogin: async () => ({ flowId: 'mcp_oauth_2', state: 'complete' }),
      getMcpOAuthLoginStatus: () => {
        throw new Error('no flow to poll');
      },
      cancelMcpOAuthLogin: async () => {
        throw new Error('nothing to cancel');
      },
      completeMcpOAuthLogin: async () => {
        throw new Error('nothing to paste');
      },
    }),
    async drive({ login, prompt }) {
      await login.loginMcpServer('srv');
      await sleep(20);
      return { promptAfter: prompt() };
    },
  },
  {
    name: 'a flow the status poll sees complete posts one completion notice and closes the prompt',
    runtime() {
      let polls = 0;
      return {
        beginMcpOAuthLogin: async () => ({ flowId: 'mcp_oauth_3', state: 'pending', url: 'https://auth.example/c' }),
        getMcpOAuthLoginStatus: (flowId) => ({ flowId, state: ++polls >= 2 ? 'complete' : 'pending' }),
        cancelMcpOAuthLogin: async (flowId) => ({ flowId, state: 'cancelled' }),
        completeMcpOAuthLogin: async (flowId) => ({ flowId, state: 'complete' }),
      };
    },
    async drive({ login, prompt }) {
      await login.loginMcpServer('srv');
      const opened = prompt();
      await sleep(60);
      return { opened: opened?.kind ?? null, promptAfter: prompt() };
    },
  },
  {
    name: 'a failed sign-in start posts its failure and opens no prompt',
    runtime: () => ({
      beginMcpOAuthLogin: async () => {
        throw new Error('server refused');
      },
      getMcpOAuthLoginStatus: () => ({}),
      cancelMcpOAuthLogin: async () => ({}),
      completeMcpOAuthLogin: async () => ({}),
    }),
    async drive({ login, prompt }) {
      await login.loginMcpServer('srv');
      await sleep(20);
      return { promptAfter: prompt() };
    },
  },
];

/** Runs one flow against a `createMcpLogin` and a `submitProviderPrompt`; `makeStore` adds the runtime's actions. */
export async function runMcpFlow(flow, { createMcpLogin, submitProviderPrompt, makeStore }) {
  const notices = [];
  const pushNotice = (text, level) => notices.push([text, level]);
  const store = makeStore(flow.runtime(), pushNotice);
  let prompt = null;
  const setProviderPrompt = (next) => {
    prompt = typeof next === 'function' ? next(prompt) : next;
  };
  const login = createMcpLogin({ store, setProviderPrompt, pollMs: 5 });
  const ctx = {
    state: { commandBusy: false, stats: {} },
    store,
    oauthSubmitRef: { current: false },
    setProviderPrompt,
    clearModelCaches: () => {},
    openPanel: () => notices.push(['(a provider picker opened)', 'x']),
  };
  const observed = await flow.drive({ login, ctx, submitProviderPrompt, prompt: () => prompt });
  return { ...observed, ...('promptAfter' in observed ? { promptAfter: observed.promptAfter?.kind ?? null } : {}), notices };
}
