// Records what the Node slash commands, palettes, argument parsers, prompt submit and slash dispatch do, so the Rust port
// (`mixdog_tui::slash`) is checked against it (tests/slash_twin.rs).
//
// The Node code is only read: the modules are imported from <tree>/src/tui/app, nothing is written there.
//
//   node record-slash.mjs --tree C:/Project/mixdog --write tests/goldens/slash.json
//   node record-slash.mjs --tree C:/Project/mixdog --check tests/goldens/slash.json
//
// Recorded:
//  * registry - SLASH_COMMANDS, and the pure helpers over it: slashQuery, slashCommandMatches, the palette of every prefix of
//               every command and alias, normalizeSlashCommandName, slashCommandTokenForPaletteAccept, slashArgumentHint,
//               recognisedSlashToken, recognisedAgentRoomSlash, overlayBlocksGlobalTranscriptScroll;
//  * skills   - skillMentionQuery at every caret of a corpus of drafts, skillMentionItems, completeSkillMention and
//               deriveSlashPalette with skills, with and without a caret, dismissed or not;
//  * parsers  - parseMcpServerInput, parseSkillInput, parseMemoryCommand, parseMemoryCoreRows, memoryCoreResultErrorText and
//               the text-entry policy over argument corpora;
//  * scenarios- the event log (store calls, notices, opener calls, surface paints, prompt changes) of runSlashCommand, of
//               createPromptSubmit (provider and settings prompts, slash lines, chat with pasted images and texts), of the
//               Tab workflow cycle and of the setup `open` request, driven by a recording fake store whose answers each
//               scenario scripts.
//
// The store's answers are promises in Node and plain results in Rust; every scenario step is followed by a flush, so the
// events of a step settle in the order the Rust code makes them, except the paste-holder events of a submitted slash line,
// which Node logs before the answer of an asynchronous command: they are kept in their own channel (`paste`).
//
// The packages a TypeScript-era checkout installs (react, string-width, strip-ansi, marked, chalk, wrap-ansi) are only used by
// the rendering the slash code never reaches; where a tree has no node_modules they are replaced by inert stand-ins.

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
  console.error('usage: record-slash.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
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

const commandsMod = await load('app/slash-commands.mjs');
const mentionMod = await load('app/skill-mention-palette.mjs');
const paletteMod = await load('app/slash-palette.mjs');
const parsersMod = await load('app/input-parsers.mjs');
const policyMod = await load('app/text-entry-policy.mjs');
const surfaceMod = await load('app/panel-surface.mjs');
const epochMod = await load('app/panel-epoch.mjs');
const dispatchMod = await load('app/slash-dispatch.mjs');
const submitMod = await load('app/prompt-submit.mjs');
const cycleMod = await load('app/workflow-cycle.mjs');
const uiOpenMod = await load('app/use-ui-open-request.mjs');
const formatMod = await load('app/app-format.mjs');
const styleMod = await load('app/route-pickers/output-style-picker.mjs');
const themeMod = await load('app/theme-effort-pickers.mjs');
const timeMod = await load('time-format.mjs');

const { SLASH_COMMANDS } = commandsMod;
const out = {};

// ---------------------------------------------------------------- registry

const registryRow = (command) => ({
  name: command.name,
  usage: command.usage,
  aliases: command.aliases,
  aliasUsage: command.aliasUsage,
  showAliasUsage: command.showAliasUsage,
  params: command.params,
  description: command.description,
});
const tokens = [...new Set(SLASH_COMMANDS.flatMap((command) => [command.name, ...(command.aliases || [])]))];
const prefixesOf = (token) => Array.from({ length: token.length + 1 }, (_, n) => token.slice(0, n));

const items = (list) =>
  list.map((item) => (item.kind === 'skill' ? { kind: 'skill', name: item.name, label: item.label, description: item.description } : { name: item.name }));
const paletteOut = (p) => ({ query: p.activeSlashQuery, items: items(p.slashCommands), open: p.slashPaletteOpen, kind: p.paletteKind });

const prefixPalette = [];
for (const token of tokens) {
  for (const prefix of prefixesOf(token)) {
    for (const spelled of new Set([prefix, prefix.toUpperCase()])) {
      const draft = `/${spelled}`;
      prefixPalette.push({ draft, out: paletteOut(paletteMod.deriveSlashPalette({ promptDraft: draft, slashDismissedFor: '' })) });
    }
  }
}
const drafts = ['', '/', '/a', '/A b', '/model ', ' /x', '/x\ty', '//', '/\u00e9', '/\u00a0x', '/q', '/zzz', 'plain', '/model x'];
const suppress = [
  {},
  { providerPrompt: true },
  { settingsPrompt: true },
  { toolApproval: true },
  { contextPanel: true },
  { usagePanel: true },
  { picker: true },
  { exiting: true },
  { commandBusy: true },
];
const suppressed = [];
for (const draft of drafts) {
  for (const flags of suppress) {
    for (const dismissed of ['', draft]) {
      suppressed.push({ draft, flags, dismissed, out: paletteOut(paletteMod.deriveSlashPalette({ promptDraft: draft, slashDismissedFor: dismissed, ...flags })) });
    }
  }
}
const acceptDrafts = ['', '/', '/n', '/ne', '/new', '/NEW', '/new x', ' /new ', '/clear', '/CLEAR', '/projects', '/Q', '/exit now', 'x'];
const hintDrafts = [
  ...tokens.flatMap((t) => [`/${t} `, `/${t.toUpperCase()} `, `/${t}`, `/${t} x `, `/${t}\n`, `/${t}  `]),
  '',
  '/',
  '/ ',
  '/model  ',
  '/nope ',
];
const recognisedTexts = [
  '/new',
  '  /NEW now',
  '/usr/bin/x',
  '/',
  '',
  'plain',
  '\n/compact\nx',
  '/clear',
  '/Clear x',
  '/exit',
  '/q',
  '/settings',
  '/config',
  '/bogus',
  ...tokens.map((t) => `/${t} arg`),
];
const overlayFlags = ['slashPaletteOpen', 'picker', 'toolApproval', 'contextPanel', 'usagePanel', 'btwPanel', 'providerPrompt', 'settingsPrompt'];
const overlays = [];
for (let mask = 0; mask < 1 << overlayFlags.length; mask += 1) {
  const owner = {};
  overlayFlags.forEach((flag, index) => {
    if (mask & (1 << index)) owner[flag] = true;
  });
  overlays.push({ owner, out: commandsMod.overlayBlocksGlobalTranscriptScroll(owner) });
}
out.registry = {
  commands: SLASH_COMMANDS.map(registryRow),
  normalize: [...tokens, 'NEW', 'Projects', 'nope', '', 'Q', 'OutputStyle', 'output-style'].map((token) => ({ token, out: commandsMod.normalizeSlashCommandName(token) })),
  normalizeNullish: [null, undefined, 0, false].map((token) => commandsMod.normalizeSlashCommandName(token)),
  slashQuery: drafts.map((draft) => ({ draft, out: commandsMod.slashQuery(draft) })),
  matches: SLASH_COMMANDS.flatMap((command) =>
    ['', 'c', 'CL', 'ne', 'n', 'q', 'ex', 'set', 'conf', 'zz'].map((query) => ({ command: command.name, query, out: commandsMod.slashCommandMatches(command, query) }))
  ),
  prefixPalette,
  suppressed,
  accept: SLASH_COMMANDS.flatMap((command) =>
    acceptDrafts.map((draft) => ({ command: command.name, draft, out: commandsMod.slashCommandTokenForPaletteAccept(command, draft) }))
  ),
  hints: hintDrafts.map((draft) => ({ draft, out: commandsMod.slashArgumentHint(draft) })),
  recognised: recognisedTexts.map((text) => ({ text, token: commandsMod.recognisedSlashToken(text), room: commandsMod.recognisedAgentRoomSlash(text) })),
  overlays,
};

// ------------------------------------------------------------------ skills

const SKILLS = [
  { name: 'pdf-tools', description: 'PDF work', source: 'global', enabled: true },
  { name: 'deploy', description: 'Ship it', source: 'global', enabled: true },
  { name: 'report-pdf', description: 'Reports', source: 'plugin', enabled: true },
  { name: 'pdf-off', description: 'Disabled', source: 'global', enabled: false },
  { name: 'pdf', description: 'Built-in', source: 'builtin', enabled: true },
  { name: 'pdf-elsewhere', source: 'global', enabled: true, activeHere: false },
  { name: 'pdf-here', source: 'plugin', enabled: true, activeHere: true },
  { name: 'path', source: 'global', enabled: true },
  { name: '300', source: 'global', enabled: true },
  { name: 'Zeta', description: 'upper', source: 'global', enabled: true },
  { name: 'alpha-pdf', description: '', source: 'global', enabled: true },
  { name: 'ndeploy-pdf', source: 'global' },
  { name: '', source: 'global', enabled: true },
];
const mentionDrafts = [
  '',
  '$',
  'use $pd',
  'see ("$dep',
  'plain',
  'a$pd',
  'me@$pd',
  '$pd ',
  '$Pd',
  '$-x',
  'cost $5 now',
  'fix $pd then ship',
  'first line\n$dep\nlast line',
  'echo $HOME and more',
  'pay $300 today',
  'run `echo $pd` here',
  '`$pd`',
  '`` a ` $pd ``',
  '```\n$pd\n```',
  '```sh\nfoo $pd',
  '~~~\nuse $pd\n~~~ after',
  '```\r\n$pd\r\n```',
  '`code` then $pd',
  '```\nx\n```\nnow $pd',
  'a lone ` tick $pd',
  '`` x ` y $pd',
  '~~~\nx\n~~~\n$pd more',
  '\ud83d\ude00 $pd',
  '$pd\ud83d\ude00',
  `$${'a'.repeat(64)}`,
  `$${'a'.repeat(65)}`,
  'x $a-b-c-d',
  '\t$re',
  '{$de',
  "'$de",
  '$dep$re',
];
const carets = (draft) => [undefined, -3, ...Array.from({ length: draft.length + 3 }, (_, n) => n)];
out.skills = {
  fixture: SKILLS,
  query: mentionDrafts.flatMap((draft) =>
    carets(draft).map((caret) => ({ draft, caret: caret ?? null, out: mentionMod.skillMentionQuery(draft, caret) }))
  ),
  items: ['', 'pdf', 'p', 'DEP', 'zz', 're', '-', 'a', 'path', '3', '300', 'Z'].map((query) => ({ query, out: mentionMod.skillMentionItems(SKILLS, query) })),
  itemsOfNothing: [undefined, null, 'x'].map((list) => mentionMod.skillMentionItems(list, 'p')),
  complete: mentionDrafts.flatMap((draft) =>
    ['pdf-tools', 'deploy', ''].flatMap((name) =>
      carets(draft)
        .filter((caret, index) => index < 4 || index % 3 === 0)
        .map((caret) => ({ draft, name, caret: caret ?? null, out: mentionMod.completeSkillMention(draft, name, caret) }))
    )
  ),
  palette: mentionDrafts.flatMap((draft) =>
    carets(draft)
      .filter((caret, index) => index < 3 || index % 2 === 0)
      .flatMap((caret) =>
        ['', draft].map((dismissed) => ({
          draft,
          caret: caret ?? null,
          dismissed,
          out: paletteOut(paletteMod.deriveSlashPalette({ promptDraft: draft, promptCaret: caret ?? null, slashDismissedFor: dismissed, skills: SKILLS })),
        }))
      )
  ),
  paletteSuppressed: ['fix it with $pd', '/sk'].flatMap((draft) =>
    suppress.map((flags) => ({ draft, flags, out: paletteOut(paletteMod.deriveSlashPalette({ promptDraft: draft, slashDismissedFor: '', skills: SKILLS, ...flags })) }))
  ),
};

// ----------------------------------------------------------------- parsers

const mcpTexts = [
  ' graph | node | --stdio   --safe | C:/project | ignored ',
  'graph | node',
  'graph | node | | C:/project',
  undefined,
  '',
  ' | node',
  'graph | ',
  ' web | WSS://example.test/socket | ignored | ignored ',
  'web | ftp://example.test',
  'web | https://example.test/mcp',
  'web | ws://x',
  'a|b|c|d|e',
  'a | node | x\ty\nz',
  'a | HTTP://X',
];
const skillTexts = ['pdf', 'pdf | | ', ' pdf | PDF documents | when   needed | ignored ', ' | description', '', undefined, 'a | b', 'a || trigger', 'a | b | c | d'];
const memoryTexts = [
  '',
  undefined,
  'status',
  'search q=x limit=5',
  'core add project_id=common',
  'search ratio=0.5 neg=-3 hex=0x10 empty= eq=a=b skip =x spaced= 5',
  'list limit=1e3 inf=Infinity bin=0b11 text=abc',
  '  list   limit=3  ',
  'action=x',
  'search action=override',
];
const memoryRowTexts = [
  '',
  'COMMON:\nid=3 prefers tabs \u2014 Use tabs\nproj-a:\nid=4 only element\nid=5 source=curated project=proj-b status=ok injection=on index_revision=r9 elem \u2014 sum\nnot a row',
  'id=1 source=curated project=COMMON status=ok injection=off first \u2014 one\nid=2 source=curated project=my proj/\u00e9 status=ok injection=on second',
  'COMMON:\n\n  \nid=10 alone',
  'proj:\nid=1 a \u2014 b \u2014 c\nid=2  spaced   \u2014   sum  ',
  'header with id=7:\nid=7 x',
  'Label:\nplain line\nid=abc nope',
  'id=11 source=curated project=p status=s injection=i  trailing \u2014 s',
];
const coreErrorTexts = [
  'core add: project_id required',
  'core edit failed: no entry with id=5',
  'core delete: x',
  'core: memory data dir is not initialized',
  'core requires op: x',
  'core: all fine',
  'Error: boom',
  'failed to write',
  'errors are fun',
  'core added',
  'core memory updated',
  '',
  undefined,
  null,
  ' Core Add: x ',
];
out.parsers = {
  mcp: mcpTexts.map((text) => ({ text: text ?? null, out: parsersMod.parseMcpServerInput(text) })),
  skill: skillTexts.map((text) => ({ text: text ?? null, out: parsersMod.parseSkillInput(text) })),
  memoryCommand: memoryTexts.map((text) => ({ text: text ?? null, out: parsersMod.parseMemoryCommand(text) })),
  memoryRows: memoryRowTexts.map((text) => ({ text, out: parsersMod.parseMemoryCoreRows(text) })),
  coreError: coreErrorTexts.map((text) => ({ text: text ?? null, out: parsersMod.memoryCoreResultErrorText(text) ?? null })),
  textEntry: ['system-shell', 'autoclear-provider', 'profile-title', 'core-add', '', 'x', undefined].map((kind) => ({
    kind: kind ?? null,
    out: policyMod.textEntryClearsByEmpty(kind),
  })),
  canSubmit: [
    ['', true],
    ['   ', true],
    ['', false],
    ['   ', false],
    [' value ', false],
    [undefined, false],
    ['x', undefined],
  ].map(([value, allowEmpty]) => ({ value: value ?? null, allowEmpty: allowEmpty ?? null, out: policyMod.canSubmitTextEntry(value, allowEmpty) })),
};

// --------------------------------------------------------------- scenarios

const OPENERS = {
  openModelPicker: 'model',
  openWebSearchPicker: 'websearch',
  openAgentsPicker: 'agents',
  openWorkflowPicker: 'workflow',
  openOutputStylePicker: 'outputstyle',
  openThemePicker: 'theme',
  openEffortPicker: 'effort',
  openProjectPicker: 'project',
  openMcpPicker: 'mcp',
  openMcpServersPicker: 'mcp-servers',
  openSkillsPicker: 'skills',
  openProjectSkillsPicker: 'project-skills',
  openPluginsPicker: 'plugins',
  openProviderSetupPicker: 'providers',
  openMemoryCorePicker: 'memory',
  openSettingsPicker: 'settings',
  openAutoClearPicker: 'autoclear',
  openResumePicker: 'resume',
  openUsagePanel: 'usage',
  openContextPicker: 'context',
  openProfilePicker: 'profile',
  openUpdatePicker: 'update',
  openDeveloperPicker: 'developer',
};
const SYNC_STORE = new Set(['listThemes', 'getTheme', 'setTheme']);
const FLAG_KEYS = ['_afterSave', '_successReturn', '_failureReturn', '_login', '_returnTo'];
const ok = (value) => ({ ok: value ?? null });
const err = (message) => ({ err: message });

const DEFAULT_STORE = {
  setModel: ok(true),
  setWorkflow: ok({ id: 'wf', name: 'Workflow' }),
  setOutputStyle: ok({ current: { id: 'simple', label: 'Simple' } }),
  getOutputStyle: ok({ current: { label: 'Simple' } }),
  listThemes: ok([
    { id: 'dawn', label: 'Dawn' },
    { id: 'dusk', label: 'Dusk' },
  ]),
  getTheme: ok('dusk'),
  setTheme: ok({ id: 'dawn', label: 'Dawn' }),
  setEffort: ok('high'),
  setFast: ok(true),
  toggleFast: ok(true),
  setAutoClear: ok({ enabled: true, idleMs: 600000 }),
  getAutoClear: ok({ enabled: false, idleMs: 300000 }),
  compact: ok({ changed: true }),
  newSession: ok(true),
  clear: ok(null),
  resume: ok(true),
  memoryControl: ok(null),
  goalControl: ok({ message: 'Goal paused.' }),
  inheritSession: ok({ messages: 4, sessionId: 's9' }),
  listShellJobs: ok({
    jobs: [
      { taskId: 'job_a', command: 'npm run dev' },
      { taskId: 'job_b', command: 'node server.js', terminationUnconfirmed: true },
    ],
  }),
  releaseShellJob: ok({ released: true }),
  listStoppableShellJobs: ok({
    jobs: [
      { taskId: 'job_a', command: 'npm run dev' },
      { taskId: 'job_b', command: 'tail -f log' },
    ],
  }),
  stopShellJobs: ok({ stopped: 2, stopping: 0 }),
  listWorkflows: ok([
    { id: 'wf0', name: 'Default WF', active: true },
    { id: 'wf1', name: 'Second' },
    { id: 'wf2', name: 'Third' },
  ]),
  saveProviderApiKey: ok(null),
  saveOpenAIUsageSessionKey: ok(null),
  setCwd: ok(null),
  inspectProjectPath: ok({ path: 'C:/work/p', directory: true }),
  ensureProjectDirectory: ok('C:/work/created'),
  renameProject: ok({ name: 'Renamed' }),
  setSystemShell: ok(null),
  setProfile: ok(null),
  addPlugin: ok(null),
  addMcpServer: ok(null),
  addSkill: ok(null),
};
const withStore = (overrides) => ({ ...DEFAULT_STORE, ...overrides });
const rejectAll = () => Object.fromEntries(Object.keys(DEFAULT_STORE).map((name) => [name, err('boom')]));
const nullishAll = () =>
  Object.fromEntries(Object.keys(DEFAULT_STORE).map((name) => [name, name === 'listThemes' ? ok([]) : ok(null)]));

const BASE_STATE = { busy: false, commandBusy: false, provider: 'openai', model: 'gpt-5', workflow: { id: 'wf0', name: 'Default WF' } };

const stripPrompt = (prompt) => {
  if (!prompt) return null;
  const copy = JSON.parse(JSON.stringify(prompt));
  if (copy.submitting === false) delete copy.submitting;
  return copy;
};

/** Drives one scenario against the Node modules and answers its logs. */
async function runScenario(spec) {
  const log = [];
  const paste = [];
  const E = (...entry) => log.push(entry);
  let clock = spec.clock ?? 0;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    epochMod.supersedePanelEpoch();
    let live = null;
    const surface = surfaceMod.createPanelSurface({
      setPicker: (next) => {
        const previous = live;
        live = typeof next === 'function' ? next(previous) : next;
        if (live && typeof live._kind === 'string' && live._kind.startsWith('slash-loading:')) {
          E('paint', live._kind.slice('slash-loading:'.length), live.title);
        } else if (live) {
          E('paintStop', live.title, live.footer.map((row) => row.text));
        } else if (previous) {
          E('closeSurface');
        }
        if (epochMod.shouldSupersedePanelEpoch(previous, live)) epochMod.supersedePanelEpoch();
      },
      setContextPanel: () => E('clearContext'),
      setUsagePanel: () => {},
    });
    const state = { ...BASE_STATE, ...(spec.state || {}) };
    let submitOptions = null;
    const store = {
      pushNotice: (message, tone, options) => (options?.ttlMs ? E('noticeTtl', message, tone, options.ttlMs) : E('notice', message, tone)),
      forceRenderRepaint: () => E('repaint'),
    };
    for (const [name, reply] of Object.entries(spec.store || {})) {
      if (SYNC_STORE.has(name)) {
        store[name] = (...callArgs) => {
          E('call', name, callArgs);
          if (reply.err !== undefined) throw new Error(reply.err);
          return reply.ok;
        };
      } else {
        store[name] = (...callArgs) => {
          E('call', name, callArgs);
          return reply.err !== undefined ? Promise.reject(new Error(reply.err)) : Promise.resolve(reply.ok);
        };
      }
    }
    const recordSubmit = (method) => (content, options) => {
      submitOptions = options;
      E('submit', method, content, {
        displayText: options?.displayText,
        pastedImages: options?.pastedImages,
        pastedTexts: options?.pastedTexts,
        committed: !!options?.onCommitted,
      });
      if (method === 'submit') return spec.submitResult ?? true;
      if (spec.submitError) return Promise.reject(new Error(spec.submitError));
      return Promise.resolve(spec.submitResult ?? true);
    };
    if (spec.submitSync) store.submit = recordSubmit('submit');
    else store.submitAsync = recordSubmit('submitAsync');

    const opener = (name) => (options) => {
      E('open', name, options === undefined ? {} : JSON.parse(JSON.stringify(options)));
      if ((spec.openFails || []).includes(name)) return Promise.reject(new Error('open failed'));
      return undefined;
    };
    const deps = {};
    for (const [prop, name] of Object.entries(OPENERS)) deps[prop] = opener(name);
    const promptOf = (raw) => {
      if (!raw) return null;
      const prompt = { ...raw };
      for (const key of FLAG_KEYS) delete prompt[key];
      if (raw._afterSave) prompt.afterSave = () => E('afterSave');
      if (raw._successReturn) prompt.successReturn = () => E('successReturn');
      if (raw._failureReturn) prompt.failureReturn = (error) => E('failureReturn', error?.message ?? String(error));
      if (raw._returnTo) prompt.returnTo = () => {};
      if (raw._login === 'ok') prompt.login = { completeCode: async (code) => E('completeCode', code) };
      else if (typeof raw._login === 'string' && raw._login.startsWith('reject:')) {
        prompt.login = {
          completeCode: async (code) => {
            E('completeCode', code);
            throw new Error(raw._login.slice(7));
          },
        };
      } else if (typeof raw._login === 'string' && raw._login.startsWith('throw:')) {
        prompt.login = {
          completeCode: (code) => {
            E('completeCode', code);
            throw new Error(raw._login.slice(6));
          },
        };
      }
      return prompt;
    };
    const providerPrompt = promptOf(spec.providerPrompt);
    const settingsPrompt = promptOf(spec.settingsPrompt);
    const setter = (surfaceName) => (next) =>
      typeof next === 'function' ? E('markSubmitting', surfaceName) : E('setPrompt', surfaceName, stripPrompt(next));
    const oauthSubmitRef = {};
    let oauthValue = false;
    Object.defineProperty(oauthSubmitRef, 'current', {
      get: () => oauthValue,
      set: (value) => {
        oauthValue = value;
        E('oauth', value);
      },
    });
    const pastedImagesRef = { current: JSON.parse(JSON.stringify(spec.pastedImages || {})) };
    const pastedTextsRef = { current: JSON.parse(JSON.stringify(spec.pastedTexts || {})) };
    const { runSlashCommand } = dispatchMod.createSlashDispatch({
      state,
      store,
      normalizeSlashCommandName: commandsMod.normalizeSlashCommandName,
      surface,
      closeUsagePanel: () => E('closeUsage'),
      ...deps,
      modelSwitchNotice: () => submitMod && 'Model saved \u00b7 new sessions',
      workflowSwitchNotice: (result) => 'Workflow saved \u00b7 new sessions' && (result, 'Workflow saved \u00b7 new sessions'),
      outputStyleNotice: (await load('app/route-pickers/output-style-picker.mjs')).outputStyleNotice,
      themeNotice: (applied) => `Theme set to ${applied?.label || applied?.id || 'default'}`,
      enterProject: (target) => E('enterProject', target),
      parseMemoryCommand: parsersMod.parseMemoryCommand,
      formatDuration: timeMod.formatDuration,
      runDoctor: async () => {
        E('doctor');
        if (spec.doctorFails) throw new Error(spec.doctorFails);
      },
      requestExit: () => E('exit'),
      loginMcpServer: (name) => E('login', name),
      logoutMcpServer: (name) => E('logout', name),
      btw: { ask: (question) => E('btw', question) },
    });
    const idsOf = (snapshot) => (snapshot ? Object.keys(snapshot).map(Number).sort((a, b) => a - b) : null);
    const { onSubmit } = submitMod.createPromptSubmit({
      store,
      state,
      providerPrompt,
      settingsPrompt,
      setProviderPrompt: setter('provider'),
      setSettingsPrompt: setter('settings'),
      oauthSubmitRef,
      clearModelCaches: (scope) => E('clearCaches', scope),
      ...deps,
      registerProject: (path) => E('registerProject', path),
      runSlashCommand,
      armTranscriptFollow: () => E('armFollow'),
      clearPastedImagesSnapshot: (snapshot) => paste.push(['clearImages', idsOf(snapshot)]),
      clearPastedTextsSnapshot: (snapshot) => paste.push(['clearTexts', idsOf(snapshot)]),
      pastedImagesRef,
      pastedTextsRef,
    });
    const guard = { pending: false, lastAt: 0 };
    const seen = { current: 0 };
    const returns = [];
    for (const step of spec.steps) {
      const [kind, a, b] = step;
      if (kind === 'run') returns.push(runSlashCommand(a, b));
      else if (kind === 'submit') returns.push(onSubmit(a));
      else if (kind === 'select') live?.onSelect(a);
      else if (kind === 'cancel') live?.onCancel();
      else if (kind === 'commit') submitOptions?.onCommitted?.();
      else if (kind === 'tick') clock += a;
      else if (kind === 'cycle') {
        returns.push(cycleMod.cycleWorkflowFromPrompt({ store, state: { commandBusy: state.commandBusy, workflow: state.workflow }, cycleGuard: guard }));
      } else if (kind === 'tab') {
        // useWorkflowTabCycle's callback, statement for statement.
        const blocked = ['slashPaletteOpen', 'toolApproval', 'picker', 'settingsPrompt', 'providerPrompt', 'contextPanel', 'usagePanel'].some((flag) => a[flag]);
        returns.push(blocked ? true : cycleMod.cycleWorkflowFromPrompt({ store, state: { commandBusy: state.commandBusy, workflow: state.workflow }, cycleGuard: guard }));
      } else if (kind === 'uiopen') {
        // useUiOpenRequest's effect body, statement for statement.
        const request = a;
        const seq = Number(request?.seq) || 0;
        if (request?.command && seq > seen.current) {
          seen.current = seq;
          if (!(Number(request.at) > 0 && Date.now() - Number(request.at) > 15_000)) {
            if (Object.hasOwn(uiOpenMod.SETUP_SECTION_TARGETS, request.command)) {
              uiOpenMod.SETUP_SECTION_TARGETS[request.command]({
                openDeveloperPicker: deps.openDeveloperPicker,
                openSettingsPicker: deps.openSettingsPicker,
                pushNotice: store.pushNotice,
              });
            } else runSlashCommand(request.command);
          }
        }
      }
      await flush();
      await flush();
      E('state', { guard: kind === 'cycle' || kind === 'tab' ? [guard.pending, guard.lastAt] : null });
    }
    return { log: JSON.parse(JSON.stringify(log)), paste: JSON.parse(JSON.stringify(paste)), returns };
  } finally {
    Date.now = realNow;
  }
}

