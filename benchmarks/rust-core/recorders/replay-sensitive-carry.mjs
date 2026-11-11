#!/usr/bin/env node
// Replays the sensitive-carry scenario (lib/sensitive-carry-scenario.mjs; Node's recording is
// native/core/fixtures/sensitive-carry/golden.json) against a built `mixdogd`: one isolated profile, the scenario's scripted
// OpenAI-chat provider as a custom provider, the `helper` agent in the data folder, and this client as the desktop
// (replay-sensitive-writes.mjs runCore). The Lead turns run in order; a turn that needs a worker's report waits until the
// core has shown the Lead that many completions (see `shown` below).
//
// Then every file under the profile, the workspace and the core's debug log is searched for the codes in every spelling
// (lib/sensitive-writes-files.mjs), and each provider call's exposure (per code plain or not, the number of markers), ordered
// by conversation and place, is compared with Node's. Exit code 1 on any hit or difference.
//
//   MIXDOG_RECORDER_SCRATCH=<scratch parent> MIXDOG_PG_INSTALL=<an installed runtime folder> \
//     node benchmarks/rust-core/recorders/replay-sensitive-carry.mjs --mixdogd <exe>
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { AGENT, AGENT_MD, CODES, MODEL, STEPS, leadTurns, orderedCalls, scriptedProvider } from './lib/sensitive-carry-scenario.mjs';
import { scanSecrets, walk } from './lib/sensitive-writes-files.mjs';
import { runCore } from './replay-sensitive-writes.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '..', '..', '..');
const golden = JSON.parse(readFileSync(join(repo, 'native/core/fixtures/sensitive-carry/golden.json'), 'utf8'));
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const CUSTOM = 'custom-33333333-3333-4333-8333-333333333333';
const deadline = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};

