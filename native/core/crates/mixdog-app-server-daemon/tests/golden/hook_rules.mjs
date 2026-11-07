// Records, from today's Node product, what the hook-rule setup actions answer: the real setup
// tool executor (`createSetupToolExecutor`, `setup-tool/executor.mjs`) over the real hook bus rule
// store (`createStandaloneHookBus`, wired as `resource-api.mjs` wires it), on a fresh data folder
// per case holding the case's hooks file. Each step is one `setup` call: its receipt text (or the
// error message) and the hooks file after it.
// Usage: node hook_rules.mjs <repo-root> <out.json>
// Every user location is pointed at temp folders BEFORE any Mixdog module loads.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, out] = process.argv.slice(2, 4);
const scratch = mkdtempSync(join(tmpdir(), 'hook-rules-golden-'));
for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR']) {
  process.env[name] = join(scratch, name.toLowerCase());
  mkdirSync(process.env[name], { recursive: true });
}
delete process.env.MIXDOG_HOOKS_FILE;

const add = (hookRule) => ({ action: 'add_hook_rule', hookRule });
const toggle = (ruleIndex, enabled) => ({ action: 'set_hook_rule_enabled', ruleIndex, enabled });
const del = (ruleIndex) => ({ action: 'delete_hook_rule', ruleIndex });
const rules3 = [
  { tool: 'read', action: 'deny', reason: 'no reads' },
  { tool: 'bash*', action: 'modify', match: 'rm -rf', patch: { dry: true, apiToken: 'sekret' }, enabled: false },
  { name: 'edit', decision: 'ask', contains: ['a', 'b'], message: 'check edits', cwd: '/work' },
];

const cases = [
  { name: 'no file: add the first rule', file: null, steps: [add({ action: 'deny' })] },
  { name: 'no file: delete and toggle find nothing', file: null, steps: [del(0), toggle(0, false)] },
  {
    name: 'array document',
    file: JSON.stringify(rules3, null, 2),
    steps: [toggle(0, false), toggle(0, true), toggle(1, true), toggle(2, false), add({ tool: 'grep', action: 'allow' }), del(1), del(7), toggle(9, true), del(0), del(0), del(0)],
  },
  {
    name: 'toolBefore document keeps its other keys',
    file: JSON.stringify({ note: 'mine', toolBefore: rules3, tail: [1] }, null, 2),
    steps: [add({ tool: 'write', action: 'block', reason: '  padded reason  ', match: ' x ', cwd: ' /p ' }), toggle(3, false), del(0)],
  },
  {
    name: 'beforeTool document',
    file: JSON.stringify({ beforeTool: rules3 }, null, 2),
    steps: [add({ action: 'ask' }), toggle(0, false), del(2)],
  },
  {
    name: 'hooks.toolBefore document',
    file: JSON.stringify({ hooks: { toolBefore: rules3, other: { x: 1 } }, z: 1 }, null, 2),
    steps: [add({ tool: 'glob', action: 'deny', enabled: false }), toggle(1, true), del(3)],
  },
  {
    name: 'toolBefore wins over the other containers',
    file: JSON.stringify({ toolBefore: [{ action: 'deny', tool: 'a' }], beforeTool: [{ action: 'deny', tool: 'b' }], hooks: { toolBefore: [{ action: 'deny', tool: 'c' }] } }, null, 2),
    steps: [add({ action: 'allow' }), del(0)],
  },
  {
    name: 'beforeTool wins over hooks.toolBefore',
    file: JSON.stringify({ beforeTool: [{ action: 'deny', tool: 'b' }], hooks: { toolBefore: [{ action: 'deny', tool: 'c' }] } }, null, 2),
    steps: [add({ action: 'allow' })],
  },
  {
    name: 'entries that are not objects are dropped by a write and not counted',
    file: JSON.stringify([1, 'x', null, { tool: 'one', action: 'deny' }, [2], { tool: 'two', action: 'ask' }], null, 2),
    steps: [toggle(1, false), toggle(2, true), add({ action: 'deny' }), del(0)],
  },
  {
    name: 'a standard hooks document gets a toolBefore list',
    file: JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: 'echo' }] }] } }, null, 2),
    steps: [add({ tool: 'bash', action: 'deny' }), toggle(0, false)],
  },
  { name: 'a document that is not an object or list', file: '5', steps: [add({ action: 'deny' }), toggle(0, false)] },
  { name: 'an empty file', file: '', steps: [add({ action: 'deny' })] },
  { name: 'a file of NUL bytes', file: '\u0000\u0000\u0000', steps: [add({ action: 'deny' })] },
  { name: 'a file that is not JSON', file: '{ not json', steps: [toggle(0, true), add({ action: 'deny' })] },
  {
    name: 'modify and rewrite need exactly one edit; the others take none',
    file: null,
    steps: [
      add({ action: 'modify' }),
      add({ action: 'rewrite' }),
      add({ action: 'modify', patch: { a: 1 }, args: { b: 2 } }),
      add({ action: 'rewrite', args: { b: 2 } }),
      add({ action: 'modify', patch: { a: 1 } }),
      add({ action: 'deny', patch: { a: 1 } }),
      add({ action: 'allow', args: { a: 1 } }),
      add({ action: 'ask', patch: {} }),
      add({ action: 'block' }),
    ],
  },
  {
    name: 'long and secret argument edits are reported as present, never shown',
    file: null,
    steps: [add({ tool: 'bash', action: 'modify', patch: { password: 'p', note: 'x'.repeat(300), list: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } }), toggle(0, false)],
  },
  {
    // The write of a toggle fails (a folder stands where the backup copy goes): the error text is
    // the operating system's, so the replay compares its shape, not its words.
    name: 'a toggle whose write fails is refused and recorded as a hook error',
    file: JSON.stringify([{ tool: 'a', action: 'deny' }], null, 2),
    bakDir: true,
    osText: true,
    steps: [toggle(0, false)],
  },
  {
    name: 'rules with unusual fields list as the summary reads them',
    file: JSON.stringify([{ tools: ['a', 'b'], decision: 'deny', contains: 'x', message: 'm' }, { action: '', tool: '' }, { enabled: 0, action: 'deny' }, { enabled: false }], null, 2),
    steps: [toggle(0, false), toggle(3, true), del(1)],
  },
];