const scenarios = [];
const add = (name, spec) => scenarios.push({ name, spec });

// Every command and argument form, once per state and store variant.
const RUN_STEPS = [
  ['run', 'clear', ''],
  ['run', 'new', ''],
  ['run', 'NEW', ''],
  ['run', 'project', ''],
  ['run', 'projects', ''],
  ['run', 'project', 'C:/other'],
  ['run', 'compact', ''],
  ['run', 'btw', ''],
  ['run', 'btw', '   '],
  ['run', 'btw', 'why?'],
  ['run', 'goal', ''],
  ['run', 'goal', '--time 1h ship it'],
  ['run', 'goal', 'pause'],
  ['run', 'autoclear', ''],
  ['run', 'autoclear', 'on'],
  ['run', 'autoclear', 'Enable'],
  ['run', 'autoclear', 'off'],
  ['run', 'autoclear', 'disabled'],
  ['run', 'autoclear', 'status'],
  ['run', 'autoclear', '10m'],
  ['run', 'autoclear', 'unlimited'],
  ['run', 'resume', ''],
  ['run', 'resume', 'abc'],
  ['run', 'context', ''],
  ['run', 'shells', ''],
  ['run', 'shells', 'release'],
  ['run', 'shells', 'bogus x'],
  ['run', 'shells', 'release job_b'],
  ['run', 'shells', 'release job_b --confirm'],
  ['run', 'shells', 'release job_b --force'],
  ['run', 'stop', ''],
  ['select', 'cancel'],
  ['run', 'stop', ''],
  ['cancel'],
  ['run', 'stop', ''],
  ['select', 'stop'],
  ['run', 'fork', ''],
  ['run', 'inherit', ''],
  ['run', 'usage', ''],
  ['run', 'usage', 'refresh'],
  ['run', 'model', ''],
  ['run', 'model', 'refresh'],
  ['run', 'model', 'REFRESH '],
  ['run', 'model', 'gpt-x'],
  ['run', 'websearch', ''],
  ['run', 'websearch', 'x'],
  ['run', 'workflow', ''],
  ['run', 'workflow', ' review '],
  ['run', 'outputstyle', ''],
  ['run', 'outputstyle', 'simple'],
  ['run', 'outputstyle', 'Status'],
  ['run', 'style', 'current'],
  ['run', 'output-style', 'show'],
  ['run', 'theme', ''],
  ['run', 'theme', 'Dawn'],
  ['run', 'theme', 'DUSK'],
  ['run', 'theme', 'status'],
  ['run', 'theme', 'nope'],
  ['run', 'agents', ''],
  ['run', 'agents', 'refresh'],
  ['run', 'agents', 'x'],
  ['run', 'effort', ''],
  ['run', 'effort', 'high'],
  ['run', 'fast', ''],
  ['run', 'fast', 'on'],
  ['run', 'fast', 'Enable'],
  ['run', 'fast', '1'],
  ['run', 'fast', 'off'],
  ['run', 'fast', 'no'],
  ['run', 'fast', 'ultra'],
  ['run', 'fast', 'ultrafast'],
  ['run', 'fast', 'maybe'],
  ['run', 'mcp', ''],
  ['run', 'mcp', 'login'],
  ['run', 'mcp', 'logout'],
  ['run', 'mcp', 'login my server'],
  ['run', 'mcp', 'LOGOUT  x'],
  ['run', 'mcp', 'list'],
  ['run', 'skills', ''],
  ['run', 'memory', ''],
  ['run', 'memory', 'status'],
  ['run', 'memory', 'search q=x limit=3'],
  ['run', 'plugins', ''],
  ['run', 'providers', ''],
  ['run', 'settings', ''],
  ['run', 'setting', ''],
  ['run', 'config', ''],
  ['run', 'profile', ''],
  ['run', 'update', ''],
  ['run', 'doctor', ''],
  ['run', 'schedules', ''],
  ['run', 'webhooks', ''],
  ['run', 'quit', ''],
  ['run', 'exit', ''],
  ['run', 'q', ''],
  ['run', 'bogus', ''],
  ['run', '', ''],
  ['run', 'Model', 'x'],
];
const COMPACT_REPLIES = [
  { changed: false, reason: 'too small' },
  { changed: false },
  null,
  { error: 'x' },
  { error: '' },
  { error: 'Compaction failed: y' },
  { error: 'Compact failed' },
  { changed: true },
];
const stateVariants = [
  ['idle', {}],
  ['busy', { busy: true }],
  ['commandBusy', { commandBusy: true }],
];
const storeVariants = [
  ['default', DEFAULT_STORE],
  ['reject', withStore(rejectAll())],
  ['nullish', withStore(nullishAll())],
  [
    'shells-empty',
    withStore({ listShellJobs: ok({ jobs: [] }), listStoppableShellJobs: ok({ jobs: [] }), listThemes: ok([]), getTheme: ok(null), getOutputStyle: ok({ configured: 'terse' }) }),
  ],
  [
    'shells-odd',
    withStore({
      listShellJobs: ok({ jobs: [{ taskId: 'job_a', command: 'ls' }] }),
      releaseShellJob: ok({ released: false, error: 'locked' }),
      stopShellJobs: ok({ stopped: 1, stopping: 1 }),
      setOutputStyle: ok({ configured: 'terse', appliedToCurrentSession: false }),
      setEffort: ok('xhigh'),
      goalControl: ok({ ok: false, message: 'No goal.' }),
      inheritSession: ok(null),
      resume: ok(false),
      newSession: ok(false),
      setTheme: ok(null),
      setAutoClear: ok({ enabled: false, idleMs: 3723000 }),
    }),
  ],
  ['shells-reject-stop', withStore({ stopShellJobs: err('stop failed'), listStoppableShellJobs: ok({ jobs: [{ taskId: 'a', command: 'x' }] }) })],
  ['list-reject', withStore({ listStoppableShellJobs: err('list failed'), listShellJobs: err('nope'), listThemes: err('no themes') })],
];
for (const [stateName, state] of stateVariants) {
  for (const [storeName, store] of storeVariants) {
    add(`dispatch ${stateName} ${storeName}`, { state, store, steps: RUN_STEPS });
  }
}
COMPACT_REPLIES.forEach((reply, index) => {
  add(`compact ${index}`, { store: withStore({ compact: ok(reply) }), steps: [['run', 'compact', '']] });
});
add('compact rejects', { store: withStore({ compact: err('boom') }), steps: [['run', 'compact', '']] });
add('compact rejects empty', { store: withStore({ compact: err('') }), steps: [['run', 'compact', '']] });
add('openers fail', {
  store: DEFAULT_STORE,
  openFails: Object.values(OPENERS),
  steps: [['run', 'model', ''], ['run', 'settings', ''], ['run', 'usage', 'x'], ['run', 'memory', ''], ['run', 'resume', '']],
});
add('doctor fails', { store: DEFAULT_STORE, doctorFails: 'no doctor', steps: [['run', 'doctor', '']] });
add('fork reject', { store: withStore({ inheritSession: err('gone') }), steps: [['run', 'fork', ''], ['run', 'inherit', '']] });

