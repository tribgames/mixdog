// The scripted program behind the stand-in executables (launcher.cs): `node standin.mjs <path of the executable> <its arguments...>`.
//   nvidia-smi   prints the fixed answer in `nvidia-smi.answer.json` (stdout, stderr, exitCode) and exits with its code.
//   llama-server takes the real command line (--host --port --api-key --model --alias --ctx-size ...), listens there, answers the
//                health check, the capability endpoint and the chat wire, and checks the bearer key it was started with.
// Every launch (argv, working directory, the one environment variable the product sets) and every request it receives (method, path, headers
// in arrival order, body bytes, whether the bearer key matched, the reply) is appended to `standin.log.jsonl` in STANDIN_DIR for the recorder.
import { appendFileSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { basename, join } from 'node:path';

const [self, ...argv] = process.argv.slice(2);
const dir = process.env.STANDIN_DIR;
const log = (entry) => appendFileSync(join(dir, 'standin.log.jsonl'), `${JSON.stringify(entry)}\n`);
const tool = basename(self).replace(/\.exe$/i, '').toLowerCase();

if (tool === 'nvidia-smi') {
  const answer = JSON.parse(readFileSync(join(dir, 'nvidia-smi.answer.json'), 'utf8'));
  log({ tool, self, argv, reply: answer });
  process.stdout.write(answer.stdout);
  process.stderr.write(answer.stderr);
  process.exit(answer.exitCode);
}

const option = (name) => argv[argv.indexOf(name) + 1];
const apiKey = option('--api-key');
const port = Number(option('--port'));
log({ tool, self, argv, cwd: process.cwd(), cudaVisibleDevices: 'CUDA_VISIBLE_DEVICES' in process.env ? { set: true, value: process.env.CUDA_VISIBLE_DEVICES } : { set: false } });

// The stand-in is not a daemon: it ends when the process that started it (the launcher) is gone.
setInterval(() => {
  try {
    process.kill(process.ppid, 0);
  } catch {
    process.exit(0);
  }
}, 200);

const json = (status, value) => ({ status, contentType: 'application/json', body: JSON.stringify(value) });
const answer = (request) => {
  if (request.path === '/health') return json(200, { status: 'ok' });
  if (request.path === '/props') return json(200, { chat_template_caps: { supports_tools: true, supports_tool_calls: true } });
  if (request.method === 'POST' && request.path === '/v1/chat/completions') {
    const body = JSON.parse(request.body);
    if (body.messages.some((message, index) => message.role === 'system' && index !== 0)) {
      return json(400, { error: { message: 'System message must be at the beginning.' } });
    }
    const followup = body.messages.at(-1).role === 'tool';
    const delta = followup ? { content: 'The result is 42.' } : { tool_calls: [{ index: 0, id: 'call_local', type: 'function', function: { name: 'lookup', arguments: '{"key":"answer"}' } }] };
    const chunk = { id: 'local-response', model: body.model, choices: [{ index: 0, delta, finish_reason: followup ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 8 } };
    return { status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n` };
  }
  return json(404, { error: { message: 'not scripted' } });
};

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const text = raw.toString('utf8');
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
    const request = { method: req.method, path: req.url, headers, body: text, authorized: req.headers.authorization === `Bearer ${apiKey}` };
    const reply = request.authorized ? answer(request) : json(401, { error: { message: 'Invalid API Key' } });
    log({ tool, request, reply });
    res.writeHead(reply.status, { 'content-type': reply.contentType });
    res.end(reply.body);
  })
  .listen(port, '127.0.0.1');
