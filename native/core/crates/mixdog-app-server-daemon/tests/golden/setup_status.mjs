// Records, from today's Node product, what the setup tool's `status` action answers for the
// domains `mcp`, `skills`, `plugins` and `hooks`: the real setup executor (`createSetupToolExecutor`,
// `setup-tool/executor.mjs`) reading its runtime facade.
//  - `services`: the facade answers the recorded `runtime` values (`mcpStatus`, `skillsStatus`,
//    `getDisabledSkills`, `pluginsStatus`), so the replay feeds the same values to the Rust reader.
//  - `hooks`: the facade is the real hook bus (`createStandaloneHookBus`, wired as `resource-api.mjs`
//    wires it) over a fresh data folder holding the case's hooks file.
// Usage: node setup_status.mjs <repo-root> <out.json>
// Every user location is pointed at temp folders BEFORE any Mixdog module loads.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]);
const out = resolve(process.argv[3]);
const scratch = mkdtempSync(join(tmpdir(), 'setup-status-golden-'));
for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR']) {
  process.env[name] = join(scratch, name.toLowerCase());
  mkdirSync(process.env[name], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
delete process.env.MIXDOG_HOOKS_FILE;

const { createStandaloneHookBus } = await import(pathToFileURL(join(root, 'src/session-runtime/services/hook-bus.mjs')).href);
const { createSetupToolExecutor } = await import(pathToFileURL(join(root, 'src/session-runtime/setup-tool/executor.mjs')).href);

const executorOver = (facade) =>
  createSetupToolExecutor({
    getApi: () => facade,
    getConfig: () => ({}),
    notifySessionUi: () => false,
    getSessionId: () => '',
    getCallerSession: undefined,
    flushSettings: async () => {},
  });

const status = (domain, detail) => ({ action: 'status', domain, ...(detail === undefined ? {} : { detail }) });

const server = (extra) => ({ name: 'srv', enabled: true, connected: true, transport: 'stdio', toolCount: 3, source: 'user', ...extra });
const services = [
  { name: 'mcp: no servers', args: status('mcp'), runtime: { mcpStatus: { servers: [] } } },
  { name: 'mcp: empty status object', args: status('mcp'), runtime: { mcpStatus: {} } },
  {
    name: 'mcp: a plain server, defaults for every missing field',
    args: status('mcp'),
    runtime: { mcpStatus: { connectedCount: '2', servers: [{ name: 'bare' }] } },
  },
  {
    name: 'mcp: transport from type, count text, errors and warnings',
    args: status('mcp', true),
    runtime: {
      mcpStatus: {
        connectedCount: 1,
        servers: [
          server({ transport: undefined, type: 'http', toolCount: '7', error: 'boom', warnings: ['w1', 'w2'], scope: ['/a', '/b'] }),
          server({ name: 'off', enabled: false, connected: 'yes', scope: 'all', warnings: [], source: undefined }),
        ],
        warnings: ['top warning'],
        declarationErrors: [{ file: 'x.json', error: 'bad' }],
      },
    },
  },
  {
    name: 'mcp: plugin-owned servers and a connector with accounts',
    args: status('mcp'),
    runtime: {
      mcpStatus: {
        connectedCount: 2,
        servers: [
          server({ name: 'plug', owner: { kind: 'plugin', id: 'codex', key: 'codex:plug' }, disabledReason: 'plugin disabled', enabled: false }),
          server({ name: 'plug2', owner: { kind: 'plugin', id: 'codex', key: 'codex:two' } }),
          server({ name: 'other', owner: { kind: 'user', id: 'x' } }),
          server({
            name: 'gmail',
            connector: 'gmail',
            accounts: [
              { name: 'gmail', email: 'a@x.test' },
              { name: 'gmail-2', authRequired: true, error: 'sign in again' },
              { name: 'gmail-3', email: '', authRequired: false, error: '' },
            ],
          }),
          server({ name: 'noaccounts', connector: 'linear', accounts: [] }),
          server({ name: 'notlist', accounts: 'x' }),
        ],
      },
    },
  },
  { name: 'skills: list and disabled names', args: status('skills'), runtime: { skillsStatus: { skills: [{ name: 'a', source: 'user' }], cwd: '/p' }, getDisabledSkills: { disabled: ['a', 'b'] } } },
  { name: 'skills: nothing disabled', args: status('skills'), runtime: { skillsStatus: { skills: [] }, getDisabledSkills: { disabled: [] } } },
  { name: 'skills: no disabled answer', args: status('skills', true), runtime: { skillsStatus: { skills: [], z: 1 }, getDisabledSkills: {} } },
  { name: 'skills: the status already has a disabled key, which keeps its place', args: status('skills'), runtime: { skillsStatus: { disabled: ['old'], skills: [1] }, getDisabledSkills: { disabled: ['new'] } } },
  { name: 'plugins: passed through as it is', args: status('plugins'), runtime: { pluginsStatus: { plugins: [{ id: 'codex', enabled: true, servers: ['a'] }], warnings: [] } } },
  { name: 'plugins: an empty status', args: status('plugins', true), runtime: { pluginsStatus: {} } },
];

const rules3 = [
  { tool: 'read', action: 'deny', reason: 'no reads' },
  { tool: 'bash*', action: 'modify', match: 'rm -rf', patch: { dry: true, apiToken: 'sekret' }, enabled: false },
  { name: 'edit', decision: 'ask', contains: ['a', 'b'], message: 'check edits', cwd: '/work' },
];
const hookCases = [
  { name: 'no hooks file', file: null },
  { name: 'array document with a rule that has an argument edit', file: JSON.stringify(rules3, null, 2) },
  { name: 'toolBefore document with detail', file: JSON.stringify({ toolBefore: rules3, note: 'x' }, null, 2), detail: true },
  { name: 'rules with unusual fields', file: JSON.stringify([{ tools: ['a', 'b'], decision: 'deny', contains: 'x', message: 'm' }, { action: '', tool: '' }, { enabled: 0, action: 'deny' }, 1], null, 2) },
  {
    name: 'a standard hooks document',
    file: JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: 'echo' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }, null, 2),
  },
  { name: 'a file that is not JSON', file: '{ not json' },
  { name: 'an empty file', file: '' },
];