// Prompt submit: slash lines and chat.
const SUBMIT_LINES = [
  '',
  '   ',
  '/',
  '/ x',
  '/model',
  '/model   gpt  x ',
  '/theme dawn',
  '/quit',
  '/bogus a b',
  '/fast maybe',
  'hello',
  '  hello  ',
  'multi\nline',
  '\u3053\u3093\u306b\u3061\u306f',
];
for (const [stateName, state] of stateVariants) {
  add(`submit ${stateName}`, {
    state,
    store: DEFAULT_STORE,
    pastedImages: { 1: { id: 1, content: 'QUJD', mediaType: 'image/png', metadataText: 'a.png' } },
    steps: SUBMIT_LINES.map((line) => ['submit', line]),
  });
}
add('submit sync store', { store: DEFAULT_STORE, submitSync: true, steps: [['submit', 'hello'], ['submit', '/theme dawn']] });
add('submit sync rejected', { store: DEFAULT_STORE, submitSync: true, submitResult: false, steps: [['submit', 'hello']] });
add('submit not accepted', { store: DEFAULT_STORE, unordered: true, submitResult: false, steps: [['submit', 'hello']] });
add('submit failed', { store: DEFAULT_STORE, unordered: true, submitError: 'daemon down', steps: [['submit', 'hello']] });
const IMAGES = {
  1: { id: 1, content: 'QUJD', mediaType: 'image/png', metadataText: 'a.png 1x1' },
  2: { id: 2, content: 'REVGR0g=', mediaType: 'image/jpeg' },
  3: { id: 3, content: 'AAAA' },
};
const TEXTS = { 1: 'folded one\nline two', 2: 'folded two' };
const pasteLines = [
  'plain',
  'see [Image #1]',
  '[Image #2] and [Image #1]',
  '[Image #9] missing',
  '[Image #1] [Image #3] x',
  'text [Pasted text #1 +2 lines]',
  '[Pasted text #1 +2 lines] [Pasted text #2 +1 lines] [Image #2]',
  '[Pasted text #7 +1 lines]',
  'broken [Image #1',
  '[Image #1] /not-a-command',
];
for (const busy of [false, true]) {
  add(`submit paste busy=${busy}`, {
    state: { busy },
    store: DEFAULT_STORE,
    pastedImages: IMAGES,
    pastedTexts: TEXTS,
    steps: pasteLines.flatMap((line) => [['submit', line], ['commit']]),
  });
}

