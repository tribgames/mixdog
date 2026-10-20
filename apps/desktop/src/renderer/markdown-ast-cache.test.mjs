import assert from 'node:assert/strict';
import test from 'node:test';
import {
  prefetchMarkdownAsts,
  parseLiveMarkdownAst,
  parseStreamingMarkdownAst,
  readCachedStreamingMarkdownAst,
} from './markdown-worker-client.ts';

const reply = (index) =>
  `## Reply ${index}\n\n| a | b |\n|---|---|\n| ${index} | x |\n\n\`\`\`js\nconst value${index} = [${'1, '.repeat(40)}0];\nfunction f${index}() { return value${index}.map((n) => n * 2); }\n\`\`\`\n`;

test('a scrolled transcript of highlighted replies stays cached across remounts', async () => {
  const texts = Array.from({ length: 200 }, (_, index) => reply(index));
  for (const text of texts) await parseStreamingMarkdownAst(text);
  // The first of 200 code-heavy replies is still resident: a row scrolled out
  // and back reuses its AST instead of re-parsing.
  for (const text of texts) assert.ok(readCachedStreamingMarkdownAst(text), 'evicted a recent reply');
  const first = readCachedStreamingMarkdownAst(texts[0]);
  assert.equal(await parseStreamingMarkdownAst(texts[0]), first);
});

test('prefetch warms the cache for upcoming rows, newest range first', async () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const stale = Array.from({ length: 6 }, (_, index) => `**stale ${index}**\n\n- a\n- b`);
  const next = Array.from({ length: 3 }, (_, index) => `**next ${index}**\n\n| a |\n|---|\n| ${index} |`);
  prefetchMarkdownAsts(stale);
  // A newer range replaces whatever was not sent yet.
  prefetchMarkdownAsts(next);
  for (let attempt = 0; attempt < 40 && !next.every((text) => readCachedStreamingMarkdownAst(text)); attempt += 1) {
    await settle();
  }
  for (const text of next) assert.ok(readCachedStreamingMarkdownAst(text), 'upcoming reply not prefetched');
  // At most the two already in flight of the stale range were parsed.
  assert.ok(stale.filter((text) => readCachedStreamingMarkdownAst(text)).length <= 2);
});

test('live tail snapshots never enter the shared cache', async () => {
  const tail = '**streaming** tail that keeps growing';
  const root = await parseLiveMarkdownAst(tail);
  assert.equal(root.type, 'root');
  assert.equal(readCachedStreamingMarkdownAst(tail), null);
  // The settled text of the same content is remembered.
  await parseStreamingMarkdownAst(tail);
  assert.ok(readCachedStreamingMarkdownAst(tail));
});
