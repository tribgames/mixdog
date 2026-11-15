// Records what the Node extension pickers do (/mcp, /skills, /plugins, /memory, /project, /resume, the MCP sign-in flow and the
// double-Esc message selector), so the Rust port (`mixdog_tui::pickers::extensions`) is checked against it
// (tests/pickers_extensions.rs).
//
// The Node code is only read: the modules are imported from <tree>/src/tui/app, nothing is written there.
//
//   node record-pickers-extensions.mjs --tree C:/Project/mixdog --write tests/goldens/pickers-extensions.json
//   node record-pickers-extensions.mjs --tree C:/Project/mixdog --check tests/goldens/pickers-extensions.json
//
// Recorded: scenarios, each a scripted store (a method's answer, a rejection `{"$throw": text}`, a sequence of answers
// `{"$seq": [...]}`, or the n-th argument `{"$echo": n}`; a method the script lacks is a method the store lacks) and a list of
// steps (open a picker, choose a row, Left/Right, a key, Esc, a prompt callback, run the poll timers). After every step the
// channels are logged apart: the store calls, the notices, the painted panels, the prompt changes, the openers called, the
// clipboard, the prompt hints, the reported errors, and the panel and prompts left on screen.
//
// A promise chain of Node settles in its own order and the Rust port makes the same calls in line, so the channels are
// compared one by one, never interleaved. The poll timers of the MCP sign-in are replaced by a queue the `wait` step drains.
//
// The packages a TypeScript-era checkout installs (react, string-width, strip-ansi, marked, chalk, wrap-ansi) are only used by
// the rendering the pickers never reach; where a tree has no node_modules they are replaced by inert stand-ins.

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
  console.error('usage: record-pickers-extensions.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
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

const epoch = await load('app/panel-epoch.mjs');
const surfaceMod = await load('app/panel-surface.mjs');
const extMod = await load('app/extension-pickers.mjs');
const loginMod = await load('app/extension-pickers/mcp-login.mjs');
const coreMod = await load('app/core-memory-picker.mjs');
const parsers = await load('app/input-parsers.mjs');
const projectMod = await load('app/project-picker.mjs');
const resumeMod = await load('app/resume-picker.mjs');
const selectorMod = await load('app/message-selector.mjs');
const fmt = await load('app/app-format.mjs');

const THEME = { success: 'success', inactive: 'inactive' };
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await flush();
};

const snapItem = (item) => ({
  value: item.value ?? null,
  label: item.label ?? null,
  marker: item.marker ?? '',
  markerColor: item.markerColor ?? null,
  meta: item.meta ?? '',
  description: item.description ?? '',
  action: item._action && item._action !== 'noop' ? item._action : null,
});
const snapPicker = (picker) =>
  picker == null
    ? null
    : {
        kind: picker._kind ?? null,
        title: picker.title ?? null,
        description: picker.description ?? '',
        loading: Boolean(picker.loading),
        help: picker.help ?? null,
        labelWidth: picker.labelWidth ?? null,
        metaWidth: picker.metaWidth ?? null,
        indexMode: picker.indexMode ?? null,
        initialIndex: picker.initialIndex ?? 0,
        adjust: typeof picker.onLeft === 'function',
        footer: typeof picker.footer === 'function' ? picker.items.map((item) => picker.footer(item)) : null,
        items: picker.items.map(snapItem),
      };
const PROMPT_FIELDS = [
  'initialValue',
  'providerName',
  'detail',
  'projectPath',
  'skillName',
  '_id',
  '_indexRevision',
  '_projectId',
  '_singleSentence',
];
const snapPrompt = (prompt) =>
  prompt == null
    ? null
    : {
        kind: prompt.kind,
        label: prompt.label ?? null,
        hint: prompt.hint ?? null,
        ...Object.fromEntries(PROMPT_FIELDS.map((key) => [key, prompt[key] ?? null])),
      };

const CHANNELS = ['calls', 'notices', 'paints', 'prompts', 'returns', 'clipboard', 'hints', 'errors', 'values'];