// Provider prompts.
const apiKey = (extra = {}) => ({ kind: 'api-key', providerId: 'vertex-ai', ...extra });
add('provider api key', {
  store: DEFAULT_STORE,
  providerPrompt: apiKey({ authMode: 'api-key', _afterSave: true }),
  steps: [['submit', 'AQ.key'], ['submit', ''], ['submit', '   ']],
});
add('provider api key plain', { store: DEFAULT_STORE, providerPrompt: apiKey(), steps: [['submit', '{}']] });
add('provider api key rejected', {
  store: withStore({ saveProviderApiKey: err('daemon offline') }),
  providerPrompt: apiKey({ label: 'Key', hint: 'paste it' }),
  steps: [['submit', 'k']],
});
add('provider api key busy', { state: { commandBusy: true }, store: DEFAULT_STORE, providerPrompt: apiKey(), steps: [['submit', 'k']] });
add('provider api key missing service', {
  store: Object.fromEntries(Object.entries(DEFAULT_STORE).filter(([name]) => name !== 'saveProviderApiKey')),
  providerPrompt: apiKey(),
  steps: [['submit', 'k']],
});
add('provider usage key', {
  store: DEFAULT_STORE,
  providerPrompt: { kind: 'openai-usage-session' },
  steps: [['submit', 'sess'], ['submit', '']],
});
add('provider usage key rejected', {
  store: withStore({ saveOpenAIUsageSessionKey: err('no') }),
  providerPrompt: { kind: 'openai-usage-session' },
  steps: [['submit', 'sess']],
});
add('provider unknown kind', { store: DEFAULT_STORE, providerPrompt: { kind: 'mystery' }, steps: [['submit', 'x'], ['submit', '/theme dawn'], ['submit', '']] });
for (const [name, prompt] of [
  ['oauth ok return', { kind: 'oauth-code', providerName: 'Grok', _login: 'ok', _successReturn: true }],
  ['oauth ok after save', { kind: 'oauth-code', providerName: 'Grok', _login: 'ok', _afterSave: true }],
  ['oauth ok picker', { kind: 'oauth-code', _login: 'ok' }],
  ['oauth no login', { kind: 'oauth-code', providerName: 'Grok', _failureReturn: true }],
  ['oauth rejects', { kind: 'oauth-code', providerName: 'Grok', _login: 'reject:bad state', _failureReturn: true }],
  ['oauth throws', { kind: 'oauth-code', providerName: 'Grok', _login: 'throw:bad state' }],
  ['oauth submitting', { kind: 'oauth-code', providerName: 'Grok', _login: 'ok', submitting: true }],
]) {
  add(name, { store: DEFAULT_STORE, providerPrompt: prompt, steps: [['submit', ''], ['submit', 'abc#state']] });
}

