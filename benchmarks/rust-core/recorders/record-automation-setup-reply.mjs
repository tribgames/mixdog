#!/usr/bin/env node
// Golden of the setup tool's five automation actions as the whole Node setup tool answers them:
// the real `createSetupToolExecutor(...).execute(args, { callerSessionId })` of
// src/session-runtime/setup-tool/executor.mjs, so the recorded reply is the text the model gets
// (receipt: `saved`, `scope`, `appliesTo` + the handler's result, or the refusal text), with the
// caller gates, the heartbeat gate and `scheduleCallerScope` of each kind of calling session in
// front of the handlers. The runtime facade is a recording fake. Runs on temp data/home dirs.
//
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

//   --tree <Node product tree> [--out <golden.json>]   (the default output is the fixture set
//   `automation-setup-reply` of the checkout this file is in)
const flag = (name) => process.argv[process.argv.indexOf(`--${name}`) + 1];
if (!process.argv.includes('--tree')) throw new Error('pass --tree <Node product tree>');
const TREE = resolve(flag('tree')).replaceAll('\\', '/');
const OUT = process.argv.includes('--out')
  ? resolve(flag('out'))
  : join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'native', 'core', 'fixtures', 'automation-setup-reply', 'golden.json');
const sandbox = mkdtempSync(join(tmpdir(), 'automation-setup-reply-'));
Object.assign(process.env, {
  MIXDOG_DATA_DIR: join(sandbox, 'data'),
  MIXDOG_HOME: sandbox,
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  MIXDOG_USER_DATA_BACKUP_ROOT: join(sandbox, 'backups'),
  HOME: sandbox,
  USERPROFILE: sandbox,
  APPDATA: sandbox,
  LOCALAPPDATA: sandbox,
});
process.chdir(sandbox);
const load = (rel) => import(pathToFileURL(`${TREE}/${rel}`).href);
const { createSetupToolExecutor } = await load('src/session-runtime/setup-tool/executor.mjs');
const { agentHomeSessionId } = await load('src/runtime/agent/orchestrator/session/agent-home.mjs');
const { roomMemberSessionId } = await load('src/runtime/agent/orchestrator/session/agent-room.mjs');
const { markUnattendedRun } = await load('src/session-runtime/held-requests.mjs');
const { markHeartbeatSession } = await load('src/runtime/shared/routine-trigger.mjs');

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

