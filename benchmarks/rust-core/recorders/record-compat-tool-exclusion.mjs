#!/usr/bin/env node
// Which tools an OpenAI-compatible chat route sends, and what it reports for the ones it leaves
// out (WP-AI-CORE): the REAL Node `OpenAICompatProvider.send` is driven against a local fake
// server; the request body's `tools` and every `onToolExcluded` report are stored. A
// Gemini-family model on this route is held to Google's schema rule, any other model to the
// OpenAI one. No credential, no real provider call.
//
//   node benchmarks/rust-core/recorders/record-compat-tool-exclusion.mjs --tree <dir with node_modules> [--out <cases.json>]
//
// Output (default native/core/fixtures/providers/compat-tool-exclusion/cases.json):
//   cases[] { id, provider, model, tools, sentTools, excluded }
//
// Every user directory is a fresh temp one BEFORE any product module loads; the run ends by
// checking that os.homedir() still resolves into the sandbox (the live ~/.mixdog is never read).
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'compat-exclusion-'));
const dirs = Object.fromEntries(['data', 'home', 'appdata', 'localappdata'].map((name) => [name, join(sandbox, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dirs.data,
  MIXDOG_HOME: dirs.home,
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  APPDATA: dirs.appdata,
  LOCALAPPDATA: dirs.localappdata,
});

const args = process.argv.slice(2);
const flag = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const tree = resolve(flag('tree') ?? process.env.MIXDOG_BENCH_TREE ?? '');
if (!existsSync(join(tree, 'node_modules'))) throw new Error(`tree ${tree} has no node_modules: pass --tree <dir>`);
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(flag('out') ?? join(here, '..', '..', '..', 'native', 'core', 'fixtures', 'providers', 'compat-tool-exclusion', 'cases.json'));

const { OpenAICompatProvider } = await import(
  pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/providers/openai-compat.mjs')).href
);

const STR = { type: 'string' };
const OBJ = (properties, extra = {}) => ({ type: 'object', properties, ...extra });
const tool = (name, inputSchema) => ({ name, description: `The ${name} tool`, inputSchema });
const LOOSE = tool('loose', { description: 'no type' });
const DANGLING = tool('dangling', OBJ({ x: { $ref: '#/$defs/missing' } }));
const TUPLE = tool('tuple', OBJ({ pair: { type: 'array', items: [STR, { type: 'number' }] } }));
const NUMERIC_ENUM = tool('numeric', OBJ({ n: { type: 'integer', enum: [1, 2] } }));
const ROOT_STRING = tool('rooted', { type: 'string', enum: ['a', 'b'] });
const BAD_TYPE = tool('typed', OBJ({ x: { type: 'any' } }));
const OK = tool('lookup', OBJ({ key: STR }, { required: ['key'] }));

const MODELS = ['google/gemini-3-pro', 'gemini-2.5-flash', 'Models/Gemini-3', 'llama-4', 'my-gemini-1', 'gemini', 'vendor/gemini'];
const SETS = [
  ['plain', [OK]],
  ['loose-and-dangling', [LOOSE, DANGLING]],
  ['mixed', [OK, TUPLE, DANGLING, NUMERIC_ENUM, ROOT_STRING, BAD_TYPE]],
];

const MESSAGES = [
  { role: 'system', content: 'You are a fixture assistant.' },
  { role: 'user', content: 'Look up the answer.' },
];
const DONE = `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;

async function withServer(fn) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(DONE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const cases = [];
for (const model of MODELS) {
  for (const [setId, tools] of SETS) {
    const excluded = [];
    const sentTools = await withServer(async (base, requests) => {
      await new OpenAICompatProvider('groq', { apiKey: 'fixture-key-not-a-credential', baseURL: `${base}/v1`, preconnect: false }).send(
        MESSAGES,
        model,
        tools,
        { onToolCall: () => {}, onToolExcluded: (found) => excluded.push(JSON.parse(JSON.stringify(found))) }
      );
      return (requests[0]?.tools ?? []).map((t) => ({ name: t.function.name, parameters: t.function.parameters }));
    });
    cases.push({
      id: `${model} / ${setId}`,
      provider: 'groq',
      model,
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      sentTools,
      excluded,
    });
  }
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ recorder: 'benchmarks/rust-core/recorders/record-compat-tool-exclusion.mjs', cases }, null, 1)}\n`);
// Every home-relative path the product resolves (os.homedir() reads USERPROFILE / HOME) is in the sandbox; the live
// profile is never read.
if (homedir() !== dirs.home) throw new Error(`os.homedir() is ${homedir()}, not the sandbox home ${dirs.home}`);
console.log(`recorded ${cases.length} compat tool-exclusion cases to ${out}`);
