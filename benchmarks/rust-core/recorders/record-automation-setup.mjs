#!/usr/bin/env node
// Golden twin of the setup tool's automation actions (save/delete/enabled/run automation and
// set_webhook_config, `setup-tool/extended-actions.mjs`) and of `assertAutomationAccess`
// (`services/schedule-access.mjs`). Each case runs the real handler over a recording fake
// runtime and keeps what Node answered (the value or the error text), the runtime calls it made
// and the caller scope it derived. Rust `mixdog_services::channels::setup` must equal all of it.
//
//   node benchmarks/rust-core/recorders/record-automation-setup.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { EXTENDED_SETUP_HANDLERS } = await importFrom(tree, 'src/session-runtime/setup-tool/extended-actions.mjs');
const access = await importFrom(tree, 'src/session-runtime/services/schedule-access.mjs');

const AGENTS = ['reviewer', 'writer'];
const CRON = { time: '0 9 * * 1-5', whenCron: '0 9 * * 1-5', timezone: 'Asia/Seoul' };
const STATES = {
  empty: { schedules: [], webhooks: [], webhook: { enabled: true, port: 3333, domain: 'h.example', publicUrl: 'https://h.example' } },
  busy: {
    schedules: [
      { name: 'pr-sweep', description: 'd', ...CRON, instructions: 'Tidy up PRs', owner: 'reviewer', executorAgentId: 'worker', enabled: true, cwd: '/w', nextFireAt: '2031-01-01T00:00:00.000Z' },
      { name: 'mixy-daily', ...CRON, instructions: 'Morning', owner: 'lead', executorAgentId: null, enabled: true },
      { name: 'once', time: 'at 2031-05-06T07:08:09.000Z', whenAt: '2031-05-06T07:08:09.000Z', instructions: 'Once', owner: 'lead', executorAgentId: null, enabled: false,
        attachments: [{ kind: 'text', name: 'n.txt', mimeType: 'text/plain', data: 'héllo😀' }] },
      { name: 'ownerless', ...CRON, instructions: 'x', enabled: true },
    ],
    webhooks: [
      { name: 'hook', parser: 'github', instructions: 'Summarise', owner: 'reviewer', executorAgentId: null, enabled: true, secretSet: true, hasLastPayload: true },
      { name: 'quiet', parser: 'stripe', instructions: 'Pay', owner: 'lead', executorAgentId: null, enabled: false, secretSet: true, hasLastPayload: false },
    ],
    webhook: { enabled: false, port: 4100, domain: null, publicUrl: null },
  },
};

const home = (agentId) => ({ sessionId: `sess_home_${agentId}`, caller: { id: `sess_home_${agentId}` } });
const CONTEXTS = {
  lead: { sessionId: 'sess_0193', caller: { id: 'sess_0193', owner: 'user', sourceType: 'lead' } },
  homeLead: home('lead'),
  homeReviewer: home('reviewer'),
  homeWriter: home('writer'),
  schedule: { sessionId: 'sess_run', caller: { id: 'sess_run', owner: 'user', sourceType: 'schedule' } },
  unresolved: { sessionId: 'sess_gone', caller: null },
};

const plain = (v) => (v === undefined ? { absent: true } : JSON.parse(JSON.stringify(v)));

function fakeRuntime(state) {
  const calls = [];
  const note = (method, ...args) => calls.push({ method, args: args.map(plain) });
  const saved = (entry) => ({ ...entry, ...(entry.at ? { whenAt: new Date(entry.at).toISOString() } : {}), ...(entry.time ? { whenCron: entry.time } : {}), secret: 'sek' });
  return {
    calls,
    rt: {
      getChannelSetup: async () => state,
      listAgents: async () => AGENTS.map((id) => ({ id })),
      saveSchedule: async (entry) => (note('saveSchedule', entry), saved(entry)),
      saveWebhook: async (entry) => (note('saveWebhook', entry), saved(entry)),
      setScheduleEnabled: async (name, enabled) => (note('setScheduleEnabled', name, enabled), { name, enabled: enabled !== false }),
      setWebhookEnabled: async (name, enabled) => (note('setWebhookEnabled', name, enabled), { name, enabled: enabled !== false }),
      deleteSchedule: async (name) => (note('deleteSchedule', name), { name, deleted: true }),
      deleteWebhook: async (name) => (note('deleteWebhook', name), { name, deleted: true }),
      runScheduleNow: (name) => (note('runScheduleNow', name), new Promise(() => {})),
      runWebhookNow: (name) => (note('runWebhookNow', name), new Promise(() => {})),
      setWebhookConfig: async (patch) => note('setWebhookConfig', patch),
    },
  };
}