// The calling sessions by kind: [session id, the record `getCallerSession` answers].
const room = roomMemberSessionId('room42ab', 'writer');
const CALLERS = {
  human: ['sess_human', { id: 'sess_human', sourceType: 'lead', owner: 'user' }],
  mixy_home: [agentHomeSessionId('lead'), { id: agentHomeSessionId('lead'), owner: 'user' }],
  reviewer_home: [agentHomeSessionId('reviewer'), { id: agentHomeSessionId('reviewer'), owner: 'user' }],
  writer_home: [agentHomeSessionId('writer'), { id: agentHomeSessionId('writer'), owner: 'user' }],
  reviewer_run: ['sess_run', { id: 'sess_run', sourceType: 'lead', owner: 'user' }],
  room: [room, { id: room }],
  headless: ['sess_bg', { id: 'sess_bg', parentSessionId: 'sess_human' }],
  heartbeat: ['sess_hb', { id: 'sess_hb', sourceType: 'lead' }],
  // A session the host cannot open: `getCallerSession` answers nothing.
  unresolved: ['sess_gone', null],
};
markUnattendedRun('sess_run', { kind: 'schedule', agentId: 'reviewer', name: 'nightly' });
markHeartbeatSession('sess_hb');

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
const ARGS = [
  { action: 'save_automation', ...sched, entry },
  { action: 'save_automation', ...sched, entry: { ...entry, owner: 'reviewer' } },
  { action: 'save_automation', ...sched, entry: { ...entry, owner: ' lead ' } },
  { action: 'save_automation', ...sched, entry: { ...entry, owner: 'ghost' } },
  { action: 'save_automation', ...sched, entry: { name: 'new-one', instructions: 'Tidy', at: '2031-01-02T03:04:00Z' } },
  { action: 'save_automation', ...sched, entry: { ...entry, parser: 'github' } },
  { action: 'save_automation', ...sched, entry: { name: 'pr-sweep', enabled: false, overwrite: true } },
  { action: 'save_automation', ...sched, entry: { name: 'pr-sweep', owner: 'writer', overwrite: true } },
  { action: 'save_automation', ...sched, entry: { name: 'pr-sweep', time: '30 10 * * *', overwrite: true } },
  { action: 'save_automation', ...sched, entry: { name: 'pr-sweep', at: '2031-05-06T07:08:09Z', overwrite: true } },
  { action: 'save_automation', ...sched, entry: { name: 'pr-sweep', newName: 'renamed', overwrite: true } },
  { action: 'save_automation', ...sched, entry: { name: 'pr-sweep', executorAgentId: null, overwrite: true } },
  { action: 'save_automation', ...sched, entry: { name: 'once', instructions: 'Again', overwrite: true } },
  { action: 'save_automation', ...sched, entry: { name: 'mixy-daily', enabled: false, overwrite: true } },
  { action: 'save_automation', ...sched, entry: { name: 'missing', overwrite: true } },
  { action: 'save_automation', ...hook, entry: { name: 'gh', instructions: 'S', parser: 'github' } },
  { action: 'save_automation', ...hook, entry: { name: 'gh', instructions: 'S', secret: 'x', time: '0 9 * * *' } },
  { action: 'save_automation', ...hook, entry: { name: 'gh', instructions: 'S', newName: 'gh2' } },
  { action: 'save_automation', ...hook, entry: { name: 'hook', enabled: false, overwrite: true } },
  { action: 'save_automation', ...hook, entry: { name: 'gh', instructions: 'S', attachments: [{ kind: 'text', name: 'a.txt', mimeType: 'text/plain', data: 'héllo😀' }] } },
  { action: 'delete_automation', ...sched, name: 'pr-sweep' },
  { action: 'delete_automation', ...sched, name: 'mixy-daily' },
  { action: 'delete_automation', ...sched, name: 'nope' },
  { action: 'delete_automation', ...hook, name: 'hook' },
  { action: 'set_automation_enabled', ...sched, name: 'pr-sweep', enabled: false },
  { action: 'set_automation_enabled', ...sched, name: 'pr-sweep', enabled: true },
  { action: 'set_automation_enabled', ...sched, name: 'pr-sweep' },
  { action: 'set_automation_enabled', ...sched, name: 'pr-sweep', enabled: 'no' },
  { action: 'set_automation_enabled', ...sched, name: 'nope', enabled: false },
  { action: 'set_automation_enabled', ...hook, name: 'hook', enabled: false },
  { action: 'set_automation_enabled', ...hook, name: 'quiet' },
  { action: 'run_automation', ...sched, name: 'pr-sweep' },
  { action: 'run_automation', ...sched, name: 'mixy-daily' },
  { action: 'run_automation', ...sched, name: 'nope' },
  { action: 'run_automation', ...hook, name: 'hook' },
  { action: 'run_automation', ...hook, name: 'quiet' },
  { action: 'set_webhook_config', webhook: { enabled: true, port: 4000, domain: 'd.example' } },
  { action: 'set_webhook_config', webhook: { port: 80 } },
  { action: 'set_webhook_config' },
  // The dispatcher's own checks in front of the handlers.
  { action: 'save_automation', ...sched },
  { action: 'delete_automation', automationKind: 'cron', name: 'pr-sweep' },
];

const cases = [];
for (const state of Object.keys(STATES)) {
  for (const args of ARGS) {
    for (const [caller, [id, record]] of Object.entries(CALLERS)) {
      const { rt, calls } = fakeRuntime(STATES[state]);
      const executor = createSetupToolExecutor({
        getApi: () => rt,
        getConfig: () => ({}),
        getSessionId: () => id,
        getCallerSession: (sid) => (sid === id ? record : null),
        notifySessionUi: () => false,
        flushSettings: async () => {},
      });
      let result;
      try {
        result = { reply: await executor.execute(structuredClone(args), { callerSessionId: id }) };
      } catch (error) {
        result = { error: String(error?.message ?? error) };
      }
      // A run starts on its own task: let it make its calls.
      await new Promise((resolve) => setImmediate(resolve));
      cases.push({ caller, state, args: plain(args), calls, ...result });
    }
  }
}

const out = {
  domain: 'automation-setup-reply',
  recorder: 'benchmarks/rust-core/recorders/record-automation-setup-reply.mjs',
  agents: AGENTS,
  states: STATES,
  cases,
};
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`recorded ${cases.length} replies`);
process.exit(0);
