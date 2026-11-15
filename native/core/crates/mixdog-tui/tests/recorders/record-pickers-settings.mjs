// Records what the Node settings pickers do (Settings, Update, Auto-clear, Profile, Developer), so the Rust port
// (`mixdog_tui::pickers::settings`) is checked against it (tests/pickers_settings.rs).
//
// The Node code is only read: the modules are imported from <tree>/src/tui/app, nothing is written there.
//
//   node record-pickers-settings.mjs --tree C:/Project/mixdog --write tests/goldens/pickers-settings.json
//   node record-pickers-settings.mjs --tree C:/Project/mixdog --check tests/goldens/pickers-settings.json
//
// A scenario is a list of steps (open a picker, press a key on a row) over a scripted store; what is recorded is the event log
// of the store calls, notices, openers of other pickers, text-entry prompts and model-cache clears, and the panel on screen
// after every step. The store's answers are promises in Node and plain results in Rust; every step is followed by flushes, so
// the events of a step settle in the order the Rust code makes them.
//
// A store answer in a scenario is a JSON value, `{ "$throw": text }`, or `{ "$seq": [answer, ...] }` (each call takes the next,
// the last one repeats). The theme calls are synchronous in Node (the TUI owns the themes), the others return promises.
//
// The voice row reads the managed runtime's config in Node, so the recorder points MIXDOG_HOME at a folder that does not exist
// and the row records Off; the voice toggle is not recorded (the Rust port routes it through the core).
//
// The packages a TypeScript-era checkout installs (react, string-width, strip-ansi, marked, chalk, wrap-ansi) are only used by
// the rendering the pickers never reach; where a tree has no node_modules they are replaced by inert stand-ins, except
// wrap-ansi, which the Developer warning needs: the stand-in wraps at word boundaries the way the real one does.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { setImmediate as flush } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
if (!tree || (!option('--write') && !option('--check'))) {
  console.error('usage: record-pickers-settings.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}
process.env.MIXDOG_HOME = join(dirname(fileURLToPath(import.meta.url)), 'no-such-mixdog-home');
delete process.env.MIXDOG_DATA_DIR;

const STUBS = {
  react:
    'export const useState=()=>[],useEffect=()=>{},useRef=()=>({}),useCallback=f=>f,useMemo=f=>f(),useLayoutEffect=()=>{},useContext=()=>({}),createContext=()=>({}),createElement=()=>null,memo=f=>f,forwardRef=f=>f,Fragment=null;export default {};',
  'string-width': 'export default s=>[...String(s)].length;',
  'strip-ansi': 'export default s=>String(s);',
  marked: 'export const marked={lexer:()=>[],setOptions(){},use(){}};',
  chalk:
    'const p=()=>new Proxy(function(s){return String(s)},{get:(t,k)=>k==="level"?0:p(),apply:(t,th,a)=>String(a[0])});export class Chalk{constructor(){return p()}};export default p();',
  'wrap-ansi':
    'export default (text, width) => String(text).split("\\n").map((line) => { const out = []; let row = ""; for (const word of line.split(" ")) { if (row && row.length + 1 + word.length > width) { out.push(row); row = word; } else row = row ? row + " " + word : word; } out.push(row); return out.join("\\n"); }).join("\\n");',
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
  const file = join(tree, 'src', path);
  sources.push({ path: `src/${path}`, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
  return import(pathToFileURL(file).href);
};

const surfaceMod = await load('tui/app/panel-surface.mjs');
const epochMod = await load('tui/app/panel-epoch.mjs');
const settingsMod = await load('tui/app/settings-picker.mjs');
const maintenanceMod = await load('tui/app/maintenance-pickers.mjs');
const formatMod = await load('tui/app/app-format.mjs');
const themeMod = await load('tui/app/theme-effort-pickers.mjs');
const timeMod = await load('tui/time-format.mjs');
const modelDisplayMod = await load('runtime/shared/model-display.mjs');
await load('tui/app/settings-picker/settings-toggles.mjs');
await load('tui/app/settings-picker/settings-navigation.mjs');
await load('tui/app/settings-picker/settings-rows.mjs');
await load('tui/app/maintenance-pickers/update-picker.mjs');
await load('tui/app/maintenance-pickers/auto-clear-picker.mjs');
await load('tui/app/maintenance-pickers/profile-picker.mjs');
await load('tui/app/maintenance-pickers/developer-picker.mjs');

const STATE = { model: 'gpt-5', provider: 'openai', workflow: { id: 'default' } };
const SNAPSHOT = {
  autoClear: { enabled: true, idleMs: 60 * 60_000, provider: 'openai' },
  compaction: { auto: true },
  toolModules: { webSearch: { enabled: true }, memory: { enabled: false } },
  systemShell: { source: 'config', command: 'pwsh', effective: 'pwsh -NoLogo' },
  outputStyle: { current: { id: 'simple', label: 'Simple' } },
  webSearchRoute: { provider: 'openai', model: 'gpt-web' },
  profile: { title: 'Jay', languageEntry: { label: 'Korean' }, experienceLevelEntry: { label: 'Vibe coder' } },
  mcp: { connectedCount: 1, configuredCount: 2, failedCount: 1 },
  plugins: { count: 3 },
  skills: { count: 12 },
  updateSettings: { currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true },
};
const THEMES = [
  { id: 'dawn', label: 'Dawn' },
  { id: 'dusk', label: 'Dusk' },
];
const OAUTH_RISK_WARNING =
  'Using this provider through OAuth carries a high risk of penalties such as account restrictions.';
const developerView = (values) => ({
  sections: [
    {
      id: 'providers',
      label: 'Providers',
      options: [
        {
          id: 'cursorOAuth',
          label: 'Cursor',
          description: 'Cursor description.',
          warning: OAUTH_RISK_WARNING,
          provider: 'cursor-oauth',
          enabled: values.cursorOAuth,
        },
      ],
    },
    {
      id: 'diagnostics',
      label: 'Diagnostics',
      options: [
        { id: 'traceWire', label: 'Trace wire', description: 'Trace wire description.', enabled: values.traceWire },
        { id: 'verbose', label: 'Verbose', description: 'Verbose description.', enabled: values.verbose },
      ],
    },
  ],
});
const AUTO_CLEAR = {
  enabled: true,
  idleMs: 30 * 60_000,
  provider: 'openai',
  providerDefaults: [
    { provider: 'openai', idleMs: 30 * 60_000, builtInMs: 60 * 60_000, custom: true },
    { provider: 'anthropic', idleMs: 60 * 60_000, builtInMs: 60 * 60_000 },
    { provider: 'local', idleMs: 90_000, builtInMs: 0, builtInUnlimited: true, unlimited: false },
  ],
};
const PROFILE = {
  title: 'Jay',
  language: 'ko',
  experienceLevel: 'vibe-coder',
  languages: [
    { id: 'system', label: 'System (locale)' },
    { id: 'ko', label: 'Korean' },
    { id: 'en', label: 'English' },
  ],
};
const thrown = (text) => ({ $throw: text });
const seq = (...answers) => ({ $seq: answers });

const SETTINGS_ROWS = [
  'model',
  'websearch',
  'workflow',
  'output-style',
  'profile',
  'theme',
  'autoclear',
  'providers',
  'mcp',
  'plugins',
  'skills',
  'memory',
  'developer',
  'update',
];

const scenarios = [];
const scenario = (name, spec) => scenarios.push({ name, spec });

scenario('settings rows', {
  kind: 'settings',
  store: { getSettingsSnapshot: SNAPSHOT, getTheme: 'dusk', listThemes: THEMES },
  steps: [{ open: 'settings', options: {} }],
});
scenario('settings rows of a bare snapshot', {
  kind: 'settings',
  store: { getSettingsSnapshot: {} },
  steps: [{ open: 'settings', options: {} }],
});
scenario('settings rows with overrides and a disabled auto-clear', {
  kind: 'settings',
  store: {
    getSettingsSnapshot: {
      ...SNAPSHOT,
      autoClear: { enabled: false, idleMs: 1, providerCustom: true, provider: 'openai' },
      toolModules: { webSearch: { enabled: false }, memory: { enabled: true } },
      compaction: { auto: false },
      mcp: { connectedCount: 0, configuredCount: 0, failedCount: 0 },
      systemShell: { source: 'auto', command: '', effective: '' },
      updateSettings: { currentVersion: '1.1.0', latestVersion: '1.1.0', updateAvailable: false },
      profile: {},
      outputStyle: { configured: 'compact' },
    },
    getTheme: 'unknown',
    listThemes: THEMES,
  },
  steps: [{ open: 'settings', options: { focus: 'theme' } }],
});
scenario('settings unlimited auto-clear with a global override', {
  kind: 'settings',
  store: {
    getSettingsSnapshot: { ...SNAPSHOT, autoClear: { enabled: true, unlimited: true, custom: true, idleMs: 0 } },
    getTheme: 'dawn',
    listThemes: THEMES,
  },
  steps: [{ open: 'settings', options: {} }],
});
scenario('settings arrows write through the store and refresh the panel', {
  kind: 'settings',
  store: {
    getSettingsSnapshot: SNAPSHOT,
    getTheme: 'dusk',
    listThemes: THEMES,
    setAutoClear: { enabled: false },
    setCompactionSettings: { auto: false },
    setWebSearchEnabled: true,
    setMemoryToolsEnabled: true,
  },
  steps: [
    { open: 'settings', options: {} },
    { left: 'autoclear' },
    { right: 'autocompact' },
    { select: 'web-search-enabled' },
    { left: 'memory-enabled' },
  ],
});
scenario('settings writes that answer nothing or fail', {
  kind: 'settings',
  store: {
    getSettingsSnapshot: SNAPSHOT,
    getTheme: 'dusk',
    listThemes: THEMES,
    setAutoClear: null,
    setCompactionSettings: false,
    setWebSearchEnabled: thrown('denied'),
  },
  steps: [
    { open: 'settings', options: {} },
    { left: 'autoclear' },
    { right: 'autocompact' },
    { select: 'web-search-enabled' },
    { left: 'memory-enabled' },
  ],
});
scenario('settings cyclers step with wrap-around', {
  kind: 'settings',
  store: {
    getSettingsSnapshot: SNAPSHOT,
    getTheme: 'dusk',
    listThemes: THEMES,
    listOutputStyles: { current: { id: 'simple' }, styles: [{ id: 'default' }, { id: 'simple' }] },
    setOutputStyle: { current: { id: 'default' } },
    listWorkflows: [{ id: 'default', active: true }, { id: 'review' }],
    setWorkflow: { id: 'review' },
    setTheme: { id: 'dawn', label: 'Dawn' },
  },
  steps: [
    { open: 'settings', options: {} },
    { right: 'output-style' },
    { left: 'workflow' },
    { right: 'theme' },
    { left: 'theme' },
  ],
});
scenario('settings cyclers that find nothing or fail', {
  kind: 'settings',
  store: {
    getSettingsSnapshot: SNAPSHOT,
    getTheme: 'dusk',
    listThemes: [],
    listOutputStyles: { styles: [] },
    listWorkflows: [],
  },
  steps: [{ open: 'settings', options: {} }, { right: 'output-style' }, { right: 'workflow' }, { right: 'theme' }],
});
scenario('settings cyclers whose write answers nothing or throws', {
  kind: 'settings',
  store: {
    getSettingsSnapshot: SNAPSHOT,
    getTheme: 'dusk',
    listThemes: THEMES,
    listOutputStyles: { styles: [{ id: 'default' }] },
    setOutputStyle: null,
    listWorkflows: [{ id: 'default' }],
    setWorkflow: thrown('offline'),
  },
  steps: [{ open: 'settings', options: {} }, { right: 'output-style' }, { right: 'workflow' }],
});
scenario('settings Enter routes to the owning picker', {
  kind: 'settings',
  store: { getSettingsSnapshot: SNAPSHOT, getTheme: 'dusk', listThemes: THEMES },
  steps: [
    { open: 'settings', options: {} },
    ...SETTINGS_ROWS.map((value) => ({ select: value })),
    { select: 'system-shell' },
  ],
});
scenario('settings Esc closes and leaves nothing', {
  kind: 'settings',
  store: { getSettingsSnapshot: SNAPSHOT, getTheme: 'dusk', listThemes: THEMES },
  steps: [{ open: 'settings', options: {} }, { cancel: true }],
});
scenario('settings snapshot failure is a notice', {
  kind: 'settings',
  store: { getSettingsSnapshot: thrown('daemon away') },
  steps: [{ open: 'settings', options: {} }],
});

const updateStore = (extra = {}) => ({
  getUpdateSettings: { currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true },
  getUpdateStatus: { phase: 'idle' },
  checkForUpdate: null,
  ...extra,
});
scenario('update panel and the auto-update toggle', {
  kind: 'maintenance',
  store: updateStore({ setAutoUpdate: null }),
  steps: [{ open: 'update', options: {} }, { select: 'auto-update' }, { select: 'latest' }],
});
scenario('update now reports the installed version', {
  kind: 'maintenance',
  store: updateStore({
    getUpdateStatus: seq({ phase: 'idle' }, { phase: 'idle' }, { phase: 'installed', version: '1.1.0' }),
    runUpdateNow: { ok: true, version: '1.1.0' },
  }),
  steps: [
    { open: 'update', options: { returnTo: true } },
    { confirm: 'update-now' },
    { confirm: 'update-now' },
    { cancel: true },
  ],
});
scenario('update failures are notices', {
  kind: 'maintenance',
  store: updateStore({
    getUpdateSettings: thrown('offline'),
    getUpdateStatus: { phase: 'installing' },
    checkForUpdate: thrown('no network'),
    setAutoUpdate: thrown('denied'),
    runUpdateNow: { ok: false, error: 'disk full' },
  }),
  steps: [{ open: 'update', options: {} }, { select: 'auto-update' }, { select: 'latest' }, { confirm: 'update-now' }],
});
scenario('update run that throws', {
  kind: 'maintenance',
  store: updateStore({ runUpdateNow: thrown('boom') }),
  steps: [{ open: 'update', options: {} }, { confirm: 'update-now' }],
});
scenario('auto-clear panel, arrows, Advanced and the provider editor', {
  kind: 'maintenance',
  store: {
    getAutoClear: seq(AUTO_CLEAR, { ...AUTO_CLEAR, enabled: false }),
    setAutoClear: { ...AUTO_CLEAR, enabled: false },
  },
  steps: [
    { open: 'autoclear', options: { returnTo: true } },
    { left: 'toggle' },
    { select: 'advanced' },
    { select: 'provider:openai' },
  ],
});
scenario('auto-clear Advanced back and the unlimited provider default', {
  kind: 'maintenance',
  store: { getAutoClear: AUTO_CLEAR },
  steps: [
    { open: 'autoclear', options: { advanced: true } },
    { select: 'provider:local' },
  ],
});
scenario('auto-clear writes that answer nothing, fail or report unlimited', {
  kind: 'maintenance',
  store: {
    getAutoClear: AUTO_CLEAR,
    setAutoClear: seq(null, thrown('locked'), { enabled: true, unlimited: true }, { enabled: true, idleMs: 600_000 }),
  },
  steps: [
    { open: 'autoclear', options: {} },
    { right: 'toggle' },
    { right: 'toggle' },
    { select: 'toggle' },
    { select: 'toggle' },
    { select: 'advanced' },
    { cancel: true },
    { cancel: true },
  ],
});
scenario('auto-clear that cannot be read', {
  kind: 'maintenance',
  store: { getAutoClear: thrown('away') },
  steps: [{ open: 'autoclear', options: {} }, { select: 'advanced' }],
});
scenario('profile rows, cycles and the title prompt', {
  kind: 'maintenance',
  store: { getProfile: PROFILE, setProfile: null },
  steps: [
    { open: 'profile', options: {} },
    { right: 'language' },
    { left: 'experience-level' },
    { select: 'language' },
    { select: 'experience-level' },
    { select: 'title' },
  ],
});
scenario('profile with nothing set cycles from the ends', {
  kind: 'maintenance',
  store: { getProfile: {}, setProfile: null },
  steps: [{ open: 'profile', options: {} }, { left: 'experience-level' }, { right: 'experience-level' }],
});
scenario('profile write failure and Esc back', {
  kind: 'maintenance',
  store: { getProfile: PROFILE, setProfile: thrown('rejected') },
  steps: [{ open: 'profile', options: { returnTo: true } }, { right: 'language' }, { cancel: true }],
});
const developerValues = { cursorOAuth: false, traceWire: false, verbose: true };
scenario('developer sections, options and the warning confirmation', {
  kind: 'maintenance',
  store: {
    getDeveloperSettings: seq(
      developerView(developerValues),
      developerView(developerValues),
      developerView({ ...developerValues, traceWire: true }),
      developerView(developerValues)
    ),
    setDeveloperOption: { ok: true },
  },
  steps: [
    { open: 'developer', options: { returnTo: true } },
    { select: 'diagnostics' },
    { right: 'traceWire' },
    { select: 'traceWire' },
    { left: 'traceWire' },
    { cancel: true },
    { cancel: true },
  ],
});
scenario('developer warning accepted and cancelled', {
  kind: 'maintenance',
  store: { getDeveloperSettings: developerView(developerValues), setDeveloperOption: { ok: true } },
  steps: [
    { open: 'developer', options: {} },
    { select: 'providers' },
    { right: 'cursorOAuth' },
    { select: 'cancel' },
    { select: 'cursorOAuth' },
    { cancel: true },
    { right: 'cursorOAuth' },
    { select: 'accept' },
  ],
});
scenario('developer write that answers nothing or fails, and unreadable settings', {
  kind: 'maintenance',
  store: {
    getDeveloperSettings: developerView(developerValues),
    setDeveloperOption: seq(null, thrown('locked')),
  },
  steps: [
    { open: 'developer', options: {} },
    { select: 'diagnostics' },
    { right: 'traceWire' },
    { right: 'verbose' },
    { left: 'verbose' },
  ],
});
scenario('developer settings that cannot be read', {
  kind: 'maintenance',
  store: { getDeveloperSettings: thrown('away') },
  steps: [{ open: 'developer', options: {} }],
});

// ------------------------------------------------------------------ harness

const clone = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

const panelOut = (panel) =>
  panel
    ? {
        title: panel.title ?? '',
        description: panel.description ?? '',
        help: panel.help ?? null,
        indexMode: panel.indexMode ?? null,
        labelWidth: panel.labelWidth ?? null,
        metaWidth: panel.metaWidth ?? null,
        initialIndex: panel.initialIndex ?? null,
        loading: panel.loading === true,
        items: (panel.items || []).map((item) => [
          item.value,
          item.label ?? '',
          item.meta ?? '',
          item.description ?? '',
          item.marker ?? '',
        ]),
        footer: (panel.footer || []).map((line) => [line.glyph ?? '', line.text ?? '']),
        confirm: (panel.confirmBar?.buttons || []).map((button) => button.label),
      }
    : null;

// The opener options with the functions Node passed named by what they open.
const optionsOut = (options) => {
  const out = {};
  for (const [key, value] of Object.entries(options || {})) out[key] = typeof value === 'function' ? 'settings' : value;
  return out;
};

const promptOut = (prompt) => {
  const out = {};
  for (const [key, value] of Object.entries(prompt)) out[key] = typeof value === 'function' ? true : value;
  return out;
};

async function runScenario(spec) {
  epochMod.supersedePanelEpoch();
  const events = [];
  const log = (...event) => events.push(clone(event));
  let live = null;
  const surface = surfaceMod.createPanelSurface({
    setPicker: (next) => {
      const previous = live;
      live = typeof next === 'function' ? next(previous) : next;
      if (epochMod.shouldSupersedePanelEpoch(previous, live)) epochMod.supersedePanelEpoch();
    },
    setContextPanel: () => {},
    setUsagePanel: () => {},
  });
  const cursors = new Map();
  const answer = (value) => {
    if (value && typeof value === 'object' && '$throw' in value) throw new Error(value.$throw);
    return clone(value);
  };
  const scripted = (action) => {
    const raw = spec.store[action];
    if (raw && typeof raw === 'object' && '$seq' in raw) {
      const at = cursors.get(action) ?? 0;
      cursors.set(action, at + 1);
      return raw.$seq[Math.min(at, raw.$seq.length - 1)];
    }
    return raw;
  };
  const SYNC = new Set(['getTheme', 'listThemes', 'setTheme']);
  const store = { pushNotice: (text, tone) => log('notice', text, tone) };
  for (const action of Object.keys(spec.store)) {
    store[action] = (...callArgs) => {
      log('call', action, callArgs);
      if (SYNC.has(action)) return answer(scripted(action));
      return (async () => answer(scripted(action)))();
    };
  }
  const opener = (name) => (options) => {
    log('open', name, optionsOut(options));
  };
  const returnTo = () => log('returnTo');
  const common = {
    store,
    surface,
    setProviderPrompt: () => {},
    setSettingsPrompt: (prompt) => {
      if (prompt) log('prompt', promptOut(prompt));
    },
    formatDuration: timeMod.formatDuration,
  };
  let openers;
  if (spec.kind === 'settings') {
    const { openSettingsPicker } = settingsMod.createSettingsPicker({
      ...common,
      state: STATE,
      settingsHeavyCacheRef: { current: null },
      settingsRequestRef: { current: 0 },
      settingsLiveRefreshRef: { current: null },
      displayModelName: modelDisplayMod.displayModelName,
      routeModelLabel: (route) => (route ? `${route.model}@${route.provider}` : '(unset)'),
      workflowDisplayName: formatMod.workflowDisplayName,
      workflowSwitchNotice: formatMod.workflowSwitchNotice,
      themeNotice: themeMod.themeNotice,
      openModelPicker: opener('model'),
      openWebSearchPicker: opener('websearch'),
      openWorkflowPicker: opener('workflow'),
      openOutputStylePicker: opener('output-style'),
      openProviderSetupPicker: opener('providers'),
      openThemePicker: opener('theme'),
      openAutoClearPicker: opener('autoclear'),
      openProfilePicker: opener('profile'),
      openMcpPicker: opener('mcp'),
      openPluginsPicker: opener('plugins'),
      openSkillsPicker: opener('skills'),
      openMemoryCorePicker: opener('memory'),
      openUpdatePicker: opener('update'),
      openDeveloperPicker: opener('developer'),
    });
    openers = { settings: openSettingsPicker };
  } else {
    const pickers = maintenanceMod.createMaintenancePickers({
      ...common,
      theme: { success: 'green' },
      closeUsagePanel: () => {},
      clearModelCaches: (scope) => log('clearModelCaches', scope),
    });
    openers = {
      update: pickers.openUpdatePicker,
      autoclear: pickers.openAutoClearPicker,
      profile: pickers.openProfilePicker,
      developer: pickers.openDeveloperPicker,
    };
  }
  const settle = async () => {
    for (let i = 0; i < 12; i += 1) await flush();
  };
  const rows = [];
  for (const step of spec.steps) {
    if (step.open) {
      const options = { ...(step.options || {}) };
      if (options.returnTo) options.returnTo = returnTo;
      await openers[step.open](options);
    } else if (!live) {
      log('error', 'no panel for', step);
    } else {
      const find = (value) => live.items.find((item) => item.value === value);
      if ('left' in step) live.onLeft(find(step.left));
      else if ('right' in step) live.onRight(find(step.right));
      else if ('select' in step) live.onSelect(step.select, find(step.select));
      else if ('confirm' in step) live.confirmBar.onConfirm({ value: step.confirm });
      else if ('cancel' in step) live.onCancel();
    }
    await settle();
    rows.push(panelOut(live));
  }
  return { events, panels: rows };
}

const out = { state: STATE, scenarios: [] };
for (const { name, spec } of scenarios) {
  const result = await runScenario(spec);
  out.scenarios.push({ name, spec, ...result });
}
out.sources = sources;

const text = `{\n${Object.entries(out)
  .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
  .join(',\n')}\n}\n`;
const target = option('--write') ?? option('--check');
if (option('--write')) {
  writeFileSync(target, text);
  console.log(`wrote ${target} (${text.length} bytes, ${out.scenarios.length} scenarios)`);
} else {
  const recorded = readFileSync(target, 'utf8');
  if (recorded.replace(/\r\n/g, '\n') !== text) {
    console.error(`${target} differs from what the Node code does now: re-record it with --write`);
    process.exit(1);
  }
  console.log(`${target} matches (${out.scenarios.length} scenarios)`);
}
