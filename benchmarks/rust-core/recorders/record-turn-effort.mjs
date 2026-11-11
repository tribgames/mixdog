// The effort the runtime publishes for the turn in flight (`runtime.turnEffort`, `currentTurnEffort`, turn-effort.mjs),
// read the way the TUI reads it (`context-state.mjs:58`), while each provider request of the turn is in flight and after
// the turn settled (gaps-session.md item 10).
//
// Scenarios, each in its own process with its own home, each one `runHeadlessExec` (src/headless-exec.mjs) over the real
// session runtime (`createMixdogSessionRuntime`) and the real loop against a scripted Anthropic transport: a reply with a
// tool call, then the final text.
//   fixed      The route's effort is `high`, Auto effort off: turn preparation stamps the turn's snapshot on its prompt.
//   none       No effort on the route: no snapshot is stamped.
//   auto-step  Auto effort on (`MIXDOG_AUTO_EFFORT=on`) at the route's `medium`, with a judge trained on steps: the turn's
//              judgment keeps `medium`, and the step judged after the tool call moves it to `high`.
//
// The judge is the effort-judge model, a separate ONNX process; its answer is the scenario's input as a provider's reply
// is: `judgeTurn` answers the scripted distribution (`JUDGE`) for the turn and for the step, everything around it (the
// ladder, the step judgment's scheduling and marking, the snapshot, the getter) is the product's. The judge's model dir
// holds only `calibration.json` (`steps: 1`), which is what `effortJudgeSupportsSteps` reads.
//
//   node benchmarks/rust-core/recorders/record-turn-effort.mjs --tree <b6f10295a export with node_modules>
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const RECORDER = 'benchmarks/rust-core/recorders/record-turn-effort.mjs';
const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
// A model at or above the measured floor for a mid-conversation effort update (`ANTHROPIC_MIN_VERSION`): only such a route
// stamps a turn's effort snapshot.
const MODEL = 'claude-opus-5';
const PROMPT = 'fix the failing test in a.txt';
const SCRIPT = [{ text: 'reading', calls: [['read', { path: 'a.txt' }]] }, { text: 'all done' }];
// The judge's distribution over easy / normal / hard / very hard: the turn keeps the base, the step goes one up.
const JUDGE = { turn: [0, 1, 0, 0], step: [0, 0, 1, 0] };
const SCENARIOS = {
  fixed: { effort: 'high', auto: 'off' },
  none: { effort: undefined, auto: 'off' },
  'auto-step': { effort: 'medium', auto: 'on' },
};

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
function messageSse(turn, index) {
  const parts = [sse('message_start', { type: 'message_start', message: { id: `msg_${index}`, type: 'message', role: 'assistant', model: MODEL, content: [], usage: { input_tokens: 20, output_tokens: 1 } } })];
  let block = 0;
  if (turn.text) {
    parts.push(sse('content_block_start', { type: 'content_block_start', index: block, content_block: { type: 'text', text: '' } }));
    parts.push(sse('content_block_delta', { type: 'content_block_delta', index: block, delta: { type: 'text_delta', text: turn.text } }));
    parts.push(sse('content_block_stop', { type: 'content_block_stop', index: block }));
    block += 1;
  }
  for (const [name, input] of turn.calls ?? []) {
    parts.push(sse('content_block_start', { type: 'content_block_start', index: block, content_block: { type: 'tool_use', id: `toolu_${index}_${block}`, name, input: {} } }));
    parts.push(sse('content_block_delta', { type: 'content_block_delta', index: block, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }));
    parts.push(sse('content_block_stop', { type: 'content_block_stop', index: block }));
    block += 1;
  }
  parts.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: turn.calls ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } }));
  parts.push(sse('message_stop', { type: 'message_stop' }));
  return parts.join('');
}

// `judgeTurn` answers from `globalThis.__judge` (the scripted model); `prewarmEffortJudge` starts no model process.
const JUDGE_HOOK = `
export async function load(url, context, next) {
  const loaded = await next(url, context);
  if (!url.endsWith('/src/runtime/effort-judge/judge-client.mjs')) return loaded;
  const source = String(loaded.source)
    .replace('export async function judgeTurn(input) {', 'export async function judgeTurn(input) { return globalThis.__judge(input);')
    .replace('export function prewarmEffortJudge() {', 'export function prewarmEffortJudge() { return false;');
  return { ...loaded, source };
}`;