async function runScenario(spec) {
  epoch.supersedePanelEpoch();
  const log = Object.fromEntries(CHANNELS.map((name) => [name, []]));
  let live = null;
  let provider = null;
  let settings = null;
  let disabled = new Set(spec.disabled || []);
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn) => {
    const timer = { fn, live: true };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer) timer.live = false;
  };
  try {
    const surface = surfaceMod.createPanelSurface({
      setPicker: (next) => {
        const previous = live;
        live = typeof next === 'function' ? next(previous) : next;
        if (epoch.shouldSupersedePanelEpoch(previous, live)) epoch.supersedePanelEpoch();
        log.paints.push(snapPicker(live));
      },
      setContextPanel: () => {},
      setUsagePanel: () => {},
    });
    const store = { pushNotice: (message, tone) => log.notices.push([message, tone]), getState: () => ({ items: spec.items || [] }) };
    for (const [name, script] of Object.entries(spec.store || {})) {
      const queue = Array.isArray(script?.$seq) ? [...script.$seq] : null;
      store[name] = async (...callArgs) => {
        log.calls.push([name, ...callArgs]);
        const answer = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : script;
        if (answer && typeof answer === 'object' && '$throw' in answer) throw new Error(answer.$throw);
        if (answer && typeof answer === 'object' && '$echo' in answer) return callArgs[answer.$echo];
        return structuredClone(answer);
      };
    }
    const setProviderPrompt = (next) => {
      provider = typeof next === 'function' ? next(provider) : next;
      log.prompts.push(['provider', snapPrompt(provider)]);
    };
    const setSettingsPrompt = (next) => {
      settings = typeof next === 'function' ? next(settings) : next;
      log.prompts.push(['settings', snapPrompt(settings)]);
    };
    const setDisabledSkills = (next) => {
      disabled = typeof next === 'function' ? next(disabled) : next;
      log.calls.push(['setDisabledSkills', [...disabled]]);
    };
    const picks = extMod.createExtensionPickers({
      store,
      theme: THEME,
      clean: (value) => String(value ?? '').trim(),
      copyToClipboard: async (text) => {
        if (spec.copyFails) throw new Error(spec.copyFails);
        log.clipboard.push(text);
      },
      surface,
      getPicker: () => live,
      setProviderPrompt,
      setSettingsPrompt,
      getDisabledSkills: () => disabled,
      setDisabledSkills,
    });
    // The poll timers are driven by the `wait` step, whatever interval the module asks for.
    const login = loginMod.createMcpLogin({ store, setProviderPrompt, pollMs: 5 });
    const core = coreMod.createCoreMemoryPicker({
      store,
      surface,
      setSettingsPrompt,
      parseMemoryCoreRows: parsers.parseMemoryCoreRows,
    });
    const project = projectMod.createProjectPicker({
      state: { cwd: spec.cwd || 'C:\\current' },
      store,
      surface,
      setProviderPrompt,
      setSettingsPrompt,
      closeUsagePanel: () => {},
      projectNameFromPath: fmt.projectNameFromPath,
      pickFolder: async (options) => {
        log.calls.push(['pickFolder', options]);
        const answer = spec.pickFolder ?? { available: true, path: null };
        if (answer.$throw) throw new Error(answer.$throw);
        return answer;
      },
    });
    const resume = resumeMod.createResumePicker({
      store,
      surface,
      formatSessionUpdatedAt: fmt.formatSessionUpdatedAt,
      formatSessionMessageCount: fmt.formatSessionMessageCount,
    });
    const selector = selectorMod.useMessageSelector({
      store,
      state: { items: spec.items || [] },
      surface,
      setPromptDraftOverride: (override) => log.hints.push(['draft', override.value]),
      syncPromptLayoutRows: (text) => log.hints.push(['sync', text]),
      showPromptHint: (text, tone) => log.hints.push(['hint', text, tone]),
      clearPromptHint: () => log.hints.push(['clear']),
      installPastedImages: (images) => log.hints.push(['images', images]),
      installPastedTexts: (texts) => log.hints.push(['texts', texts]),
    });

    const itemOf = (value) => {
      const item = live?.items.find((entry) => entry.value === value);
      if (!item) throw new Error(`no row ${value}`);
      return item;
    };
    const returnTo = (options) => {
      if (!options || !('returnTo' in options)) return {};
      return { returnTo: options.returnTo ? () => log.returns.push(options.returnTo) : null };
    };
    const ops = {
      open: async (name, options) => {
        const opener = {
          'mcp-servers': () => picks.openMcpServersPicker(),
          mcp: () => picks.openMcpPicker(),
          skills: () => picks.openSkillsPicker(),
          'project-skills': () => picks.openProjectSkillsPicker(),
          plugins: () => picks.openPluginsPicker(),
          'installed-plugins': () => picks.openInstalledPluginsPicker(),
          memory: () => core.openMemoryCorePicker(returnTo(options)),
          project: () => project.openProjectPicker(options || {}),
          resume: () => resume.openResumePicker(),
        }[name];
        await opener();
      },
      select: (value) => live.onSelect(value, itemOf(value)),
      left: (value) => live.onLeft(itemOf(value)),
      right: (value) => live.onRight(itemOf(value)),
      key: (ch, value) => live.onKey(ch, {}, value == null ? null : itemOf(value)),
      cancel: () => live.onCancel(),
      skillDetail: (skill) => picks.openSkillDetailPicker(skill),
      pluginDetail: (plugin) => picks.openPluginDetailPicker(plugin),
      register: (path) => project.registerProject(path),
      enter: (path, options) => project.enterProject(path, options),
      newProject: () => project.beginNewProject(),
      login: (name) => login.loginMcpServer(name),
      logout: (name) => login.logoutMcpServer(name),
      complete: async (code) => {
        try {
          await provider.login.completeCode(code);
        } catch (error) {
          log.errors.push(error.message);
        }
      },
      failureReturn: () => provider.failureReturn(),
      promptCancel: () => provider.login.cancel(),
      wait: async () => {
        for (let round = 0; round < 20; round += 1) {
          const due = timers.filter((timer) => timer.live);
          if (due.length === 0) break;
          for (const timer of due) {
            timer.live = false;
            await timer.fn();
          }
          await settle();
        }
      },
      hasUser: () => log.values.push(selector.hasUserMessages),
      selector: () => log.values.push(selector.openMessageSelector()),
    };

    const steps = [];
    for (const [name, ...stepArgs] of spec.steps) {
      try {
        await ops[name](...stepArgs);
      } catch (error) {
        throw new Error(`step ${steps.length} ${JSON.stringify([name, ...stepArgs]).slice(0, 80)}: ${error.message}`);
      }
      await settle();
      const entry = { step: [name, ...stepArgs] };
      for (const channel of CHANNELS) {
        entry[channel] = log[channel];
        log[channel] = [];
      }
      entry.picker = snapPicker(live);
      entry.provider = snapPrompt(provider);
      entry.settings = snapPrompt(settings);
      steps.push(entry);
    }
    return { steps };
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

const SERVERS = [
  { name: 'graph', enabled: true, transport: 'stdio', status: 'ready', toolCount: 3, scope: ['a', 'b'] },
  { name: 'web', enabled: false, transport: 'http', error: 'boom' },
  { name: 'cloud', source: 'user', authRequired: true, inheritedScope: ['x'], activeHere: false },
];
const SERVERS_FLIPPED = [{ ...SERVERS[0], enabled: false }, ...SERVERS.slice(1)];
const SKILLS = [
  { name: 'docx', source: 'built-in', description: 'Word files', activeHere: false },
  { name: 'pdf', source: 'built-in', description: 'PDF files', whenToUse: 'PDF work' },
  { name: 'deploy', source: 'project', filePath: 'x/SKILL.md', inheritedScope: ['p1', 'p2'] },
];
const PLUGIN = {
  id: 'demo',
  name: 'demo',
  title: 'Demo',
  version: '1.2.0',
  sourceType: 'git',
  source: 'git',
  sourceUrl: 'https://example.test/demo',
  skillCount: 2,
  root: 'C:/plugins/demo',
  mcpScript: '.mcp.json',
  mcpServerName: 'plugin-demo',
  mcpEnabled: false,
  mcpServers: [{ name: 'plugin-demo', key: 'demo', enabled: false, serverEnabled: false, connected: false, status: 'disabled' }],
  description: 'A demo plugin',
};
const PLUGIN_ON = {
  id: 'on',
  name: 'on',
  source: 'local',
  sourceType: 'local',
  root: '/p/on',
  mcpEnabled: true,
  mcpServers: [
    { name: 'a', enabled: true, status: 'ready' },
    { name: 'b', enabled: false },
    { name: 'c', connected: true },
  ],
  mcpErrors: [{ message: 'bad' }],
  warning: 'old api',
  scope: ['one', 'two'],
  managed: false,
};
const PLUGIN_BARE = { name: 'bare', sourceType: 'local', source: 'local', root: '/p', mcpServers: [] };
const PLUGIN_LEGACY = { name: 'legacy', source: 'url', root: '/l', mcpScript: 'x', mcpServerName: 'srv', skillCount: 1 };
const MEMORY_TEXT =
  'COMMON:\nid=7 preference \u2014 preference\nid=8 legacy label \u2014 visible summary\nproj-a:\nid=9 only element\nfree text line';
const PROJECTS = [{ name: 'One', path: 'C:\\one' }, { path: 'D:\\two' }, { name: 'skipped' }];
const SESSIONS = [
  { id: 's1', updatedAt: 0, messageCount: 1, title: '  A   title ', preview: 'p' },
  { id: 's2', messageCount: 12.6, preview: 'line1\nline2' },
  { id: 's3', updatedAt: 'x', messageCount: '3' },
  { id: 's4', messageCount: 0 },
];
const TRANSCRIPT = [
  { kind: 'user', id: 1, text: 'first' },
  { kind: 'assistant', id: 2, text: 'answer' },
  { kind: 'user', id: 3, text: '  \n second line\nthird' },
  { kind: 'user', id: 4, text: 'archived one', archived: true },
  { kind: 'user', text: 'without id' },
  { kind: 'user', id: 5, text: '   ' },
  { kind: 'user', id: 6, text: 'x'.repeat(70) },
];
const LOGIN_BEGIN = { flowId: 'f1', state: 'pending', url: 'https://auth.example/authorize?x=1' };

const scenarios = [
  {
    name: 'mcp list and toggles',
    spec: {
      store: {
        mcpStatus: { $seq: [{ servers: SERVERS }, { servers: SERVERS }, { servers: SERVERS_FLIPPED }, { servers: SERVERS_FLIPPED }, { servers: SERVERS_FLIPPED }, { servers: SERVERS }] },
        setMcpServerEnabled: { ok: true },
      },
      steps: [['open', 'mcp-servers'], ['left', 'server:graph'], ['right', 'server:web'], ['select', 'server:cloud'], ['cancel']],
    },
  },
  {
    name: 'mcp toggle failure still refreshes the row',
    spec: {
      store: { mcpStatus: { servers: SERVERS }, setMcpServerEnabled: { $throw: 'denied' } },
      steps: [['open', 'mcp'], ['select', 'server:graph']],
    },
  },
  {
    name: 'mcp list without servers, with a failing status, without the method',
    spec: { store: { mcpStatus: { servers: [] } }, steps: [['open', 'mcp-servers'], ['select', 'empty'], ['left', 'empty']] },
  },
  { name: 'mcp status rejects', spec: { store: { mcpStatus: { $throw: 'offline' } }, steps: [['open', 'mcp-servers']] } },
  { name: 'mcp status method missing', spec: { store: {}, steps: [['open', 'mcp-servers']] } },
  {
    name: 'skills toggles reuse the fetched list',
    spec: {
      disabled: ['pdf'],
      store: { skillsStatus: { skills: SKILLS } },
      steps: [['open', 'skills'], ['select', 'docx'], ['left', 'docx'], ['right', 'pdf'], ['cancel']],
    },
  },
  {
    name: 'skills empty, failing, null answers',
    spec: {
      store: { skillsStatus: { $seq: [{ skills: 0 }, null, { $throw: 'down' }] } },
      steps: [['open', 'skills'], ['open', 'skills'], ['open', 'skills'], ['open', 'project-skills']],
    },
  },
  {
    name: 'skill panel enables, disables and writes a request',
    spec: {
      disabled: ['pdf'],
      store: { skillsStatus: { skills: SKILLS } },
      steps: [
        ['skillDetail', SKILLS[1]],
        ['select', 'use'],
        ['skillDetail', SKILLS[1]],
        ['select', 'enable'],
        ['skillDetail', { name: 'pdf', description: 'PDF files' }],
        ['select', 'use'],
        ['skillDetail', { name: 'bare' }],
        ['cancel'],
        ['skillDetail', { name: 'docx', description: '  Word  ', whenToUse: ' when asked ' }],
        ['select', 'disable'],
      ],
    },
  },
  {
    name: 'project skills list',
    spec: {
      store: { skillsStatus: { skills: SKILLS } },
      steps: [['open', 'project-skills'], ['select', 'deploy'], ['cancel'], ['open', 'project-skills'], ['cancel']],
    },
  },
  {
    name: 'plugins menu, installed list and panel',
    spec: {
      store: {
        pluginsStatus: { count: 4, plugins: [PLUGIN, PLUGIN_ON, PLUGIN_BARE, PLUGIN_LEGACY] },
        updatePlugin: {},
        enablePluginMcp: {},
        removePlugin: {},
        mcpStatus: { servers: [] },
      },
      steps: [
        ['open', 'plugins'],
        ['select', 'add'],
        ['open', 'plugins'],
        ['select', 'installed'],
        ['select', 'demo:1.2.0'],
        ['select', 'info'],
        ['pluginDetail', PLUGIN],
        ['select', 'copy-root'],
        ['pluginDetail', PLUGIN],
        ['select', 'copy-mcp-name'],
        ['pluginDetail', PLUGIN],
        ['select', 'update'],
        ['pluginDetail', PLUGIN],
        ['select', 'enable-mcp'],
        ['pluginDetail', PLUGIN_ON],
        ['select', 'info'],
        ['pluginDetail', PLUGIN_ON],
        ['select', 'enable-mcp'],
        ['pluginDetail', PLUGIN_ON],
        ['select', 'uninstall'],
        ['pluginDetail', PLUGIN_BARE],
        ['select', 'enable-mcp'],
        ['pluginDetail', PLUGIN_LEGACY],
        ['select', 'info'],
        ['pluginDetail', PLUGIN_BARE],
        ['cancel'],
        ['cancel'],
        ['cancel'],
      ],
    },
  },
  {
    name: 'plugin writes fail or are missing, copy fails',
    spec: {
      copyFails: 'no clipboard',
      store: { pluginsStatus: { count: 0, plugins: [] }, updatePlugin: { $throw: 'nope' }, removePlugin: { $throw: 'busy' } },
      steps: [
        ['open', 'installed-plugins'],
        ['pluginDetail', PLUGIN],
        ['select', 'update'],
        ['pluginDetail', PLUGIN],
        ['select', 'enable-mcp'],
        ['pluginDetail', PLUGIN],
        ['select', 'uninstall'],
        ['pluginDetail', PLUGIN],
        ['select', 'copy-root'],
      ],
    },
  },
  {
    name: 'plugins status rejects',
    spec: { store: { pluginsStatus: { $throw: 'gone' } }, steps: [['open', 'plugins'], ['open', 'installed-plugins']] },
  },
  {
    name: 'memory root, list, entry panel and prompts, Esc targets',
    spec: {
      store: { memoryControl: MEMORY_TEXT },
      steps: [
        ['open', 'memory', { returnTo: 'settings' }],
        ['select', 'core-add'],
        ['open', 'memory', {}],
        ['select', 'core-list'],
        ['select', 'core-common-7'],
        ['select', 'edit'],
        ['open', 'memory', {}],
        ['select', 'core-list'],
        ['select', 'core-common-8'],
        ['cancel'],
        ['select', 'core-common-8'],
        ['select', 'delete'],
        ['open', 'memory', {}],
        ['select', 'core-list'],
        ['select', 'core-5'],
        ['cancel'],
        ['cancel'],
        ['open', 'memory', { returnTo: null }],
        ['cancel'],
        ['open', 'memory', {}],
        ['select', 'core-list'],
        ['select', 'core-proj-a-9'],
        ['select', 'edit'],
      ],
    },
  },
  {
    name: 'memory empty answer, rejection, missing method',
    spec: {
      store: { memoryControl: { $seq: ['', { $throw: 'offline' }] } },
      steps: [['open', 'memory'], ['select', 'core-list'], ['select', 'empty'], ['cancel'], ['open', 'memory']],
    },
  },
  { name: 'memory store without the method', spec: { store: {}, steps: [['open', 'memory'], ['cancel']] } },
  {
    name: 'project list, enter, shortcut',
    spec: {
      cwd: 'C:\\current',
      store: { listProjects: PROJECTS, setCwd: { $echo: 0 }, addProject: { name: 'Added' } },
      steps: [
        ['open', 'project', { initialEntry: true }],
        ['select', '__use_current__'],
        ['open', 'project'],
        ['select', 'C:\\one'],
        ['open', 'project'],
        ['select', 'D:\\two'],
        ['open', 'project'],
        ['cancel'],
      ],
    },
  },
  {
    name: 'project list failure, non-list answer, missing method',
    spec: {
      store: { listProjects: { $seq: [{ $throw: 'service down' }, { not: 'a list' }] } },
      steps: [['open', 'project'], ['open', 'project', { initialEntry: true }]],
    },
  },
  {
    name: 'project create through the folder dialog',
    spec: {
      pickFolder: { available: true, path: 'C:\\chosen' },
      store: { listProjects: PROJECTS, addProject: { name: 'Added' } },
      steps: [['open', 'project'], ['key', 'c', null], ['key', 'C', 'C:\\one']],
    },
  },
  {
    name: 'project create cancelled dialog',
    spec: { pickFolder: { available: true, path: null }, store: { listProjects: PROJECTS }, steps: [['open', 'project'], ['newProject']] },
  },
  {
    name: 'project create without a dialog falls back to typing',
    spec: {
      pickFolder: { available: false, reason: 'install zenity' },
      store: { listProjects: PROJECTS },
      steps: [['open', 'project'], ['key', 'c', null]],
    },
  },
  {
    name: 'project create with a failing dialog',
    spec: { pickFolder: { $throw: 'boom' }, store: { listProjects: PROJECTS }, steps: [['open', 'project'], ['newProject']] },
  },
  {
    name: 'project rename',
    spec: {
      store: { listProjects: PROJECTS },
      steps: [['open', 'project'], ['key', 'r', '__use_current__'], ['key', 'r', 'C:\\one'], ['open', 'project'], ['key', 'R', 'D:\\two'], ['open', 'project'], ['key', 'x', 'D:\\two']],
    },
  },
  {
    name: 'register and enter refuse blanks and report failures',
    spec: {
      store: { listProjects: PROJECTS, addProject: { $seq: [{ $throw: 'exists' }, { name: 'Z' }, {}] }, setCwd: { $seq: [{ $throw: 'missing dir' }, 'C:\\resolved', null] } },
      steps: [
        ['register', '  '],
        ['enter', ''],
        ['register', ' C:\\z '],
        ['register', 'C:\\z'],
        ['enter', 'C:\\z', {}],
        ['enter', 'C:\\z', {}],
        ['enter', 'C:\\z\\', { notice: false, register: false }],
      ],
    },
  },
  {
    name: 'project service methods missing',
    spec: { store: {}, steps: [['open', 'project'], ['register', 'C:\\z'], ['enter', 'C:\\z', {}]] },
  },
  {
    name: 'resume list and choose',
    spec: {
      store: { listSessions: SESSIONS, resume: { $seq: [true, false, { $throw: 'locked' }] } },
      steps: [['open', 'resume'], ['select', 's1'], ['open', 'resume'], ['select', 's2'], ['open', 'resume'], ['select', 's4'], ['open', 'resume'], ['cancel']],
    },
  },
  {
    name: 'resume with no chats, failing list, missing method',
    spec: { store: { listSessions: { $seq: [[], { $throw: 'io' }, null] } }, steps: [['open', 'resume'], ['open', 'resume'], ['open', 'resume']] },
  },
  {
    name: 'mcp sign-in polls to completion',
    spec: {
      store: { beginMcpOAuthLogin: LOGIN_BEGIN, getMcpOAuthLoginStatus: { $seq: [{ state: 'pending' }, { state: 'complete' }] }, cancelMcpOAuthLogin: {} },
      steps: [['login', 'srv'], ['wait']],
    },
  },
  {
    name: 'mcp sign-in endings',
    spec: {
      store: {
        beginMcpOAuthLogin: { $seq: [LOGIN_BEGIN, LOGIN_BEGIN, LOGIN_BEGIN, { flowId: 'f4', state: 'complete' }, null, { $throw: 'no browser' }] },
        getMcpOAuthLoginStatus: { $seq: [{ state: 'failed', error: 'denied' }, { state: 'cancelled' }, { $throw: 'lost' }] },
      },
      steps: [['login', 'a'], ['wait'], ['login', 'b'], ['wait'], ['login', 'c'], ['wait'], ['login', 'd'], ['login', 'e'], ['login', 'f']],
    },
  },
  {
    name: 'mcp sign-in by pasting the redirect address',
    spec: {
      store: {
        beginMcpOAuthLogin: LOGIN_BEGIN,
        getMcpOAuthLoginStatus: { state: 'pending' },
        completeMcpOAuthLogin: { $seq: [{ $throw: 'invalid redirect address' }, { state: 'failed', error: 'bad code' }, { state: 'failed' }, { state: 'complete' }] },
        cancelMcpOAuthLogin: {},
      },
      steps: [['login', 'srv'], ['complete', 'http://localhost/cb?code=zzz'], ['failureReturn'], ['complete', 'x'], ['complete', 'y'], ['complete', 'http://localhost/cb?code=ok'], ['wait']],
    },
  },
  {
    name: 'mcp sign-in restarted, cancelled, signed out',
    spec: {
      store: {
        beginMcpOAuthLogin: { $seq: [LOGIN_BEGIN, { flowId: 'f2', state: 'pending' }] },
        getMcpOAuthLoginStatus: { state: 'pending' },
        cancelMcpOAuthLogin: {},
        signOutMcpServer: { $seq: [{}, { $throw: 'gone' }] },
      },
      steps: [['login', 'one'], ['login', 'two'], ['promptCancel'], ['logout', 'one'], ['logout', 'two']],
    },
  },
  {
    name: 'message selector rewinds',
    spec: {
      items: TRANSCRIPT,
      store: { rewindToItem: { $seq: [{ text: 'restored text', pastedImages: { 1: { sizeBytes: 3 } }, pastedTexts: { 2: 'folded' }, notice: 'files not restored' }, {}, { text: 'plain' }, { $throw: 'engine busy' }] } },
      steps: [['hasUser'], ['selector'], ['select', '1'], ['selector'], ['select', '3'], ['selector'], ['select', '6'], ['selector'], ['select', '6'], ['selector'], ['cancel']],
    },
  },
  {
    name: 'message selector with nothing to jump to',
    spec: { items: [{ kind: 'user', text: ' ' }, { kind: 'assistant', text: 'hi' }], store: {}, steps: [['hasUser'], ['selector']] },
  },
  {
    name: 'message selector keeps the newest twenty',
    spec: {
      items: Array.from({ length: 25 }, (_, index) => ({ kind: 'user', id: index, text: `message ${index}` })),
      store: { rewindToItem: {} },
      steps: [['selector'], ['select', '24']],
    },
  },
];

const out = { generated: 'tests/recorders/record-pickers-extensions.mjs', scenarios: [] };
for (const { name, spec } of scenarios) {
  let result;
  try {
    result = await runScenario(spec);
  } catch (error) {
    throw new Error(`scenario "${name}": ${error.message}`);
  }
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
