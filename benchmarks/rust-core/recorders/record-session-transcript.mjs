// What Node writes to the conversation transcript the memory watcher tails (`<home>/projects/<slug>/<id>.jsonl`), and what
// the watcher's ingest stores of it across a restart (gaps-session.md item 8, and its restart and memory-off questions).
//
// The product is b6f10295a with `node-patches/node-fix-memory-sensitive.patch` applied (1.4.5 wrote a session's sensitive
// values into the transcript, and so into memory, in plain text; the fix redacts them where the transcript is written,
// both for an appended line and for the conversation backfill). The tree must be exactly that (`nodeTreeIdentity`).
//
// Scenarios, each in its own process with its own home:
//   turn-lead        `runHeadlessExec` (src/headless-exec.mjs) over the real session runtime (`createMixdogSessionRuntime`)
//                    and the real loop, the runtime created with memory ON as a Lead session (no tool profile), against a
//                    scripted provider transport: a reply with text and a tool call, then the final text. A value the
//                    session marked sensitive (`rememberSensitiveValues`, as a sensitive browser fill marks it) is in the
//                    prompt and in the model's text. The transcript files the turn left are recorded.
//   turn-exec        The same exec with Node's own exec runtime (`MIXDOG_FEATURE_MEMORY=0`: memory switched off for the
//                    session): whether its transcript is written, and what the memory ingest stores of it.
//   writer           `createSessionTranscript` + `createTurnTranscript` (the writer and the turn's appends the runtime wires,
//                    boot/apis.mjs:754, turn-run.mjs:34) directly: the backfill of a session that already has a conversation,
//                    an agent's conversation, a blank text, the final text equal to the last mid-turn text, and the rotation
//                    of a file past 10 MiB.
//   restart          The ingest (`ingestTranscriptTail` over `createTranscriptOffsets`, the watcher's per-file ingest) of the
//                    transcript the writer case `restart-source` left, the writing runtime gone before any ingest ran: a
//                    first start whose ingest is killed between its inserts and the persist of its position (the persist
//                    throws), a second start (offsets loaded from the persisted blob), a third with nothing new. What each
//                    start inserted and the blob it left.
//
// Time: an exec turn's lines carry the wall clock (`formatUtcTimestamp()`), recorded by form as `<now>`; the writer and
// restart cases run on a fixed instant (`Date` and `Date.now()` are that instant; nothing there waits on a timer).
// The working directory and its project slug are recorded as `<cwd>` and `<slug>`.
//
//   node benchmarks/rust-core/recorders/record-session-transcript.mjs --tree <b6f10295a export with the patch applied and node_modules> --patch benchmarks/rust-core/recorders/node-patches/node-fix-memory-sensitive.patch
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const RECORDER = 'benchmarks/rust-core/recorders/record-session-transcript.mjs';
const PATCH = 'benchmarks/rust-core/recorders/node-patches/node-fix-memory-sensitive.patch';
const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const SECRET = 'swordfish42';
const LEAD_ID = 'sess_transcript_lead';
const PROMPT = `go: the password is ${SECRET}`;
const SCRIPT = [{ text: `looking with ${SECRET}`, calls: [['read', { path: 'a.txt' }]] }, { text: 'all done' }];
// The call a sensitive browser fill records (`rememberSensitiveValues`, sensitive-values.mjs).
const SENSITIVE_CALL = { name: 'browser', arguments: { action: 'fill', input: { ref: 'e1', text: SECRET, sensitive: true } } };

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
function messageSse(turn, index) {
  const parts = [sse('message_start', { type: 'message_start', message: { id: `msg_${index}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 20, output_tokens: 1 } } })];
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

/** `text` with the working directory (as a JSON string holds it) and its project slug named, not spelled out. */
function scrubPlace(text, cwd, slug) {
  return text.split(JSON.stringify(cwd).slice(1, -1)).join('<cwd>').split(slug).join('<slug>');
}

/** Every file under `root`, by its `/`-separated path relative to it. */
function filesUnder(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path).split(sep).join('/')] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------- one exec turn, in its own process
async function runTurn(tree, name, out) {
  const sandbox = mkdtempSync(join(tmpdir(), 'session-transcript-'));
  for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
  process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
  process.env.TZ = 'UTC';
  const lead = name === 'turn-lead';
  // The reserved session is built in a detached promise; the boot profiler's `session:create:ready` line is the runtime's own
  // signal that it is (as record-exec-readonly.mjs waits for it). It writes to the process's stderr, not the exec's.
  let sessionReady = null;
  if (lead) {
    process.env.MIXDOG_BOOT_PROFILE = '1';
    let resolveReady;
    sessionReady = new Promise((resolve) => { resolveReady = resolve; });
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      if (String(chunk).includes(' session:create:ready ')) resolveReady();
      return write(chunk, ...rest);
    };
  }
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
  const { rememberSensitiveValues } = await at('src/runtime/agent/orchestrator/session/sensitive-values.mjs');
  const { drainPathSync } = await at('src/runtime/shared/buffered-appender.mjs');
  const work = join(sandbox, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'a.txt'), 'hello\n');
  let sent = 0;
  const providerScript = {
    http: (record) => {
      if (!/\/v1\/messages$/.test(record.path)) return { status: 404, contentType: 'text/plain', body: 'no script' };
      const turn = SCRIPT[Math.min(sent, SCRIPT.length - 1)];
      sent += 1;
      return { body: messageSse(turn, sent) };
    },
  };
  let memory = null;
  // The exec runs inside its pristine boundary, which points MIXDOG_HOME at a temporary root it removes when the exec ends:
  // what the turn wrote under `<home>/projects` is read when the exec closes the runtime, before the boundary goes.
  let atClose = null;
  const seen = (runtime) =>
    new Proxy(runtime, {
      get: (target, key) => {
        const value = Reflect.get(target, key, target);
        if (key !== 'close') return typeof value === 'function' ? value.bind(target) : value;
        return async (...rest) => {
          const home = process.env.MIXDOG_HOME;
          const projects = join(home, 'projects');
          let files = {};
          try {
            // The appender's own exit drain: its in-flight chunk first, then what is queued, in the order they were appended
            // (a plain drain would write the queue ahead of a chunk still in flight).
            for (const path of Object.keys(filesUnder(projects))) drainPathSync(join(projects, path), { exiting: true });
            files = filesUnder(projects);
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
          atClose = {
            homeIsTheUsers: home === sandbox,
            memoryIngestDisabled: process.env.MIXDOG_DISABLE_MEMORY_INGEST ?? null,
            daemonSkipMemory: process.env.MIXDOG_DAEMON_SKIP_MEMORY ?? null,
            home,
            files,
          };
          return value.apply(target, rest);
        };
      },
    });
  const factory = lead
    ? async (options) => {
        // A Lead session of a runtime whose memory is on: the switch on, no tool profile.
        process.env.MIXDOG_FEATURE_MEMORY = '1';
        memory = true;
        const runtime = await createMixdogSessionRuntime({ ...options, toolProfile: undefined });
        runtime.reserveSessionId(LEAD_ID);
        let deadline;
        await Promise.race([sessionReady, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('the session was not built')), 20_000); })]);
        clearTimeout(deadline);
        rememberSensitiveValues(LEAD_ID, [SENSITIVE_CALL]);
        return seen(runtime);
      }
    : async (options) => {
        memory = process.env.MIXDOG_FEATURE_MEMORY === '1';
        return seen(await createMixdogSessionRuntime(options));
      };
  const code = await hub.run(
    providerScript,
    () =>
      runHeadlessExec({
        message: lead ? PROMPT : 'go',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        cwd: work,
        json: false,
        boundaryFactory: (route) => createPristineExecutionBoundary({ ...route, apiKeyResolver: () => 'sk-fake' }),
        runtimeFactory: factory,
        write: () => {},
        writeErr: () => {},
      }),
    `session-transcript-${name}`
  );
  if (!atClose) throw new Error('the exec never closed its runtime');
  const { home, files, ...facts } = atClose;
  const userProjects = (() => {
    try {
      return Object.keys(filesUnder(join(sandbox, 'projects')));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  })();
  const pristineLeft = (() => {
    try {
      statSync(home);
      return true;
    } catch {
      return false;
    }
  })();
  // A line's `timestamp` is the wall clock when it was appended (`formatUtcTimestamp()`): kept by its form only.
  const { cwdToProjectSlug } = await at('src/runtime/shared/transcript-writer/transcript-file.mjs');
  const slug = cwdToProjectSlug(work);
  const scrubbed = Object.fromEntries(
    Object.entries(files).map(([path, text]) => [
      scrubPlace(path, work, slug),
      scrubPlace(text, work, slug).replace(/"timestamp":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"/g, '"timestamp":"<now>"'),
    ])
  );
  writeFileSync(out, JSON.stringify({ name, code, memoryFeature: memory, cwd: '<cwd>', provider: { sends: sent }, prompt: lead ? PROMPT : 'go', atClose: { ...facts, files: scrubbed }, afterExec: { userProjects, pristineHomeLeft: pristineLeft } }));
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(0);
}

// ---------------------------------------------------------------- the writer and the turn's appends, directly
// The writer's clock: every `new Date()` and `Date.now()` of these cases is this instant (no timer runs here).
const WRITER_NOW = Date.UTC(2026, 2, 4, 5, 6, 7, 890);

async function writerCases(tree) {
  const home = mkdtempSync(join(tmpdir(), 'session-transcript-writer-'));
  process.env.MIXDOG_HOME = home;
  const at = (path) => import(pathToFileURL(join(tree, path)).href);
  const { createSessionTranscript } = await at('src/session-runtime/session-transcript.mjs');
  const { createTurnTranscript } = await at('src/session-runtime/turn/turn-run/transcript.mjs');
  const { rememberSensitiveValues } = await at('src/runtime/agent/orchestrator/session/sensitive-values.mjs');
  const { drainPathSync } = await at('src/runtime/shared/buffered-appender.mjs');
  const { cwdToProjectSlug } = await at('src/runtime/shared/transcript-writer/transcript-file.mjs');
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [WRITER_NOW]));
    }
    static now() {
      return WRITER_NOW;
    }
  };
  const cwd = join(home, 'work');
  mkdirSync(cwd);
  const slug = cwdToProjectSlug(cwd);
  const raw = {};
  const cases = [];
  const run = (name, session, steps, before) => {
    if (before) before();
    const remote = createSessionTranscript({ getSession: () => session, getCwd: () => cwd });
    let last = '';
    const transcript = createTurnTranscript({ getTranscriptWriter: () => remote.transcriptWriter, getLastAppendedAssistant: () => last, setLastAppendedAssistant: (v) => { last = v; } });
    for (const [method, text] of steps) {
      if (method === 'ensure') remote.ensureSessionTranscriptWriter();
      else if (method === 'final') transcript.appendFinalAssistant({ content: text });
      else transcript[method](text);
    }
    const path = remote.transcriptWriter.transcriptPath;
    drainPathSync(path, { exiting: true });
    const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
    const file = read(path);
    const rotated = read(`${path}.1`);
    raw[name] = file;
    cases.push({
      name,
      session: { id: session.id, owner: session.owner ?? null, messages: session.messages },
      steps,
      file: file === null ? null : { size: Buffer.byteLength(file), text: file.length > 4096 ? null : scrubPlace(file, cwd, slug) },
      rotated: rotated === null ? null : { size: Buffer.byteLength(rotated) },
      path: scrubPlace(relative(home, path).split(sep).join('/'), cwd, slug),
    });
  };
  run(
    'backfill',
    { id: 'sess_backfill', messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: `first ${SECRET}`, timestamp: '2026-01-02T03:04:05.000Z' },
      { role: 'assistant', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], ts: 1_700_000_000 },
      { role: 'tool', content: 'tool output' },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: [{ type: 'image', attachmentRef: 'a'.repeat(64) }, 'plain string block'] },
    ] },
    [['ensure'], ['appendUser', 'next question'], ['appendAssistantText', 'mid'], ['final', 'mid'], ['ensure'], ['appendUser', 'again']],
    () => rememberSensitiveValues('sess_backfill', [SENSITIVE_CALL])
  );
  run('agent', { id: 'sess_agent', owner: 'agent', messages: [] }, [['ensure'], ['appendUser', 'work'], ['appendAssistantText', '  '], ['final', 'worked']]);
  run('blank-and-repeat', { id: 'sess_blank', messages: [] }, [['ensure'], ['appendUser', '   '], ['appendAssistantText', 'a'], ['appendAssistantText', 'b'], ['final', 'b'], ['final', 'c']]);
  // A file already past the rotation size when the writer attaches: the first append rotates it out.
  const big = 'x'.repeat(10 * 1024 * 1024);
  run('rotation', { id: 'sess_rotate', messages: [{ role: 'user', content: 'kept out of the backfill' }] }, [['ensure'], ['appendUser', 'after rotation']], () => {
    const first = createSessionTranscript({ getSession: () => ({ id: 'sess_rotate', messages: [] }), getCwd: () => cwd });
    first.ensureSessionTranscriptWriter();
    writeFileSync(first.transcriptWriter.transcriptPath, `${big}\n`);
  });
  // The turn the restart scenario ingests: written, then the writing runtime is gone before any ingest ran.
  run('restart-source', { id: 'sess_restart', messages: [] }, [['ensure'], ['appendUser', `question ${SECRET}`], ['appendAssistantText', 'thinking aloud'], ['final', 'the answer']], () =>
    rememberSensitiveValues('sess_restart', [SENSITIVE_CALL])
  );
  globalThis.Date = RealDate;
  rmSync(home, { recursive: true, force: true });
  return { recorded: { now: new RealDate(WRITER_NOW).toISOString(), cwd: '<cwd>', cases }, restartSource: raw['restart-source'] };
}

// ---------------------------------------------------------------- the memory ingest across restarts
async function restartCase(tree, text) {
  const at = (path) => import(pathToFileURL(join(tree, path)).href);
  const tail = await at('src/runtime/memory/lib/ingest/transcript-tail.mjs');
  const offsetsLib = await at('src/runtime/memory/lib/ingest/transcript-offsets.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'session-transcript-ingest-'));
  const file = join(dir, 'sess_restart.jsonl');
  writeFileSync(file, text);
  let persisted = '{}';
  const realNow = Date.now;
  Date.now = () => WRITER_NOW;
  const start = async (label, { killAtPersist = false } = {}) => {
    const inserts = [];
    const db = { query: async (_sql, params) => { inserts.push(params); return { rowCount: 1 }; } };
    const offsets = offsetsLib.createTranscriptOffsets({
      loadMeta: async () => persisted,
      persistMeta: async (json) => {
        if (killAtPersist) throw new Error('killed before the position was persisted');
        persisted = json;
      },
      log: () => {},
    });
    await offsets.load();
    const count = await tail.ingestTranscriptTail({ db, transcriptPath: file, cwd: dir, offsets, resolveProjectId: () => null, log: () => {} });
    const position = offsets.get(file) ?? null;
    return {
      label,
      count,
      inserts: inserts.map(([ts, role, content, sourceRef, sessionId, turn, project, timeSource]) => ({ ts, role, content, sourceRef, sessionId, turn, project, timeSource })),
      position: position && JSON.parse(JSON.stringify(position)),
      persisted: JSON.parse(persisted.split(JSON.stringify(file).slice(1, -1)).join('<file>')),
    };
  };
  const starts = [];
  starts.push(await start('the first start after the writer was killed', { killAtPersist: true }));
  starts.push(await start('a start after one killed before its position was persisted'));
  starts.push(await start('a start with nothing new'));
  Date.now = realNow;
  rmSync(dir, { recursive: true, force: true });
  return { file: 'sess_restart.jsonl (the writer case restart-source)', starts };
}

async function main() {
  const { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
  const { recorderProvenance } = await import('./lib/provenance.mjs');
  const args = parseArgs();
  const tree = resolveTree(args);
  if (args.has('case')) return runTurn(tree, args.get('case'), args.get('out'));
  if (!args.get('patch')) throw new Error(`pass --patch ${PATCH}, the fix the tree carries`);
  const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
  const finalDir = join(FIXTURES_ROOT, 'session-transcript');
  const stage = stageSet(finalDir);
  const scratch = mkdtempSync(join(tmpdir(), 'session-transcript-parent-'));
  const turns = {};
  for (const name of ['turn-lead', 'turn-exec']) {
    const out = join(scratch, `${name}.json`);
    const child = spawnSync(process.execPath, [SELF, '--tree', tree, '--case', name, '--out', out], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 300_000 });
    if (child.status !== 0) throw new Error(`case ${name} failed (${child.status})`);
    turns[name] = JSON.parse(readFileSync(out, 'utf8'));
    writeJson(join(stage, `${name}.json`), { scenario: name, script: SCRIPT, secret: SECRET, sessionId: name === 'turn-lead' ? LEAD_ID : null, ...turns[name] });
  }
  rmSync(scratch, { recursive: true, force: true });
  const { recorded, restartSource } = await writerCases(tree);
  writeJson(join(stage, 'writer.json'), { scenario: 'writer', secret: SECRET, sensitiveCall: SENSITIVE_CALL, ...recorded });
  writeJson(join(stage, 'restart.json'), { scenario: 'restart', ...(await restartCase(tree, restartSource)) });
  writeSetManifest(stage, {
    set: 'session-transcript',
    recorder: RECORDER,
    command: `node ${RECORDER} --tree <b6f10295a export with the patch applied> --patch ${PATCH}`,
    extra: { scenarios: ['turn-lead', 'turn-exec', 'writer', 'restart'], ...recorderProvenance(import.meta.url, [PATCH]) },
    identity,
  });
  commitStage(stage, finalDir);
  console.log('recorded session-transcript');
}
await main();