async function runScenario(tree, name, out) {
  const scenario = SCENARIOS[name];
  const sandbox = mkdtempSync(join(tmpdir(), 'turn-effort-'));
  for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
  process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
  process.env.TZ = 'UTC';
  process.env.MIXDOG_AUTO_EFFORT = scenario.auto;
  const judgeDir = join(sandbox, 'judge');
  mkdirSync(judgeDir);
  writeFileSync(join(judgeDir, 'calibration.json'), JSON.stringify({ steps: 1 }));
  process.env.MIXDOG_EFFORT_JUDGE_DIR = judgeDir;
  register(`data:text/javascript,${encodeURIComponent(JUDGE_HOOK)}`);
  const judged = [];
  globalThis.__judge = async (input) => {
    const kind = input?.step ? 'step' : 'turn';
    judged.push(kind);
    return { probs: JUDGE[kind], ms: 1 };
  };
  const { install } = await import('./lib/intercept.mjs');
  const hub = await install(tree);
  const hubFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    if (headers.get('content-encoding') !== 'gzip' || init?.body === undefined) return hubFetch(input, init);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return hubFetch(input, { ...init, headers, body: gunzipSync(init.body) });
  };
  const at = (path) => import(pathToFileURL(join(tree, path)).href);
  const { runHeadlessExec } = await at('src/headless-exec.mjs');
  const { createPristineExecutionBoundary } = await at('src/runtime/shared/pristine-execution.mjs');
  const { createMixdogSessionRuntime } = await at('src/mixdog-session-runtime.mjs');
  const work = join(sandbox, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'a.txt'), 'hello\n');
  let runtime = null;
  const sends = [];
  const providerScript = {
    http: (record) => {
      if (!/\/v1\/messages$/.test(record.path)) return { status: 404, contentType: 'text/plain', body: 'no script' };
      const body = JSON.parse(record.bodyText);
      // What the runtime publishes while this request is in flight, and the effort the request itself carries.
      sends.push({ turnEffort: runtime?.turnEffort ?? null, requestEffort: body.output_config?.effort ?? null, judged: [...judged] });
      const turn = SCRIPT[Math.min(sends.length - 1, SCRIPT.length - 1)];
      return { body: messageSse(turn, sends.length) };
    },
  };
  let settled = null;
  const factory = async (options) => {
    runtime = await createMixdogSessionRuntime(options);
    return new Proxy(runtime, {
      get: (target, key) => {
        const value = Reflect.get(target, key, target);
        if (key !== 'close') return typeof value === 'function' ? value.bind(target) : value;
        return async (...rest) => {
          // The exec's turn has settled: what the getter answers from the persisted conversation.
          settled = { turnEffort: target.turnEffort ?? null };
          return value.apply(target, rest);
        };
      },
    });
  };
  const code = await hub.run(
    providerScript,
    () =>
      runHeadlessExec({
        message: PROMPT,
        provider: 'anthropic',
        model: MODEL,
        effort: scenario.effort,
        cwd: work,
        json: false,
        boundaryFactory: (route) => createPristineExecutionBoundary({ ...route, apiKeyResolver: () => 'sk-fake' }),
        runtimeFactory: factory,
        write: () => {},
        writeErr: () => {},
      }),
    `turn-effort-${name}`
  );
  if (!settled) throw new Error('the exec never closed its runtime');
  writeFileSync(out, JSON.stringify({ name, code, route: { provider: 'anthropic', model: MODEL, effort: scenario.effort ?? null }, autoEffort: scenario.auto, sends, judged, settled }));
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(0);
}

async function main() {
  const { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
  const { recorderProvenance } = await import('./lib/provenance.mjs');
  const args = parseArgs();
  const tree = resolveTree(args);
  if (args.has('case')) return runScenario(tree, args.get('case'), args.get('out'));
  const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
  const finalDir = join(FIXTURES_ROOT, 'turn-effort');
  const stage = stageSet(finalDir);
  const scratch = mkdtempSync(join(tmpdir(), 'turn-effort-parent-'));
  for (const name of Object.keys(SCENARIOS)) {
    const out = join(scratch, `${name}.json`);
    const child = spawnSync(process.execPath, [SELF, '--tree', tree, '--case', name, '--out', out], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 300_000 });
    if (child.status !== 0) throw new Error(`case ${name} failed (${child.status})`);
    writeJson(join(stage, `${name}.json`), { scenario: name, prompt: PROMPT, script: SCRIPT, judge: JUDGE, ...JSON.parse(readFileSync(out, 'utf8')) });
  }
  rmSync(scratch, { recursive: true, force: true });
  writeSetManifest(stage, {
    set: 'turn-effort',
    recorder: RECORDER,
    command: `node ${RECORDER} --tree <b6f10295a export>`,
    extra: { scenarios: Object.keys(SCENARIOS), ...recorderProvenance(import.meta.url) },
    identity,
  });
  commitStage(stage, finalDir);
  console.log('recorded turn-effort');
}
await main();
