// Records what Node's headless exec does with the read-only tool mode, over the real
// `runHeadlessExec` (src/headless-exec.mjs), the real pristine boundary, the real session runtime
// (`createMixdogSessionRuntime`) and the real session loop, against a scripted provider transport
// (every provider request is answered on a loopback hub, no real host is contacted).
//
// Node's exec has no read-only switch of its own: `headless-exec.mjs` hard-codes `toolMode: 'full'`,
// `mixdog exec --readonly` is refused (`headless-command.mjs`), and the one caller that runs a
// read-only exec, `src/defaults/skills/pptx/scripts/review-deck.mjs`, passes a `runtimeFactory` that
// re-creates the runtime with `toolMode: 'readonly'`. The cases below run exactly that factory (and the
// default one, as the control).
//
//   node benchmarks/rust-core/recorders/record-exec-readonly.mjs --tree <exact export of the commit> --commit <40 hex>
//
// Output: native/core/fixtures/exec-readonly/.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const recorder = 'benchmarks/rust-core/recorders/record-exec-readonly.mjs';

// The provider's replies, the same for every case that names them. A turn is the model's next message: its text and the
// tools it calls. Every tool the model may be tempted to use is called once, so each refusal kind is recorded.
const A = { path: 'a.txt' };
const EDIT = { path: 'a.txt', old_string: 'hello', new_string: 'bye' };
const PATCH = { patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-hello\n+bye\n*** End Patch' };
const SCRIPTS = {
  // Direct calls to every kind of tool the read-only surface leaves out, between two it keeps.
  blocked: [
    {
      calls: [
        ['read', A],
        ['edit', EDIT],
        ['apply_patch', PATCH],
        ['shell', { command: 'echo hi > b.txt' }],
        ['git', { action: 'status' }],
        ['github', { action: 'repo' }],
        ['task', { action: 'list' }],
        ['agent', { prompt: 'look around' }],
        ['office', { action: 'list' }],
        ['tidy', { action: 'check' }],
        ['web_search', { query: 'x' }],
        ['web_fetch', { url: 'http://127.0.0.1/' }],
        ['recall', { query: 'x' }],
        ['mcp__fake__ping', {}],
        ['no_such_tool', {}],
        ['grep', { pattern: 'hello', path: '.' }],
      ],
    },
    // The same tools through the bridge the offered list holds (`load_tool`, `call_tool`).
    {
      calls: [
        ['load_tool', { names: ['shell'] }],
        ['load_tool', { names: ['read'] }],
        ['call_tool', { name: 'shell', arguments: { command: 'echo hi > c.txt' } }],
        ['call_tool', { name: 'edit', arguments: EDIT }],
        ['call_tool', { name: 'apply_patch', arguments: PATCH }],
        ['call_tool', { name: 'mcp__fake__ping', arguments: {} }],
        ['call_tool', { name: 'agent', arguments: { prompt: 'look around' } }],
        ['call_tool', { name: 'read', arguments: A }],
      ],
    },
    { text: 'final answer' },
  ],
  simple: [{ calls: [['read', A]] }, { text: 'done' }],
  // The tools a settings switch closes (`MIXDOG_FEATURE_WEB_SEARCH` / `_MEMORY` are off in an exec), called by name.
  gated: [
    {
      calls: [
        ['read', A],
        ['web_search', { query: 'x' }],
        ['web_fetch', { url: 'http://127.0.0.1/' }],
        ['recall', { query: 'x' }],
        ['memory', { action: 'list' }],
      ],
    },
    { text: 'final answer' },
  ],
};

// `mixdog exec` argument vectors whose classification (`classifyCliInvocation`, headless-command.mjs) is recorded: the
// flag absent (mode `full`), an unknown mode spelled after `--tool-mode`, and the refused `--readonly`.
const CLI_ARGVS = [
  ['exec', '--provider', 'p', '--model', 'm', 'go'],
  ['exec', '--provider', 'p', '--model', 'm', '--tool-mode', 'lead', 'go'],
  ['exec', '--provider', 'p', '--model', 'm', '--readonly', 'go'],
];

// One run each: the mode comes from the `runtimeFactory` (review-deck.mjs:173-177), the way a caller selects it.
const CASES = {
  'readonly-blocked': { mode: 'readonly', script: 'blocked', json: false },
  'readonly-json': { mode: 'readonly', script: 'simple', json: true },
  'full-simple': { mode: 'full', script: 'simple', json: false },
  'full-json': { mode: 'full', script: 'simple', json: true },
  // An interactive-profile session (no `toolProfile`) in the same exec environment, whose settings switches are off: the
  // refusal a switched-off tool gets outside a headless exec session.
  'interactive-gated': { mode: 'interactive', script: 'gated', json: false },
  // The same session created with the switches ON and closed before its first turn (a settings change the first turn's
  // reconcile takes live): a tool is then refused as closed in settings.
  'interactive-toggled': { mode: 'interactive-toggled', script: 'gated', json: false },
};
const FIXED_NOW = 1_700_000_000_000;

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
function messageSse(turn, index) {
  const parts = [sse('message_start', { type: 'message_start', message: { id: `msg_${index}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 20 + index, output_tokens: 1 } } })];
  // What the reply says, as the model's message the session reads: replayed as the core's events.
  const served = { text: turn.text ?? '', calls: [], inputTokens: 20 + index, outputTokens: 10 + index, stopReason: turn.calls ? 'tool_use' : 'end_turn' };
  let block = 0;
  if (turn.text) {
    parts.push(sse('content_block_start', { type: 'content_block_start', index: block, content_block: { type: 'text', text: '' } }));
    parts.push(sse('content_block_delta', { type: 'content_block_delta', index: block, delta: { type: 'text_delta', text: turn.text } }));
    parts.push(sse('content_block_stop', { type: 'content_block_stop', index: block }));
    block += 1;
  }
  for (const [name, input] of turn.calls ?? []) {
    served.calls.push({ id: `toolu_${index}_${block}`, name, input });
    parts.push(sse('content_block_start', { type: 'content_block_start', index: block, content_block: { type: 'tool_use', id: `toolu_${index}_${block}`, name, input: {} } }));
    parts.push(sse('content_block_delta', { type: 'content_block_delta', index: block, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }));
    parts.push(sse('content_block_stop', { type: 'content_block_stop', index: block }));
    block += 1;
  }
  parts.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: turn.calls ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 + index } }));
  parts.push(sse('message_stop', { type: 'message_stop' }));
  return { body: parts.join(''), served };
}

// ---------------------------------------------------------------- the child: one case, one process
async function runCase(tree, name, out) {
  const { mode, script, json } = CASES[name];
  const sandbox = mkdtempSync(join(tmpdir(), 'exec-readonly-'));
  for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
  process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
  process.env.TZ = 'UTC';
  // The boot profiler is switched on at import, so before anything is imported. Only the toggled case needs it: the profiler's
  // `session:create:ready` line is the runtime's own signal that a reserved session is built. It writes to the process's stderr,
  // which is not the exec's `writeErr` the recording captures, so the recorded fields are unaffected.
  const sessionReady = (() => {
    if (mode !== 'interactive-toggled') return null;
    process.env.MIXDOG_BOOT_PROFILE = '1';
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      if (String(chunk).includes(' session:create:ready ')) resolveReady();
      return write(chunk, ...rest);
    };
    return ready;
  })();
  const { install } = await import('./lib/intercept.mjs');
  const hub = await install(tree);
  // The provider gzips its request body; the hub reads bodies as text, so the transport stand-in inflates it on the way in
  // (the bytes the adapter sent are unchanged, only what the hub's reader sees is).
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

  const turns = SCRIPTS[script];
  const requests = [];
  const providerScript = {
    http: (record) => {
      if (!/\/v1\/messages$/.test(record.path)) return { status: 404, contentType: 'text/plain', body: 'no script' };
      const body = JSON.parse(record.bodyText);
      const turn = turns[Math.min(requests.length, turns.length - 1)];
      const reply = messageSse(turn, requests.length + 1);
      requests.push({
        path: record.path,
        model: body.model,
        tools: (body.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })),
        toolResults: body.messages.at(-1).content?.filter?.((block) => block.type === 'tool_result').map((block) => ({ tool_use_id: block.tool_use_id, is_error: block.is_error ?? false, content: block.content })) ?? [],
        served: reply.served,
      });
      return { body: reply.body };
    },
  };

  // What the runtime is created with: the options the session runtime itself receives.
  let runtimeOptions = null;
  const create = (options) => {
    runtimeOptions = {
      toolMode: options.toolMode,
      toolProfile: options.toolProfile,
      approvalMode: options.approvalMode,
      disallowDelegation: options.disallowDelegation,
      autoWakeCompletions: options.autoWakeCompletions,
      webSearch: process.env.MIXDOG_FEATURE_WEB_SEARCH === '1',
      memory: process.env.MIXDOG_FEATURE_MEMORY === '1',
    };
    return createMixdogSessionRuntime(options);
  };
  // The factory review-deck.mjs hands to runHeadlessExec (its line 177); the control run leaves it out.
  const baseFactory =
    mode === 'readonly'
      ? async (options) => create({ ...options, toolMode: 'readonly' })
      : mode === 'interactive'
        ? async (options) => create({ ...options, toolProfile: undefined })
        : mode === 'interactive-toggled'
          ? async (options) => {
              // The exec sets both switches off before it creates the runtime; this session is created with them on.
              process.env.MIXDOG_FEATURE_WEB_SEARCH = '1';
              process.env.MIXDOG_FEATURE_MEMORY = '1';
              const runtime = await create({ ...options, toolProfile: undefined });
              // Reserving an id builds the session in a detached promise (facade.mjs), exposed only through the boot profiler's
              // `session:create:ready` event (session-create.mjs); a deadline timer fails the run if it never comes.
              runtime.reserveSessionId('sess_exec_readonly');
              let deadline;
              await Promise.race([
                sessionReady,
                new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('the session was not built')), 20_000); }),
              ]);
              clearTimeout(deadline);
              process.env.MIXDOG_FEATURE_WEB_SEARCH = '0';
              process.env.MIXDOG_FEATURE_MEMORY = '0';
              return runtime;
            }
          : create;
  const factory = async (options) => {
    const runtime = await baseFactory(options);    // The session id is minted from the pid and the clock and the working directory is a temp dir; the lifecycle's
    // `thread_id` and `session.cwd` are those two, so they are pinned here.
    return new Proxy(runtime, {
      get: (target, key) => {
        if (key === 'id') return 'sess_exec_readonly';
        if (key === 'cwd' && json) return '/work';
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const stdout = [];
  const stderr = [];
  const usagePath = join(sandbox, 'usage.json');
  if (json) Date.now = () => FIXED_NOW;
  const code = await hub.run(
    providerScript,
    () =>
      runHeadlessExec({
        message: 'go',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        cwd: work,
        json,
        usageLogPath: usagePath,
        boundaryFactory: (route) => createPristineExecutionBoundary({ ...route, apiKeyResolver: () => 'sk-fake' }),
        runtimeFactory: factory,
        write: (text) => stdout.push(text),
        writeErr: (text) => stderr.push(text),
      }),
    `exec-readonly-${name}`
  );
  const files = Object.fromEntries(readdirSync(work).sort().map((file) => [file, readFileSync(join(work, file), 'utf8')]));
  writeFileSync(out, JSON.stringify({ case: name, mode, script, json, runtimeOptions, code, stdout, stderr, requests, files, usage: readFileSync(usagePath, 'utf8') }));
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(0);
}

// ---------------------------------------------------------------- the parent: stage, run each case, manifest
async function main() {
  const { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
  const args = parseArgs();
  const tree = resolveTree(args);
  if (args.has('case')) return runCase(tree, args.get('case'), args.get('out'));
  const identity = exactProductIdentity(tree, args.get('commit'));
  const finalDir = join(FIXTURES_ROOT, 'exec-readonly');
  const stage = stageSet(finalDir);
  const scratch = mkdtempSync(join(tmpdir(), 'exec-readonly-parent-'));
  writeJson(join(stage, 'scripts.json'), SCRIPTS);
  const { classifyCliInvocation } = await import(pathToFileURL(join(tree, 'src/headless-command.mjs')).href);
  writeJson(join(stage, 'cli.json'), CLI_ARGVS.map((argv) => ({ argv, result: classifyCliInvocation(argv) })));
  for (const name of Object.keys(CASES)) {
    const out = join(scratch, `${name}.json`);
    const child = spawnSync(process.execPath, [SELF, '--tree', tree, '--case', name, '--out', out], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 300_000 });
    if (child.status !== 0) throw new Error(`case ${name} failed (${child.status})`);
    const result = JSON.parse(readFileSync(out, 'utf8'));
    writeJson(join(stage, `${name}.json`), { ...result, usage: JSON.parse(result.usage) });
  }
  rmSync(scratch, { recursive: true, force: true });
  writeSetManifest(stage, { set: 'exec-readonly', recorder, command: `node ${recorder} --tree <tree> --commit ${args.get('commit')}`, identity, extra: { exact: true } });
  commitStage(stage, finalDir);
}
await main();
