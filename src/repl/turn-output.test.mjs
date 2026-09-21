import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as ansi from '../ui/ansi.mjs';

let colors = false;
mock.module('../ui/ansi.mjs', {
  namedExports: { ...ansi, colorEnabled: () => colors },
});

const { createStreamSink } = await import('./stream-sink.mjs');
const { finalizeTurnOutput } = await import('./turn-output.mjs');

for (const { name, color, toolCard, expected } of [
  {
    name: 'colored text with a tool card',
    color: true,
    toolCard: true,
    expected: 'hello\n[tool]\n\n',
  },
  {
    name: 'uncolored text without a tool card',
    color: false,
    toolCard: false,
    expected: 'hello\n',
  },
]) {
  test(`finalizeTurnOutput preserves and terminates ${name}`, async () => {
    colors = color;
    const chunks = [];
    const out = { write: (chunk) => chunks.push(chunk) };
    const sink = createStreamSink({ out });
    sink.pushDelta('hello');
    if (toolCard) await sink.writeToolCard(() => '[tool]');
    sink.flush();

    await finalizeTurnOutput({
      out,
      sink,
      finalText: 'hello',
      renderMarkdown: () => assert.fail('the live transcript must not be re-rendered'),
    });

    assert.equal(chunks.join(''), expected);
  });
}