const { createStandaloneHookBus } = await import(pathToFileURL(join(root, 'src/session-runtime/services/hook-bus.mjs')).href);
const { createSetupToolExecutor } = await import(pathToFileURL(join(root, 'src/session-runtime/setup-tool/executor.mjs')).href);

const recorded = [];
for (const [index, c] of cases.entries()) {
  const dataDir = join(scratch, `case${index}`);
  mkdirSync(dataDir, { recursive: true });
  const rulesPath = join(dataDir, 'hooks.json');
  if (c.file !== null) writeFileSync(rulesPath, c.file);
  if (c.bakDir) mkdirSync(`${rulesPath}.bak`);
  const bus = createStandaloneHookBus({ dataDir });
  const facade = {
    hooksStatus: () => bus.status(),
    addHookRule: (rule) => bus.addRule(rule),
    setHookRuleEnabled: (i, enabled) => bus.setRuleEnabled(i, enabled),
    deleteHookRule: (i) => bus.deleteRule(i),
    flushHookRules: () => bus.flushRules(),
  };
  const executor = createSetupToolExecutor({
    getApi: () => facade,
    getConfig: () => ({}),
    notifySessionUi: () => false,
    getSessionId: () => '',
    getCallerSession: undefined,
    flushSettings: async () => {},
  });
  const steps = [];
  for (const args of c.steps) {
    let reply;
    try {
      reply = { text: await executor.execute(args, {}) };
    } catch (error) {
      reply = { error: String(error?.message ?? error).split(dataDir).join('{data}') };
    }
    let file = null;
    try {
      file = readFileSync(rulesPath, 'utf8');
    } catch {}
    steps.push({ args, ...reply, file });
  }
  // What the user can see afterwards: the `hook:error` rows of the event log the status shows
  // (one status read, as the doctor or the hooks panel would make).
  const status = bus.status();
  const here = (text) => String(text).split(dataDir).join('{data}');
  const hookErrors = {
    count: status.counts['hook:error'] ?? 0,
    recent: status.recent
      .filter((entry) => entry.name === 'hook:error')
      .map((entry) => ({ summary: here(entry.summary), error: here(entry.payload.error) })),
  };
  recorded.push({ name: c.name, file: c.file, bakDir: c.bakDir === true, osText: c.osText === true, steps, hookErrors });
}
rmSync(scratch, { recursive: true, force: true });
writeFileSync(out, `${JSON.stringify({ cases: recorded }, null, 2)}\n`);