const portable = (value, dir) => {
  if (typeof value === 'string') return value.split(dir).join('{data}');
  if (Array.isArray(value)) return value.map((item) => portable(item, dir));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portable(item, dir)]));
  return value;
};

const recordedServices = [];
for (const c of services) {
  const r = c.runtime;
  const facade = {
    mcpStatus: () => r.mcpStatus,
    skillsStatus: () => r.skillsStatus,
    getDisabledSkills: () => r.getDisabledSkills,
    pluginsStatus: () => r.pluginsStatus,
  };
  const text = await executorOver(facade).execute(c.args, {});
  recordedServices.push({ name: c.name, args: c.args, runtime: r, text });
}

const recordedHooks = [];
for (const [index, c] of hookCases.entries()) {
  const dataDir = join(scratch, `case${index}`);
  mkdirSync(join(dataDir, 'project'), { recursive: true });
  if (c.file !== null) writeFileSync(join(dataDir, 'hooks.json'), c.file);
  process.chdir(join(dataDir, 'project'));
  const bus = createStandaloneHookBus({ dataDir });
  const args = status('hooks', c.detail);
  const text = await executorOver({ hooksStatus: () => bus.status() }).execute(args, {});
  recordedHooks.push({ name: c.name, file: c.file, args, text: JSON.stringify(portable(JSON.parse(text), dataDir)) });
}
process.chdir(tmpdir());
rmSync(scratch, { recursive: true, force: true });
writeFileSync(out, `${JSON.stringify({ services: recordedServices, hooks: recordedHooks }, null, 2)}\n`);