const sched = { automationKind: 'schedule' };
const hook = { automationKind: 'webhook' };
const entry = { name: 'new-one', time: '0 9 * * 1-5', instructions: 'Tidy' };
const ACTIONS = [
  ['save_automation', { ...sched, entry }],
  ['save_automation', { ...sched, entry: { ...entry, owner: 'reviewer' } }],
  ['save_automation', { ...sched, entry: { ...entry, owner: ' lead ' } }],
  ['save_automation', { ...sched, entry: { ...entry, owner: 'ghost' } }],
  ['save_automation', { ...sched, entry: { name: 'new-one', instructions: 'Tidy', at: '2031-01-02T03:04:00Z' } }],
  ['save_automation', { ...sched, entry: { ...entry, parser: 'github' } }],
  ['save_automation', { ...sched, entry: { name: 'pr-sweep', enabled: false, overwrite: true } }],
  ['save_automation', { ...sched, entry: { name: 'pr-sweep', owner: 'writer', overwrite: true } }],
  ['save_automation', { ...sched, entry: { name: 'pr-sweep', time: '30 10 * * *', overwrite: true } }],
  ['save_automation', { ...sched, entry: { name: 'pr-sweep', at: '2031-05-06T07:08:09Z', overwrite: true } }],
  ['save_automation', { ...sched, entry: { name: 'pr-sweep', newName: 'renamed', overwrite: true } }],
  ['save_automation', { ...sched, entry: { name: 'pr-sweep', executorAgentId: null, overwrite: true } }],
  ['save_automation', { ...sched, entry: { name: 'once', instructions: 'Again', overwrite: true } }],
  ['save_automation', { ...sched, entry: { name: 'once', time: '0 1 * * *', overwrite: true } }],
  ['save_automation', { ...sched, entry: { name: 'mixy-daily', enabled: false, overwrite: true } }],
  ['save_automation', { ...sched, entry: { name: 'ownerless', enabled: false, overwrite: true } }],
  ['save_automation', { ...sched, entry: { name: 'missing', overwrite: true } }],
  ['save_automation', { ...hook, entry: { name: 'gh', instructions: 'S', parser: 'github' } }],
  ['save_automation', { ...hook, entry: { name: 'gh', instructions: 'S', secret: 'x', time: '0 9 * * *' } }],
  ['save_automation', { ...hook, entry: { name: 'gh', instructions: 'S', days: 'weekday' } }],
  ['save_automation', { ...hook, entry: { name: 'gh', instructions: 'S', newName: 'gh2' } }],
  ['save_automation', { ...hook, entry: { name: 'hook', enabled: false, overwrite: true } }],
  ['save_automation', { ...hook, entry: { name: 'hook', owner: 'lead', overwrite: true } }],
  ['save_automation', { ...hook, entry: { name: 'gh', instructions: 'S', attachments: [{ kind: 'text', name: 'a.txt', mimeType: 'text/plain', data: 'héllo😀' }] } }],
  ['delete_automation', { ...sched, name: 'pr-sweep' }],
  ['delete_automation', { ...sched, name: 'mixy-daily' }],
  ['delete_automation', { ...sched, name: 'nope' }],
  ['delete_automation', { ...hook, name: 'hook' }],
  ['set_automation_enabled', { ...sched, name: 'pr-sweep', enabled: false }],
  ['set_automation_enabled', { ...sched, name: 'pr-sweep', enabled: true }],
  ['set_automation_enabled', { ...sched, name: 'pr-sweep' }],
  ['set_automation_enabled', { ...sched, name: 'pr-sweep', enabled: 'no' }],
  ['set_automation_enabled', { ...sched, name: 'pr-sweep', enabled: null }],
  ['set_automation_enabled', { ...sched, name: 'nope', enabled: false }],
  ['set_automation_enabled', { ...hook, name: 'hook', enabled: false }],
  ['set_automation_enabled', { ...hook, name: 'quiet' }],
  ['run_automation', { ...sched, name: 'pr-sweep' }],
  ['run_automation', { ...sched, name: 'mixy-daily' }],
  ['run_automation', { ...sched, name: 'nope' }],
  ['run_automation', { ...hook, name: 'hook' }],
  ['run_automation', { ...hook, name: 'quiet' }],
  ['set_webhook_config', { webhook: { enabled: true, port: 4000, domain: 'd.example' } }],
  ['set_webhook_config', { webhook: { port: 80 } }],
  ['set_webhook_config', {}],
];

async function outcome(run) {
  try {
    return { value: plain(await run()) };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

const cases = [];
for (const stateName of Object.keys(STATES)) {
  for (const [action, args] of ACTIONS) {
    for (const [contextName, context] of Object.entries(CONTEXTS)) {
      const { rt, calls } = fakeRuntime(STATES[stateName]);
      const result = await outcome(() => EXTENDED_SETUP_HANDLERS[action](rt, args, context));
      await new Promise((resolve) => setImmediate(resolve));
      cases.push({ action, args: plain(args), state: stateName, context: contextName, sessionId: context.sessionId, scope: access.scheduleCallerScope(context.caller), calls, ...result });
    }
  }
}

const accessCases = [];
const SCOPES = [{ kind: 'human' }, { kind: 'agent', agentId: 'reviewer' }, { kind: 'agent', agentId: 'lead', unattended: true }, { kind: 'room-member', agentId: 'writer' }, { kind: 'headless' }];
const CURRENTS = [null, { name: 'a', owner: 'reviewer' }, { name: 'b', owner: 'lead' }, { name: 'c' }];
for (const scope of SCOPES) {
  for (const kind of ['schedule', 'webhook']) {
    for (const action of ['create', 'edit', 'delete']) {
      for (const current of CURRENTS) {
        for (const owner of ['', 'lead', 'reviewer', 'writer', 'ghost']) {
          const input = { kind, action, current, owner, agentIds: AGENTS };
          accessCases.push({ scope, ...input, ...(await outcome(() => access.assertAutomationAccess(scope, input))) });
        }
      }
    }
  }
}

writeJson(join(FIXTURES_ROOT, 'channels', 'automation-setup-twin.json'), {
  domain: 'automation-setup-twin',
  recorder: 'benchmarks/rust-core/recorders/record-automation-setup.mjs',
  agents: AGENTS,
  states: STATES,
  cases,
  accessCases,
});
console.log(`recorded ${cases.length} action cases and ${accessCases.length} access cases`);
