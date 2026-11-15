// Records what the Node provider setup picker and the first-run onboarding wizard do, so the Rust port
// (`mixdog_tui::pickers::provider`) is checked against it (tests/pickers_provider.rs).
//
// The Node code is only read: the modules are imported from <tree>/src/tui/app, nothing is written there.
//
//   node record-pickers-provider.mjs --tree C:/Project/mixdog --write tests/goldens/pickers-provider.json
//   node record-pickers-provider.mjs --tree C:/Project/mixdog --check tests/goldens/pickers-provider.json
//
// Recorded:
//  * scenarios - the event log of scripted flows (open the picker, select a row, Esc, a sign-in settling, the wizard steps)
//                driven by a recording fake store: every panel painted (title, description, detail, key, help, initial index,
//                rows, the footer of the highlighted row, the confirm bar), every store call, notice, prompt, cache clear and
//                opener call, in the order they happen;
//  * labels    - the answers of model-options.mjs the wizard uses (normalizeModelOptions, modelDescription, agentModelParts),
//                which the Rust test hands to the port as its model labels.
//
// A store answer is a promise in Node and a plain result in Rust; every step is followed by a flush, so the events of a step
// settle in the order the Rust code makes them. The browser is never opened: the one scenario step that would reach
// openInBrowser (the key console row) is left out.
//
// The packages a TypeScript-era checkout installs (react, string-width, strip-ansi, marked, chalk, wrap-ansi) are only used by
// the rendering the provider code never reaches; where a tree has no node_modules they are replaced by inert stand-ins.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { setImmediate as flush } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
if (!tree || (!option('--write') && !option('--check'))) {
  console.error('usage: record-pickers-provider.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}

const STUBS = {
  react:
    'export const useState=()=>[],useEffect=()=>{},useRef=()=>({}),useCallback=f=>f,useMemo=f=>f(),useLayoutEffect=()=>{},useContext=()=>({}),createContext=()=>({}),createElement=()=>null,memo=f=>f,forwardRef=f=>f,Fragment=null;export default {};',
  'string-width': 'export default s=>[...String(s)].length;',
  'strip-ansi': 'export default s=>String(s);',
  marked: 'export const marked={lexer:()=>[],setOptions(){},use(){}};',
  chalk:
    'const p=()=>new Proxy(function(s){return String(s)},{get:(t,k)=>k==="level"?0:p(),apply:(t,th,a)=>String(a[0])});export class Chalk{constructor(){return p()}};export default p();',
  'wrap-ansi': 'export default s=>String(s);',
};
const hooks = `
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND' && STUBS[spec]) return { url: 'stub:' + spec, shortCircuit: true };
    throw e;
  }
}
export async function load(url, ctx, next) {
  if (url.startsWith('stub:')) return { format: 'module', source: STUBS[url.slice(5)], shortCircuit: true };
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

const sources = [];
const load = async (path) => {
  const file = join(tree, 'src/tui', path);
  sources.push({ path: `src/tui/${path}`, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
  return import(pathToFileURL(file).href);
};

const epochMod = await load('app/panel-epoch.mjs');
const surfaceMod = await load('app/panel-surface.mjs');
const pickerMod = await load('app/provider-setup-picker.mjs');
const stepsMod = await load('app/onboarding-steps.mjs');
const modelMod = await load('app/model-options.mjs');
const startMod = await load('app/use-onboarding-start.mjs');

const { shouldSupersedePanelEpoch, supersedePanelEpoch } = epochMod;

// ---------------------------------------------------------------- summaries

const footerOf = (panel) => {
  const footer = panel.footer;
  const lines = typeof footer === 'function' ? footer(panel.items[panel.initialIndex || 0]) : footer;
  return Array.isArray(lines) ? lines.map((line) => [line.glyph || '', line.text || '']) : [];
};

const panelSummary = (panel) => {
  if (!panel) return null;
  const out = {
    title: panel.title || '',
    description: panel.description || '',
    detail: panel.detail || '',
    pickerKey: panel.pickerKey || '',
    help: panel.help || '',
    initialIndex: panel.initialIndex || 0,
    items: panel.items.map((item) => {
      const row = {
        value: item.value,
        label: item.label || '',
        meta: item.meta || '',
        description: item.description || '',
        marker: item.marker || '',
      };
      if (item.metaParts) row.metaParts = item.metaParts.map((part) => [part.text, part.width]);
      return row;
    }),
    footer: footerOf(panel),
    confirm: panel.confirmBar ? panel.confirmBar.buttons.map((button) => [button.value, button.label]) : null,
  };
  return out;
};

const promptSummary = (prompt) => {
  if (!prompt) return null;
  const out = {};
  for (const key of ['kind', 'label', 'hint', 'providerId', 'providerName', 'mode', 'envName', 'source', 'keyUrl', 'authMode', 'detail']) {
    if (prompt[key] !== undefined && prompt[key] !== '') out[key] = prompt[key];
  }
  for (const key of ['afterSave', 'successReturn', 'failureReturn', 'cancelReturn', 'login']) {
    if (prompt[key]) out[key] = true;
  }
  return out;
};

const routeKey = (route) =>
  route ? [route.provider, route.model, route.effort ?? '', route.fast ? '1' : ''].join('|') : '';

// ---------------------------------------------------------------- the model labels the wizard uses

const GPT5 = { provider: 'openai', model: 'gpt-5' };
const CLAUDE_HIGH = { provider: 'anthropic', model: 'claude-sonnet-4', effort: 'high' };
const WS_DEFAULT = { provider: 'default', model: 'default' };
const MODELS = [
  { provider: 'openai', id: 'gpt-5', description: 'flagship', fastCapable: true },
  { provider: 'anthropic', id: 'claude-sonnet-4' },
];
const SEARCH_MODELS = [{ provider: 'openai', id: 'gpt-5-search' }];

const labels = {
  normalize: [MODELS, SEARCH_MODELS, []].map((input) => [input, modelMod.normalizeModelOptions(input)]),
  descriptions: [...MODELS, ...SEARCH_MODELS].map((model) => [`${model.provider}:${model.id}`, modelMod.modelDescription(model)]),
  parts: [null, GPT5, CLAUDE_HIGH, WS_DEFAULT, { provider: 'openai', model: 'gpt-5-search' }, { provider: 'anthropic', model: 'claude-sonnet-4' }].map(
    (route) => [routeKey(route), modelMod.agentModelParts(route).map((part) => [part.text, part.width])]
  ),
  ranks: ['openai', 'openai-api', 'anthropic-oauth', 'opencode-go', 'vertex-ai', 'zz', 'yy', 'mixdog-local'].map((id) => [id, modelMod.providerDisplayRank(id)]),
};

// ---------------------------------------------------------------- the scenarios

const SETUP = {
  api: [
    { id: 'openai', name: 'OpenAI', authenticated: true, stored: true, envName: 'OPENAI_API_KEY' },
    { id: 'opencode-go', name: 'OpenCode Go', authenticated: false, url: 'https://opencode.ai/keys' },
  ],
  oauth: [{ id: 'anthropic-oauth', name: 'Anthropic', authenticated: false }],
  local: [],
};
const VERTEX = { ...SETUP, api: [{ id: 'vertex-ai', name: 'Vertex AI', authenticated: false }] };
const MANAGED = {
  ...SETUP,
  managedByClient: true,
  local: [{ id: 'mixdog-local', name: 'Local Provider', detected: true, enabled: true, usable: true }],
};
const ROSTER = [{ id: 'researcher', label: 'Researcher', description: 'digs' }, { id: 'coder' }];

// store: action -> { ok } | { err } (a list answers the calls one after another, the last one repeating).
const SCENARIOS = [
  {
    name: 'main list with a return target, Esc prefers onCancel',
    store: { getProviderSetup: { ok: SETUP } },
    steps: [['open', { returnTo: 'model', onCancel: 'agents' }], ['highlight', 'api:openai'], ['cancel']],
  },
  {
    name: 'main list: Esc falls back to returnTo; continue row runs onContinue',
    store: { getProviderSetup: { ok: SETUP } },
    steps: [['open', { returnTo: 'model' }], ['cancel'], ['open', { returnTo: 'model', onContinue: 'workflow' }], ['select', 'continue-setup']],
  },
  {
    name: 'API-key actions, remembered row, key prompt',
    store: { getProviderSetup: { ok: SETUP } },
    steps: [
      ['open', {}],
      ['select', 'api:openai'],
      ['cancel'],
      ['select', 'api:opencode-go'],
      ['select', 'set-key'],
      ['open', { returnTo: 'model' }],
      ['select', 'api:openai'],
      ['select', 'set-key'],
    ],
  },
  {
    name: 'Vertex AI asks for the key type',
    store: { getProviderSetup: { ok: VERTEX } },
    steps: [
      ['open', {}],
      ['select', 'api:vertex-ai'],
      ['select', 'set-key'],
      ['select', 'api-key'],
      ['open', {}],
      ['select', 'api:vertex-ai'],
      ['select', 'set-key'],
      ['select', 'service-account'],
    ],
  },
  {
    name: 'forget-key: the ack clears caches and reopens; a failure returns to the actions',
    store: { getProviderSetup: { ok: SETUP }, forgetProviderAuth: [{ ok: null }, { err: 'boom' }] },
    steps: [['open', {}], ['select', 'api:openai'], ['select', 'forget-key'], ['select', 'api:openai'], ['select', 'forget-key']],
  },
  {
    name: 'blocking OAuth login: progress, then the result panel, and the failure path',
    store: { getProviderSetup: { ok: SETUP }, loginOAuthProvider: [{ ok: null }, { err: 'denied' }] },
    steps: [
      ['open', {}],
      ['select', 'oauth:anthropic-oauth'],
      ['select', 'login-oauth'],
      ['select', 'success'],
      ['select', 'oauth:anthropic-oauth'],
      ['select', 'login-oauth'],
      ['select', 'back'],
    ],
  },
  {
    name: 'interactive OAuth with a code: the prompt, the callback result',
    browser: 'headless',
    store: { getProviderSetup: { ok: SETUP }, beginOAuthProviderLogin: { ok: { manualUrl: 'https://example.test/auth', manualCode: true } } },
    steps: [['open', { returnTo: 'model' }], ['select', 'oauth:anthropic-oauth'], ['select', 'login-oauth'], ['settle', 'complete'], ['afterSave']],
  },
  {
    name: 'interactive OAuth: the code prompt callbacks',
    browser: 'desktop',
    store: { getProviderSetup: { ok: SETUP }, beginOAuthProviderLogin: { ok: { url: 'https://example.test/authorize', manualCode: true } } },
    steps: [
      ['open', {}],
      ['select', 'oauth:anthropic-oauth'],
      ['select', 'login-oauth'],
      ['codeSuccess'],
      ['select', 'success'],
      ['select', 'oauth:anthropic-oauth'],
      ['select', 'login-oauth'],
      ['codeFailure', 'bad code'],
      ['select', 'back'],
      ['select', 'login-oauth'],
      ['codeCancel'],
    ],
  },
  {
    name: 'headless URL-only sign-in shows the URL, settles',
    browser: 'headless',
    store: { getProviderSetup: { ok: SETUP }, beginOAuthProviderLogin: { ok: { url: 'https://example.test/poll' } } },
    steps: [['open', {}], ['select', 'oauth:anthropic-oauth'], ['select', 'login-oauth'], ['settle', 'complete'], ['select', 'success']],
  },
  {
    name: 'device code with the warning; Back turns the late result into a notice',
    browser: 'desktop',
    store: { getProviderSetup: { ok: SETUP }, beginOAuthProviderLogin: { ok: { url: 'https://example.test/device', userCode: 'ABCD-1234' } } },
    steps: [['open', {}], ['select', 'oauth:anthropic-oauth'], ['select', 'login-oauth'], ['select', 'back'], ['settle', 'complete']],
  },
  {
    name: 'a failed callback shows the failure',
    browser: 'headless',
    store: { getProviderSetup: { ok: SETUP }, beginOAuthProviderLogin: { ok: { url: 'https://example.test/poll' } } },
    steps: [['open', {}], ['select', 'oauth:anthropic-oauth'], ['select', 'login-oauth'], ['settle', 'fail', 'denied'], ['select', 'back']],
  },
  {
    name: 'a callback that resolves with nothing changes nothing',
    browser: 'headless',
    store: { getProviderSetup: { ok: SETUP }, beginOAuthProviderLogin: { ok: { url: 'https://example.test/poll' } } },
    steps: [['open', {}], ['select', 'oauth:anthropic-oauth'], ['select', 'login-oauth'], ['settle', 'empty'], ['select', 'back']],
  },
  {
    name: 'a failed begin returns to the actions',
    browser: 'headless',
    store: { getProviderSetup: { ok: SETUP }, beginOAuthProviderLogin: { err: 'no flow' } },
    steps: [['open', {}], ['select', 'oauth:anthropic-oauth'], ['select', 'login-oauth']],
  },
  {
    name: 'a provider fetch failure leaves the loading panel',
    store: { getProviderSetup: { err: 'offline' } },
    steps: [['open', {}], ['cancel']],
  },
  {
    name: 'client-managed providers are read-only and refresh from the desktop',
    store: { getProviderSetup: [{ ok: MANAGED }, { ok: { managedByClient: true, unavailable: true, api: [], oauth: [], local: [] } }] },
    steps: [['open', {}], ['select', 'api:openai'], ['select', 'oauth:anthropic-oauth'], ['select', 'local:mixdog-local'], ['select', 'refresh-client-providers']],
  },
  {
    name: 'wizard Step 1 preloads the setup; Next opens Step 2; the roster and routes show',
    store: { getProviderSetup: { ok: SETUP }, listProviderModels: { ok: MODELS }, listAgents: { ok: ROSTER } },
    steps: [['wizard', 'auth'], ['confirm', 'next'], ['state']],
  },
  {
    name: 'wizard Step 2 role pickers: Main, Web Search, an agent, Default',
    store: {
      getProviderSetup: { ok: SETUP },
      listProviderModels: { ok: MODELS },
      listAgents: { ok: ROSTER },
      listWebSearchModels: { ok: SEARCH_MODELS },
    },
    steps: [
      ['wizard', 'models'],
      ['select', 'main-model'],
      ['select', 'openai:gpt-5'],
      ['select', 'web-search-model'],
      ['select', '__default__'],
      ['select', 'web-search-model'],
      ['select', 'openai:gpt-5-search'],
      ['select', 'agent:researcher'],
      ['select', 'anthropic:claude-sonnet-4'],
      ['select', 'agent:researcher'],
      ['select', '__default__'],
      ['state'],
      ['confirm', 'back'],
    ],
  },
  {
    name: 'wizard with no models goes back to Step 1',
    store: { getProviderSetup: { ok: SETUP }, listProviderModels: { ok: [] }, listAgents: { ok: [] } },
    steps: [['wizard', 'models']],
  },
  {
    name: 'wizard Step 2 Esc is a confirmed skip',
    store: { getProviderSetup: { ok: SETUP }, listProviderModels: { ok: MODELS }, listAgents: { ok: ROSTER }, skipOnboarding: { ok: null } },
    steps: [['wizard', 'models'], ['cancel']],
  },
  {
    name: 'wizard theme and output style steps chain to finish',
    store: {
      getProviderSetup: { ok: SETUP },
      listProviderModels: { ok: MODELS },
      listAgents: { ok: ROSTER },
      completeOnboarding: { ok: null },
      skipOnboarding: { ok: null },
    },
    steps: [
      ['wizard', 'models'],
      ['select', 'main-model'],
      ['select', 'openai:gpt-5'],
      ['confirm', 'next'],
      ['wizard', 'themeAdvance'],
      ['wizard', 'styleBack'],
      ['wizard', 'themeAdvance'],
      ['wizard', 'styleAdvance'],
    ],
  },
  {
    name: 'finish with nothing configured only marks onboarding done; a save failure is reported',
    store: { skipOnboarding: { ok: null }, completeOnboarding: { err: 'disk full' } },
    steps: [['wizard', 'finish'], ['pick', { defaultRoute: GPT5 }], ['wizard', 'finish'], ['wizard', 'skip']],
  },
];

// ---------------------------------------------------------------- the driver

function withBrowserEnv(kind, fn) {
  const keys = ['SSH_TTY', 'SSH_CONNECTION', 'DISPLAY', 'WAYLAND_DISPLAY'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  if (kind === 'headless') process.env.SSH_CONNECTION = '10.0.0.1 1 10.0.0.2 22';
  else process.env.DISPLAY = ':0';
  return fn().finally(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

// The loading frame waits one timer turn before the fetch, so a step settles over real timer turns too.
const settle = async () => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 4));
    for (let j = 0; j < 4; j += 1) await flush();
  }
};

async function runScenario(scenario) {
  supersedePanelEpoch();
  const log = [];
  let live = null;
  const surface = surfaceMod.createPanelSurface({
    setPicker: (next) => {
      const previous = live;
      live = typeof next === 'function' ? next(previous) : next;
      if (shouldSupersedePanelEpoch(previous, live)) supersedePanelEpoch();
      log.push(['panel', panelSummary(live)]);
    },
    setContextPanel: () => log.push(['clearContext']),
    setUsagePanel: () => {},
  });
  const callbacks = {};
  let prompt = null;
  const answers = {};
  const store = { pushNotice: (message, tone) => log.push(['notice', String(message), tone]) };
  const callbackGate = {};
  for (const [name, reply] of Object.entries(scenario.store)) {
    answers[name] = Array.isArray(reply) ? [...reply] : [reply];
    store[name] = async (...callArgs) => {
      // A call made with a trailing `undefined` is the call without it.
      const logged = [...callArgs];
      while (logged.length > 0 && logged.at(-1) === undefined) logged.pop();
      log.push(['call', name, JSON.parse(JSON.stringify(logged))]);
      const queue = answers[name];
      const answer = queue.length > 1 ? queue.shift() : queue[0];
      if (answer.err !== undefined) throw new Error(answer.err);
      if (name === 'beginOAuthProviderLogin') {
        const spec = answer.ok;
        const started = { ...spec };
        delete started.manualCode;
        if (spec.manualCode) started.completeCode = async () => {};
        started.waitForCallback = new Promise((resolve, reject) => {
          callbackGate.resolve = resolve;
          callbackGate.reject = reject;
        });
        return started;
      }
      return answer.ok;
    };
  }
  const onboardingRef = { current: { defaultRoute: null, webSearchRoute: null, agentRoutes: {}, agents: [], providerModels: [] } };
  const providerModelsCacheRef = {
    get current() {
      return { models: [], at: 0 };
    },
    set current(value) {
      log.push(['modelsCache', Array.isArray(value.models) ? value.models.length : -1]);
    },
  };
  const named = (name) => () => log.push(['open', name, {}]);
  const optionsOf = (spec) => {
    const options = {};
    if (spec.returnTo) options.returnTo = named(spec.returnTo);
    if (spec.onContinue) options.onContinue = named(spec.onContinue);
    if (spec.onCancel) options.onCancel = named(spec.onCancel);
    return options;
  };
  const { openProviderSetupPicker } = pickerMod.createProviderSetupPicker({
    store,
    surface,
    setProviderPrompt: (next) => {
      if (next) prompt = next;
      log.push(['prompt', 'provider', promptSummary(next)]);
    },
    setSettingsPrompt: (next) => log.push(['prompt', 'settings', promptSummary(next)]),
    closeUsagePanel: () => log.push(['closeUsage']),
    oauthSubmitRef: { current: false },
    clearModelCaches: (scope) => log.push(['clearCaches', scope]),
  });
  const steps = stepsMod.createOnboardingSteps({
    store,
    surface,
    setProviderPrompt: (next) => {
      if (next) prompt = next;
      log.push(['prompt', 'provider', promptSummary(next)]);
    },
    setSettingsPrompt: (next) => log.push(['prompt', 'settings', promptSummary(next)]),
    setOnboardingActive: (value) => log.push(['active', value]),
    onboardingRef,
    providerModelsCacheRef,
    onboardingPrefetchSeqRef: { current: 0 },
    openProviderSetupPicker,
    openThemePicker: (options) => {
      callbacks.theme = options.onboarding;
      log.push(['open', 'theme', { onboarding: options.onboarding.isLastStep ? { isLastStep: true } : {} }]);
    },
    openOutputStylePicker: (options) => {
      callbacks.style = options.onboarding;
      log.push(['open', 'outputstyle', { onboarding: options.onboarding.isLastStep ? { isLastStep: true } : {} }]);
    },
  });

  const run = async () => {
    for (const step of scenario.steps) {
      const [kind, a, b] = step;
      if (kind === 'open') await openProviderSetupPicker(optionsOf(a));
      else if (kind === 'select') {
        const item = live?.items.find((entry) => entry.value === a);
        if (!item) throw new Error(`${scenario.name}: no row ${a} in panel ${live?.title}`);
        live.onSelect(item.value, item);
      } else if (kind === 'cancel') live.onCancel();
      else if (kind === 'highlight') {
        const item = live.items.find((entry) => entry.value === a);
        live.onHighlight?.(item.value, item);
      } else if (kind === 'confirm') live.confirmBar.onConfirm({ value: a });
      else if (kind === 'settle') {
        if (a === 'complete') callbackGate.resolve({ ok: true });
        else if (a === 'empty') callbackGate.resolve(null);
        else callbackGate.reject(new Error(b));
      } else if (kind === 'afterSave') prompt.afterSave?.();
      else if (kind === 'codeSuccess') prompt.successReturn();
      else if (kind === 'codeFailure') prompt.failureReturn(new Error(a));
      else if (kind === 'codeCancel') prompt.cancelReturn();
      else if (kind === 'wizard') {
        if (a === 'auth') await steps.openOnboardingAuthStep();
        else if (a === 'models') await steps.openOnboardingWorkflowStep();
        else if (a === 'themeAdvance') callbacks.theme.onAdvance();
        else if (a === 'themeBack') callbacks.theme.onBack();
        else if (a === 'styleBack') callbacks.style.onBack();
        else if (a === 'styleAdvance') callbacks.style.onAdvance();
        else if (a === 'finish') steps.finishOnboarding();
        else if (a === 'skip') steps.onboardingWarnReopen();
      } else if (kind === 'pick') Object.assign(onboardingRef.current, a);
      else if (kind === 'state') {
        const { defaultRoute, webSearchRoute, agentRoutes } = onboardingRef.current;
        log.push(['state', { defaultRoute, webSearchRoute, agentRoutes }]);
      }
      await settle();
    }
  };
  if (scenario.browser) await withBrowserEnv(scenario.browser, run);
  else await run();
  return log;
}

const scenarios = [];
for (const scenario of SCENARIOS) {
  scenarios.push({
    name: scenario.name,
    browser: scenario.browser || null,
    store: scenario.store,
    steps: scenario.steps,
    log: await runScenario(scenario),
  });
}

// The first-run gate: the verdict the launcher resolved, or what the store's status probe reads. A promise (a daemon-backed
// store answers any method it does not implement with an async call) and anything unreadable count as completed.
const GATE_CASES = [
  { verdict: true },
  { verdict: false },
  { status: { completed: true } },
  { status: { completed: false } },
  { status: { completed: 'yes' } },
  { status: null },
  { status: 'text' },
  { status: { $promise: { completed: false } } },
  { throws: true },
  { noMethod: true },
];
const gate = GATE_CASES.map((entry) => {
  const store = {};
  if (entry.throws) {
    store.getOnboardingStatus = () => {
      throw new Error('unreadable');
    };
  } else if (!entry.noMethod && 'status' in entry) {
    store.getOnboardingStatus = () =>
      entry.status && entry.status.$promise ? Promise.resolve(entry.status.$promise) : entry.status;
  }
  return { ...entry, resolved: startMod.resolveOnboardingCompleted(store, entry.verdict) };
});

const out = { sources, labels, gate, scenarios };
const text = `${JSON.stringify(out, null, 1)}\n`;
const write = option('--write');
if (write) {
  writeFileSync(write, text);
  console.log(`wrote ${write}`);
} else {
  const golden = readFileSync(option('--check'), 'utf8');
  if (golden !== text) {
    console.error('the recording differs from the golden');
    process.exit(1);
  }
  console.log('the recording matches the golden');
}
process.exit(0);
