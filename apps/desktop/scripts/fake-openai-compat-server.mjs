// Fake OpenAI-compatible chat server (diagnosis tooling).
//
//   node apps/desktop/scripts/fake-openai-compat-server.mjs [--port=9377]
//
// Serves /models and a streaming /chat/completions that replays a scripted
// turn: a reasoning phase (reasoning_content deltas), then Markdown text
// deltas, then a stop. Lets the real desktop app run a full turn — thinking
// band, streaming tail, settled row — without a model or credentials.
import { createServer } from 'node:http';

const port = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) || 9377);
const MODEL = 'deepseek-v4-pro';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const REASONING = 'The user wants a short reply. I should answer with a heading, a paragraph and a code block. '.repeat(3);
const ANSWER = [
  '## Scripted reply\n\n',
  'This is a streamed paragraph from the fake provider. It wraps across the pane width so the row grows as tokens arrive. ',
  'More words follow to make the assistant row taller than one line and to exercise Markdown measurement.\n\n',
  '```typescript\nconst streamed = true;\nexport function done() { return streamed; }\n```\n\n',
  'A closing line after the code block.',
].join('');

function chunks(text, size) {
  const out = [];
  for (let index = 0; index < text.length; index += size) out.push(text.slice(index, index + size));
  return out;
}

function readBody(request) {
  return new Promise((done) => {
    let raw = '';
    request.on('data', (part) => { raw += part; });
    request.on('end', () => done(raw));
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  if (request.method === 'GET' && /\/models$/.test(url.pathname)) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', context_window: 128000, max_output_tokens: 8192 }] }));
    return;
  }
  if (request.method === 'POST' && /\/chat\/completions$/.test(url.pathname)) {
    const raw = await readBody(request);
    let body = {};
    try { body = JSON.parse(raw); } catch { /* keep defaults */ }
    const id = `chatcmpl-fake-${Date.now()}`;
    const usage = { prompt_tokens: 120, completion_tokens: 90, total_tokens: 210 };
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id, object: 'chat.completion', model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: ANSWER, reasoning_content: REASONING }, finish_reason: 'stop' }], usage }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (delta, extra = {}) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: MODEL,
      choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`);
    await sleep(350);
    send({ role: 'assistant', content: '' });
    for (const piece of chunks(REASONING, 24)) { await sleep(90); send({ reasoning_content: piece }); }
    await sleep(250);
    for (const piece of chunks(ANSWER, 14)) { await sleep(45); send({ content: piece }); }
    await sleep(120);
    response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
    response.write('data: [DONE]\n\n');
    response.end();
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { message: `no route ${request.method} ${url.pathname}` } }));
});
server.listen(port, '127.0.0.1', () => {
  console.log(`fake-openai-compat listening on http://127.0.0.1:${port}/v1 model=${MODEL}`);
});