// Settings prompts.
const settingsCases = [
  ['cwd', { kind: 'cwd' }, ['', 'C:/work/proj/', 'D:\\a\\b']],
  ['system shell', { kind: 'system-shell', label: 'System shell' }, ['pwsh', '', '  ']],
  ['autoclear provider', { kind: 'autoclear-provider', label: 'Auto-clear', provider: 'openai', _returnTo: true }, ['', '45m', ' 2h ']],
  ['autoclear provider missing', { kind: 'autoclear-provider', provider: '  ' }, ['x']],
  ['profile title', { kind: 'profile-title' }, ['', 'Dr', '  Prof  ']],
  ['project new', { kind: 'project-new' }, ['', 'C:/work/p']],
  ['project create confirm', { kind: 'project-create-confirm', pendingPath: 'C:/work/new' }, ['y', 'YES', ' yes ', 'n', '', 'sure']],
  ['project rename', { kind: 'project-rename', projectPath: 'C:/work/p' }, ['New name', '']],
  ['plugin add', { kind: 'plugin-add' }, ['', 'https://x/plugin', 'C:/p']],
  ['mcp add', { kind: 'mcp-add' }, ['', 'a', 'graph | node | --x | C:/p', 'web | https://x/mcp']],
  ['skill add', { kind: 'skill-add' }, ['', 'pdf', 'pdf | Docs | when needed']],
  ['skill use', { kind: 'skill-use', skillName: 'pdf-tools' }, ['', 'summarize this', ' x ']],
  ['skill use nameless', { kind: 'skill-use', skillName: ' ' }, ['x']],
  ['core add', { kind: 'core-add' }, ['', ' prefers tabs ']],
  ['core edit', { kind: 'core-edit', _id: 5, _indexRevision: 'r1', _projectId: 'proj', _singleSentence: true }, ['', 'new sentence']],
  ['core edit plain', { kind: 'core-edit', _id: 6, _projectId: null }, ['sentence']],
  ['core delete', { kind: 'core-delete-confirm', _id: 5, _indexRevision: 'r1', _projectId: 'proj' }, ['y', 'n', '', 'yes']],
  ['unknown', { kind: 'mystery' }, ['x', '', '/theme dawn']],
];
for (const [name, prompt, lines] of settingsCases) {
  add(`settings ${name}`, { store: DEFAULT_STORE, settingsPrompt: prompt, steps: lines.map((line) => ['submit', line]) });
  add(`settings ${name} busy`, { state: { commandBusy: true }, store: DEFAULT_STORE, settingsPrompt: prompt, steps: [['submit', lines[lines.length - 1]]] });
  add(`settings ${name} rejected`, { store: withStore(rejectAll()), settingsPrompt: prompt, steps: lines.map((line) => ['submit', line]) });
  add(`settings ${name} nullish`, { store: withStore(nullishAll()), settingsPrompt: prompt, steps: lines.map((line) => ['submit', line]) });
}
add('settings project new missing', {
  store: withStore({ inspectProjectPath: ok({ path: 'C:/work/missing', exists: false }) }),
  settingsPrompt: { kind: 'project-new' },
  steps: [['submit', 'C:/work/missing']],
});
add('settings project new file', {
  store: withStore({ inspectProjectPath: ok({ path: 'C:/work/file.txt', exists: true }) }),
  settingsPrompt: { kind: 'project-new' },
  steps: [['submit', 'C:/work/file.txt']],
});
add('settings project new no path', {
  store: withStore({ inspectProjectPath: ok({ directory: true }) }),
  settingsPrompt: { kind: 'project-new' },
  steps: [['submit', 'C:/work/x']],
});
add('settings project create empty', {
  store: withStore({ ensureProjectDirectory: ok(null) }),
  settingsPrompt: { kind: 'project-create-confirm', pendingPath: 'C:/work/new' },
  steps: [['submit', 'y']],
});
add('settings core memory error text', {
  store: withStore({ memoryControl: ok('core add: project_id required') }),
  settingsPrompt: { kind: 'core-add' },
  steps: [['submit', 'x']],
});
add('settings open fails', {
  store: DEFAULT_STORE,
  openFails: ['settings', 'plugins', 'memory', 'project', 'profile', 'autoclear'],
  settingsPrompt: { kind: 'system-shell' },
  steps: [['submit', 'x']],
});
add('settings plugin reopen fails', {
  store: DEFAULT_STORE,
  openFails: ['plugins'],
  settingsPrompt: { kind: 'plugin-add' },
  steps: [['submit', 'https://x']],
});
add('both prompts', {
  store: DEFAULT_STORE,
  providerPrompt: { kind: 'mystery' },
  settingsPrompt: { kind: 'system-shell' },
  steps: [['submit', 'x']],
});

