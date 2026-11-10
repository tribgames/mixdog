import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import test, { mock } from 'node:test';

const input = new PassThrough();
const chunks = [];
const output = new Writable({
  write(chunk, _encoding, callback) {
    chunks.push(String(chunk));
    callback();
  },
});

const asks = [];
const closes = [];
let resetResult = 'unset';
const runtimeOptions = [];
const fakeRuntime = {
  provider: 'fake',
  model: 'm1',
  toolMode: 'full',
  contextWindow: 1000,
  rawContextWindow: 1000,
  async ask(prompt, callbacks) {
    asks.push(prompt);
    if (prompt === 'boom') throw new Error('kaput');
    callbacks.onTextDelta('Hel');
    callbacks.onTextDelta('lo!\n');
    await callbacks.onToolCall(1, [{ name: 'read', arguments: { path: 'a.txt' } }]);
    callbacks.onTextDelta('done');
    resetResult = callbacks.onTextReset({ chars: 2 });
    callbacks.onUsageDelta({ inputTokens: 10, outputTokens: 5 });
    return { result: { content: 'Hello!\ndone' } };
  },
  async close(reason) {
    closes.push(reason);
  },
};
mock.module('./mixdog-session-runtime.mjs', {
  namedExports: {
    createMixdogSessionRuntime: async (options) => {
      runtimeOptions.push(options);
      return fakeRuntime;
    },
  },
});

const { runRepl } = await import('./repl.mjs');

const text = () => chunks.join('');
const promptCount = () => text().split('› ').length - 1;
async function typeLine(line, afterPrompt) {
  for (let i = 0; i < 200 && promptCount() < afterPrompt; i++) await sleep(10);
  assert.ok(promptCount() >= afterPrompt, `prompt ${afterPrompt} never appeared:\n${text()}`);
  input.write(`${line}\n`);
}

test('runRepl streams a turn, reports errors and slash commands, and exits once', async () => {
  const done = runRepl({ provider: 'fake', model: 'm1', toolMode: 'full', input, output });
  await typeLine('hello', 1);
  await typeLine('boom', 2);
  await typeLine('/model', 3);
  await typeLine('/mode', 4);
  await typeLine('/nope', 5);
  await typeLine('/exit', 6);
  assert.equal(await done, 0);

  const out = text();
  assert.deepEqual(runtimeOptions, [{ provider: 'fake', model: 'm1', toolMode: 'full' }]);
  assert.deepEqual(asks, ['hello', 'boom']);
  assert.match(out, /mixdog — fake\/m1 · full/);
  assert.match(out, /Type a message, or \/help for commands/);
  // Streamed tokens land live; the tool card breaks away from the unterminated
  // text with exactly one newline, and the plain (non-TTY) turn end keeps the
  // raw stream and terminates the line.
  assert.match(out, /Hello!\n[^\n]*read[^\n]*\n/);
  assert.match(out, /done\n/);
  assert.equal(resetResult, false, 'text reset is refused without colors');
  assert.match(out, /\[error\] kaput/);
  assert.match(out, /current model: fake\/m1/);
  assert.match(out, /usage: \/model <preset-or-model>/);
  assert.match(out, /current mode: full/);
  assert.match(out, /unknown command: \/nope/);
  assert.match(out, /bye\./);
  assert.deepEqual(closes, ['cli-exit']);
  assert.equal(promptCount(), 6);
});
