import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./fake-openai-compat-server.mjs', import.meta.url));

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function withServer(run) {
  const port = await freePort();
  const child = spawn(process.execPath, [script, `--port=${port}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
  }
}

const chat = (base, stream) =>
  fetch(`${base}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ stream }) });

test('lists its one model and answers unknown routes with a 404 error', async () => {
  await withServer(async (base) => {
    const models = await (await fetch(`${base}/v1/models`)).json();
    assert.deepEqual(
      models.data.map((model) => model.id),
      ['deepseek-v4-pro']
    );
    const missing = await fetch(`${base}/nowhere`);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error.message, /no route GET \/nowhere/);
  });
});

test('a non-streaming completion carries reasoning, answer and usage', async () => {
  await withServer(async (base) => {
    const body = await (await chat(base, false)).json();
    assert.equal(body.object, 'chat.completion');
    assert.match(body.choices[0].message.reasoning_content, /^The user wants a short reply/);
    assert.match(body.choices[0].message.content, /^## Scripted reply/);
    assert.deepEqual(body.usage, { prompt_tokens: 120, completion_tokens: 90, total_tokens: 210 });
  });
});

test('a streamed completion sends reasoning deltas, then content, then a stop chunk with usage and [DONE]', async () => {
  await withServer(async (base) => {
    const response = await chat(base, true);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const frames = (await response.text()).split('\n\n').filter(Boolean);
    assert.equal(frames.at(-1), 'data: [DONE]');
    const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame.slice('data: '.length)));
    const deltas = chunks.map((chunk) => chunk.choices[0].delta);
    const firstContent = deltas.findIndex((delta) => delta.content);
    const lastReasoning = deltas.findLastIndex((delta) => delta.reasoning_content);
    assert.ok(lastReasoning >= 0 && lastReasoning < firstContent);
    assert.match(
      deltas.map((delta) => delta.content ?? '').join(''),
      /^## Scripted reply[\s\S]*A closing line after the code block\.$/
    );
    const last = chunks.at(-1);
    assert.equal(last.choices[0].finish_reason, 'stop');
    assert.equal(last.usage.total_tokens, 210);
  });
});