const bin = resolve(arg('--mixdogd'));
const scratch = process.env.MIXDOG_RECORDER_SCRATCH;
if (!scratch) throw new Error('MIXDOG_RECORDER_SCRATCH must name the scratch parent');
const pgRuntime = process.env.MIXDOG_PG_INSTALL;
if (!pgRuntime || !existsSync(join(pgRuntime, 'active-version'))) throw new Error('MIXDOG_PG_INSTALL must name an installed PostgreSQL runtime folder');
const base = mkdtempSync(join(scratch, 'sc-rpl-'));
const ws = join(base, 'ws');
mkdirSync(ws);
const profile = join(base, 'profile');
const p = { root: base, profile, home: join(profile, 'home'), mixdogHome: join(profile, 'home', '.mixdog'), data: join(profile, 'home', '.mixdog', 'data'), runtime: join(profile, 'runtime'), appData: join(profile, 'home', 'AppData', 'Roaming'), local: join(profile, 'home', 'AppData', 'Local'), tmp: join(profile, 'tmp'), bridge: join(base, 'bridge') };
for (const d of [p.data, p.runtime, p.appData, p.local, p.tmp, p.bridge, join(base, 'bin'), join(p.data, 'agents', AGENT)]) mkdirSync(d, { recursive: true });
const active = readFileSync(join(pgRuntime, 'active-version'), 'utf8').trim();
cpSync(join(pgRuntime, `runtime-${active}`), join(p.data, 'runtime', `runtime-${active}`), { recursive: true });
writeFileSync(join(p.data, 'runtime', 'active-version'), active);
p.exe = join(base, 'bin', 'mixdogd.exe');
copyFileSync(bin, p.exe);
writeFileSync(join(base, 'bin', 'js-runtime.json'), JSON.stringify({ program: process.execPath, packageRoot: repo }));
writeFileSync(join(p.data, 'agents', AGENT, 'AGENT.md'), AGENT_MD);
const calls = [];
const turns = leadTurns();
const prov = await scriptedProvider(calls, CUSTOM, { held: turns.held });
writeFileSync(join(p.data, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { [CUSTOM]: { type: 'custom', name: 'sc', enabled: true, protocol: 'openai-chat', baseURL: prov.baseURL, auth: 'none', models: [{ id: MODEL }] } } } }));
const log = join(base, 'core.log');
let bad = 0;
try {
  await runCore(p, bin, log, async ({ client, onNotification }) => {
    const leads = new Map();
    // The completions each thread has been shown: a worker's report reaches its live owner as its card (an `agent` tool item
    // of type `result`) and then its queue entry, both on the owner's one inbox in that order (SessionCompletions::deliver,
    // agent_registry/flow.rs), so a turn started after the card takes the entry. The waits on their count.
    const shown = new Map();
    const waits = [];
    const settle = () => {
      for (const w of [...waits]) if ((shown.get(w.threadId)?.size ?? 0) >= w.count) waits.splice(waits.indexOf(w), 1)[0].resolve();
    };
    onNotification((n) => {
      const item = n.params?.item;
      if (n.method !== 'item/completed' || item?.type !== 'toolCall' || item.name !== 'agent' || item.input?.type !== 'result') return;
      // A card is completed again when the turn it lands in takes it (the same item id): each report counts once.
      const ids = shown.get(n.params.threadId) ?? new Set();
      shown.set(n.params.threadId, ids.add(item.id));
      settle();
    });
    const queued = (threadId, count) => new Promise((resolve) => { waits.push({ threadId, count, resolve }); settle(); });
    for (const step of STEPS) {
      if (!leads.has(step.lead)) {
        const started = await deadline(client.call('thread/start', { kind: 'task', session: { toolMode: 'full', autoWakeCompletions: false }, projectPath: ws, draft: { projectPath: ws, route: { provider: CUSTOM, model: MODEL }, orchestrationMode: 'swarm' } }), 60_000, 'thread/start');
        leads.set(step.lead, started.thread.id);
        await deadline(client.resumeThread(started.thread.id, { lastItems: 10 }), 30_000, 'thread/resume');
      }
      const threadId = leads.get(step.lead);
      for (const [who, count] of Object.entries(step.waitFor ?? {})) {
        if (who !== 'lead') throw new Error(`the replay waits on the Lead's queue only, not ${who}`);
        await deadline(queued(threadId, count), 120_000, `${count} completion(s) queued for the Lead before "${step.prompt}"`);
      }
      // This Lead's turn ending (another Lead's thread is subscribed too).
      const done = new Promise((resolve) => {
        const stop = onNotification((n) => {
          if (n.method !== 'turn/completed' || n.params?.threadId !== threadId) return;
          stop();
          resolve();
        });
      });
      await turns.turn(step.lead, async () => {
        await deadline(client.call('turn/start', { threadId, input: { prompt: step.prompt, options: {} } }), 60_000, 'turn/start').catch((error) => {
          throw new Error(`turn/start of "${step.prompt}": ${error.message} ${inspect({ ...error.detail, data: error.detail?.data }, { depth: 6, breakLength: Infinity })}`);
        });
        await deadline(done, 120_000, `the turn "${step.prompt}"`);
      });
    }
  });
} catch (error) {
  console.log(`FAILED ${error.message}`);
  bad += 1;
} finally {
  writeFileSync(join(base, 'calls.json'), JSON.stringify(calls, null, 1));
  await prov.close();
}
const hits = scanSecrets(base, Object.values(CODES), [...walk(profile), ...walk(ws), log]);
for (const hit of hits) console.log(`HIT ${hit.file}@${hit.offset} (${hit.encoding} of ${hit.value})`);
bad += hits.length;
// Per conversation, what its calls showed of the codes, in order, a repeat of the same state kept once: when a queued report
// reaches a turn (at its start, at a tool boundary, or after its answer, which asks once more) follows when the worker's
// turn ends against the Lead's, in either runtime; what the model is shown before and after is the question.
const states = (list) => {
  const out = [];
  for (const c of orderedCalls(list)) {
    const state = `${c.key} ${JSON.stringify(c.plain)} markers=${c.markers}`;
    if (out.at(-1) !== state) out.push(state);
  }
  return out;
};
const nodeViews = states(golden.calls);
const coreViews = states(calls);
for (let i = 0; i < Math.max(nodeViews.length, coreViews.length); i += 1) {
  const same = nodeViews[i] === coreViews[i];
  if (!same) bad += 1;
  console.log(`${same ? 'SAME' : 'DIFF'} ${coreViews[i] ?? '(none)'}${same ? '' : `\n   node: ${nodeViews[i] ?? '(none)'}`}`);
}
console.log(`the run's folder ${base} is kept${bad ? '' : ' (removing)'}`);
if (!bad) rmSync(base, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
