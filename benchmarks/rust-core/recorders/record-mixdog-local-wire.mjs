#!/usr/bin/env node
// mixdog-local-wire.test.mjs (3 tests): the real `toLocalProviderMessages` (instruction merge) and the real MixdogLocalProvider sending a tool-call
// turn and its follow-up through the product's own `ensureLocalProviderServer` (GPU detection, launch arguments, health check, capability probe)
// to a stand-in `llama-server` process (standins/): a real executable the product spawns with the real command line, listening on a loopback
// port, scripted as a strict single-system local endpoint; the GPU query runs a stand-in `nvidia-smi` found first on PATH with a fixed answer per case.
//   node benchmarks/rust-core/recorders/record-mixdog-local-wire.mjs --tree <exact export of b6f10295a>
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { startRecording } from './lib/provider-case-recorder.mjs';

// The recorder's endpoint redirects every fetch; the stand-in server is a real loopback process, so loopback fetches go straight to the network stack.
const nativeFetch = globalThis.fetch;
const STANDINS = 'benchmarks/rust-core/recorders/standins';
const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-mixdog-local-wire',
  dataFiles: [`${STANDINS}/launcher.cs`, `${STANDINS}/standin.mjs`],
  entry: 'mixdog-local-wire.mjs toLocalProviderMessages(history); mixdog-local.mjs new MixdogLocalProvider({}).send(messages, <registered model id>, tools, { signal, onToolCall }) with the product\'s own ensureLocalProviderServer (local-provider/server.mjs): the runtime folder <data>/local-provider/runtime/b10621 holds a stand-in llama-server.exe (a native launcher, standins/launcher.cs, running standins/standin.mjs) and <data>/local-provider/models a 64-byte weights file registered through registerLocalModel; the hardware query runs the stand-in nvidia-smi.exe first on PATH (its fixed answer is the case input `nvidiaSmi`). The product spawns the stand-in with the real command line; its argv, working directory, CUDA_VISIBLE_DEVICES and every request it receives (health check, /props, chat) are the recorded launches and requests (the OpenAI SDK sends real HTTP to it; it answers 400 if a system message is not first). Not run here: Apple Silicon (a darwin host: native sysctl and the machine\'s own RAM and CPU name decide the GPU and its launch arguments).',
  pure: { 'instructions-merge': 'none in o1: local/mod.rs:64 merge_instructions(&mut Value) takes the lowered request body, not the history (roles developer / content arrays) this case feeds', 'cancelled-send-starts-no-server': 'none in o1: no public function takes a send cancelled before the request slot and returns that no query ran and no server started' },
  compare: 'mixdog-ai providers::local (local/mod.rs:109-132) and mixdog-services local_provider provider.rs:231-233: compare, in order, the GPU query (the EXEC request: argv and the stand-in answer), the launch (argv, cwd, CUDA_VISIBLE_DEVICES), the requests the stand-in received (health, props, chat: body incl. the single merged system message and tool_call_id), the results, the dispatched calls and the signal-free cancellation; a pre-cancelled send never queries the GPU nor starts a server.',
  replay: "none in o1 for the whole send: mixdog-ai providers::local (local/mod.rs:109 adapter(), :86 LocalRewriter, :64 pub merge_instructions(&mut Value)) takes the lowered request body, not the history Node's toLocalProviderMessages takes, and the server start / GPU query / launch (mixdog_services::local_provider) has no public function of the recorded input and output. Replay at wire level: a stand-in llama-server process and a stand-in nvidia-smi first on PATH, fed the recorded answers, then compare the EXEC and HTTP exchanges in order and the launches.",
  exclusions: [
    'launches and requests of the stand-in llama-server (the case result `launches` and the row `requests`): the loopback port (random) is written as <port> in argv after --port, in the Host header and in origin; the API key (random, 32 bytes hex, minted by the product per start) is written as <api-key> in argv after --api-key and in the Authorization header, with the stand-in\'s own check `authorized` (the bearer key it was started with matched) recorded beside it; the data directory is written as <data> in argv (--model) and cwd, with forward slashes; every other argument and header is recorded and compared as it arrived',
    'the stand-in answers the health check once per start: the product polls /health until the first answer, a refused connection never reaches the stand-in, so the one health request it received is the whole health record',
    'Apple Silicon is not recorded: the launch arguments on that platform (GPU uuid MTL0, memory from the host\'s RAM and CPU name via native os calls) depend on the host; the NVIDIA kinds (none via failing query, none via empty listing, insufficient free memory, one GPU, two GPUs) are recorded',
  ],
});
const recorderFetch = globalThis.fetch;
globalThis.fetch = (input, init) => (new URL(input instanceof Request ? input.url : String(input)).hostname === '127.0.0.1' ? nativeFetch(input, init) : recorderFetch(input, init));
const standinDir = join(rec.dataDir, 'standin');
const binDir = join(standinDir, 'bin');
const SOURCE_ROOT = new URL('./standins/', import.meta.url);
mkdirSync(binDir, { recursive: true });
const csc = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
execFileSync(csc, ['/nologo', `/out:${join(standinDir, 'launcher.exe')}`, 'launcher.cs'], { cwd: fileURLToPath(SOURCE_ROOT), timeout: 60_000 });
copyFileSync(join(standinDir, 'launcher.exe'), join(binDir, 'nvidia-smi.exe'));
process.env.STANDIN_NODE = process.execPath;
process.env.STANDIN_SCRIPT = fileURLToPath(new URL('standin.mjs', SOURCE_ROOT));
process.env.STANDIN_DIR = standinDir;
// The lifeline: every launcher connects to this pipe and exits when it ends, i.e. when this process ends (finished, failed or killed), taking
// its stand-in with it (kill-on-close job). The recorder never writes to it; it does not keep the recorder alive.
const LIFELINE = `mixdog-standin-lifeline-${process.pid}`;
const lifeline = net.createServer((socket) => socket.unref().on('error', () => {}));
await new Promise((resolve, reject) => lifeline.once('error', reject).listen(`\\\\.\\pipe\\${LIFELINE}`, resolve));
lifeline.unref();
process.env.STANDIN_LIFELINE = LIFELINE;
process.env.PATH = `${binDir}${delimiter}${process.env.PATH}`;
const logPath = join(standinDir, 'standin.log.jsonl');
const answerPath = join(standinDir, 'nvidia-smi.answer.json');
const takeLog = () => {
  const text = readFileSync(logPath, 'utf8');
  writeFileSync(logPath, '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
};
writeFileSync(logPath, '');

const { MixdogLocalProvider } = await rec.P('agent/orchestrator/providers/mixdog-local.mjs');
const { toLocalProviderMessages } = await rec.P('agent/orchestrator/providers/mixdog-local-wire.mjs');
const { registerLocalModel, huggingFaceFileUrl } = await rec.raw('local-provider/registered-models.mjs');
const { stopLocalProviderServer } = await rec.raw('local-provider/server.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/mixdog-local-wire.test.mjs';

const history = [
  { role: 'system', content: 'base', cacheTier: 'tier1' },
  { role: 'system', content: [{ type: 'text', text: 'profile' }], cacheTier: 'tier2' },
  { role: 'user', content: 'hello' },
  { role: 'developer', content: 'runtime instructions' },
  { role: 'assistant', content: 'reply' },
];
await rec.run('instructions-merge', `${SRC}:8`, { history }, () => {
  const saved = structuredClone(history);
  const merged = toLocalProviderMessages(history);
  let imageError = null;
  try {
    toLocalProviderMessages([{ role: 'system', content: [{ type: 'image_url', image_url: { url: 'not-text' } }] }]);
  } catch (error) {
    imageError = error;
  }
  return { merged, historyUnchanged: JSON.stringify(history) === JSON.stringify(saved), imageError };
});

const dataPath = (path) => {
  const text = path.replaceAll('\\', '/');
  return text.startsWith(rec.dataDir) ? `<data>${text.slice(rec.dataDir.length)}` : text;
};
const launchRow = (e) => ({ executable: dataPath(e.self), argv: e.argv.map((arg, i) => (e.argv[i - 1] === '--port' ? '<port>' : e.argv[i - 1] === '--api-key' ? '<api-key>' : e.argv[i - 1] === '--model' ? dataPath(arg) : arg)), cwd: dataPath(e.cwd), cudaVisibleDevices: e.cudaVisibleDevices });
const requestRow = ({ request, reply }) => ({
  method: request.method,
  origin: 'http://127.0.0.1:<port>',
  path: request.path,
  headers: request.headers.map(([name, value]) => [name, /^host$/i.test(name) ? '127.0.0.1:<port>' : /^authorization$/i.test(name) ? 'Bearer <api-key>' : value]),
  body: request.body,
  authorized: request.authorized,
  reply,
});

// One tiny registered model (the product's own registry) with a 64-byte weights file in the product's model folder, and the runtime folder of the pinned version
// holding the stand-in llama-server.exe at the manifest's executable name.
const MODEL = 'hf-a1b2c3d4e5f60718293a4b5c';
const weights = Buffer.alloc(64, 7);
rec.write(`local-provider/models/${MODEL}.gguf`, weights);
registerLocalModel({ id: MODEL, name: 'Fixture tiny model', filename: `${MODEL}.gguf`, sha256: createHash('sha256').update(weights).digest('hex'), size: weights.length, contextWindow: 16384, estimatedVramBytes: 4096, minimumVramBytes: 4096, repository: 'fixture/tiny-model', revision: 'a'.repeat(40), remoteFilename: 'tiny.gguf', url: huggingFaceFileUrl('fixture/tiny-model', 'a'.repeat(40), 'tiny.gguf') }, rec.dataDir);
const runtimeDir = join(rec.dataDir, 'local-provider', 'runtime', 'b10621');
mkdirSync(runtimeDir, { recursive: true });
copyFileSync(join(standinDir, 'launcher.exe'), join(runtimeDir, 'llama-server.exe'));

const tools = [{ name: 'lookup', description: 'Read a value', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }];
const messages = ['base', 'profile', 'workflow', 'environment'].map((content) => ({ role: 'system', content }));
messages.push({ role: 'user', content: 'Look up the answer.' });
const NVIDIA_LINE = (index, uuid, name, totalMiB, freeMiB) => `${index}, GPU-${uuid}, ${name}, ${totalMiB}, ${freeMiB}\n`;
const SMI = {
  'one-gpu': { stdout: NVIDIA_LINE(0, '0f1e2d3c-4b5a-6978-8897-a6b5c4d3e2f1', 'NVIDIA Fixture GPU', 24576, 24000), stderr: '', exitCode: 0 },
  'two-gpus': { stdout: NVIDIA_LINE(0, '0f1e2d3c-4b5a-6978-8897-a6b5c4d3e2f1', 'NVIDIA Fixture GPU', 24576, 1) + NVIDIA_LINE(1, '1a2b3c4d-5e6f-7081-9293-a4b5c6d7e8f9', 'NVIDIA Fixture GPU', 24576, 24000), stderr: '', exitCode: 0 },
  'no-free-memory': { stdout: NVIDIA_LINE(0, '0f1e2d3c-4b5a-6978-8897-a6b5c4d3e2f1', 'NVIDIA Fixture GPU', 24576, 0), stderr: '', exitCode: 0 },
  'empty-listing': { stdout: '', stderr: '', exitCode: 0 },
  'query-fails': { stdout: '', stderr: 'NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.\n', exitCode: 9 },
};
// A turn through the real provider: the product starts (or reuses) the server itself. `fn` returns what the case observed; an error it throws is what the send rejected with.
const caseOn = (id, line, smiKind, send) => rec.run(id, `${SRC}:${line}`, { nvidiaSmi: smiKind === null ? null : SMI[smiKind], messages, tools }, async ({ net }) => {
  if (smiKind !== null) writeFileSync(answerPath, JSON.stringify(SMI[smiKind]));
  const observed = {};
  try {
    Object.assign(observed, await send(new MixdogLocalProvider({})));
  } catch (error) {
    observed.sendError = error;
  } finally {
    await stopLocalProviderServer();
  }
  const entries = takeLog();
  // The exchanges with the stand-ins in the order they happened: the GPU query (a process run: its argv and the stand-in's fixed answer) and the HTTP requests of the stand-in server.
  for (const entry of entries) {
    if (entry.tool === 'nvidia-smi') net.records.push({ method: 'EXEC', origin: 'process', path: 'nvidia-smi', argv: entry.argv, headers: [], body: '', reply: entry.reply });
    else if (entry.request) net.records.push(requestRow(entry));
  }
  return { ...observed, launches: entries.filter((e) => e.tool === 'llama-server' && e.argv).map(launchRow) };
});
const twoTurns = async (provider) => {
  const sent = structuredClone(messages);
  const dispatched = [];
  const first = await provider.send(sent, MODEL, tools, { signal: new AbortController().signal, onToolCall: (call) => dispatched.push(call) });
  sent.push({ role: 'assistant', content: first.content, toolCalls: first.toolCalls });
  sent.push({ role: 'tool', toolCallId: first.toolCalls[0].id, content: '42' });
  const second = await provider.send(sent, MODEL, tools, { signal: new AbortController().signal });
  return { first, dispatched, second, systemMessagesLeftInHistory: sent.filter((m) => m.role === 'system').length };
};
const oneTurn = async (provider) => ({ first: await provider.send(structuredClone(messages), MODEL, tools, {}) });
await caseOn('streamed-tool-call-single-system', 30, 'one-gpu', twoTurns);
await caseOn('two-gpus-most-free-memory-selected', 30, 'two-gpus', oneTurn);
await caseOn('no-gpu-query-fails', 30, 'query-fails', oneTurn);
await caseOn('no-gpu-empty-listing', 30, 'empty-listing', oneTurn);
await caseOn('gpu-without-free-memory', 30, 'no-free-memory', oneTurn);
await caseOn('cancelled-send-starts-no-server', 120, null, (provider) => provider.send([], MODEL, [], { signal: AbortSignal.abort(new Error('cancelled')) }));
await rec.finish();