// Tab workflow cycle and the setup open request.
add('cycle', {
  store: DEFAULT_STORE,
  clock: 10_000,
  steps: [['cycle'], ['cycle'], ['tick', 100], ['cycle'], ['tick', 400], ['cycle'], ['tab', { picker: true }], ['tick', 1000], ['tab', {}], ['tab', { slashPaletteOpen: true }]],
});
add('cycle busy', { state: { commandBusy: true }, store: DEFAULT_STORE, clock: 10_000, steps: [['cycle'], ['tick', 1000], ['cycle']] });
add('cycle none', { store: withStore({ listWorkflows: ok([]) }), clock: 10_000, steps: [['cycle']] });
add('cycle one', { store: withStore({ listWorkflows: ok([{ id: 'only', name: 'Only' }]) }), clock: 10_000, steps: [['cycle']] });
add('cycle one nameless', { store: withStore({ listWorkflows: ok([{}]) }), clock: 10_000, steps: [['cycle']] });
add('cycle not array', { store: withStore({ listWorkflows: ok(null) }), clock: 10_000, steps: [['cycle']] });
add('cycle no active', {
  store: withStore({ listWorkflows: ok([{ id: 'a' }, { id: 'wf0' }, { id: 'c' }]) }),
  clock: 10_000,
  steps: [['cycle']],
});
add('cycle unknown current', {
  state: { workflow: { id: 'zz' } },
  store: withStore({ listWorkflows: ok([{ id: 'a' }, { id: 'b' }]) }),
  clock: 10_000,
  steps: [['cycle']],
});
add('cycle last active wraps', {
  store: withStore({ listWorkflows: ok([{ id: 'a' }, { id: 'b', active: true }]) }),
  clock: 10_000,
  steps: [['cycle']],
});
add('cycle list rejects', { store: withStore({ listWorkflows: err('no list') }), clock: 10_000, steps: [['cycle']] });
add('cycle set rejects', { store: withStore({ setWorkflow: err('no set') }), clock: 10_000, steps: [['cycle']] });
add('cycle set nothing', { store: withStore({ setWorkflow: ok(null) }), clock: 10_000, steps: [['cycle']] });
add('ui open', {
  store: DEFAULT_STORE,
  clock: 100_000,
  steps: [
    ['uiopen', { command: 'model', seq: 1, at: 99_000 }],
    ['uiopen', { command: 'model', seq: 1, at: 99_000 }],
    ['uiopen', { command: 'theme', seq: 0 }],
    ['uiopen', { command: 'theme', seq: 2, at: 50_000 }],
    ['uiopen', { command: 'theme', seq: 3 }],
    ['uiopen', { command: 'developer', seq: 4 }],
    ['uiopen', { command: 'voice', seq: 5 }],
    ['uiopen', { command: 'connection', seq: 6, at: 100_000 }],
    ['uiopen', { command: '', seq: 7 }],
    ['uiopen', { seq: 8 }],
    ['uiopen', { command: 'bogus', seq: '9' }],
    ['uiopen', { command: 'quit', seq: 9 }],
    ['uiopen', { command: 'quit', seq: 10, at: 'x' }],
    ['uiopen', null],
  ],
});

out.scenarios = [];
for (const { name, spec } of scenarios) {
  const result = await runScenario(spec);
  out.scenarios.push({ name, spec: { ...spec, steps: spec.steps }, ...result });
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
