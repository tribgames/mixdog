/**
 * stream-reveal-hold.test.mjs — where a streamed reply may stop painting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMarkdownToHast } from './markdown-ast.ts';
import { pacedRevealCeiling, pacedRevealStep, revealHold } from './stream-reveal-hold.ts';

/** What paints of `text` cut at `cut` (the reveal) while it streams. */
const painted = (text, cut = text.length, live = true) => text.slice(0, revealHold(text, cut, live));

test('code spans, links and emphasis are not held: their words stream (the healer hides the markers)', () => {
  assert.equal(painted('Run `npm ins'), 'Run `npm ins');
  assert.equal(painted('See [the docs](https://exa'), 'See [the docs](https://exa');
  for (const opener of ['*', '_', '**', '__', '~~']) {
    assert.equal(painted(`a ${opener}bold wor`), `a ${opener}bold wor`, opener);
  }
  const text = 'Use `npm install` and [docs](x) then **go**.';
  for (let cut = 1; cut <= text.length; cut += 1) {
    const shown = painted(text, cut);
    assert.ok(shown === text.slice(0, cut) || shown === text.slice(0, cut - 1), `cut ${cut}: ${JSON.stringify(shown)}`);
  }
});

test('an image is held from its opener until its destination closes', () => {
  assert.equal(painted('An ![ima'), 'An ');
  assert.equal(painted('An ![image]'), 'An ', 'a `]` at the received end may still open the destination');
  assert.equal(painted('An ![image](a.pn'), 'An ');
  assert.equal(painted('An ![image](a.png) here'), 'An ![image](a.png) here');
  const text = 'An ![image](a.png) here';
  assert.equal(painted(text, text.indexOf('a.png')), 'An ', 'held to its start inside a finished image');
  assert.equal(painted('An ![x] here'), 'An ![x] here', 'brackets that are no image');
  assert.equal(painted('Run `![x` now'), 'Run `![x` now', 'not inside a code span');
  assert.equal(painted('escaped \\![x'), 'escaped \\![x');
});

test('block markers show with the first glyph after them; headings and table rows as whole lines', () => {
  assert.equal(painted('Intro\n- '), 'Intro\n');
  assert.equal(painted('Intro\n1. '), 'Intro\n');
  assert.equal(painted('Intro\n- [x] '), 'Intro\n');
  assert.equal(painted('Intro\n- f'), 'Intro\n- f');
  assert.equal(painted('Intro\n> '), 'Intro\n');
  assert.equal(painted('Intro\n> q'), 'Intro\n> q');
  assert.equal(painted('Intro\n## Setup ste'), 'Intro\n');
  assert.equal(painted('Intro\n## Setup steps\nNext'), 'Intro\n## Setup steps\nNext');
  assert.equal(painted('Intro\n#hashtag'), 'Intro\n#hashtag', 'not a heading');
  const table = 'Summary:\n| a | b |\n| --- | --- |\n| 1 | 2';
  assert.equal(painted(table), 'Summary:\n| a | b |\n| --- | --- |\n', 'a row waits for its line end');
  assert.equal(painted('Summary:\n| a | b'), 'Summary:\n', 'the first row too');
  const bare = 'Summary:\nname | size\n--- | ---\nx | 1';
  assert.equal(painted(bare, bare.indexOf('size')), 'Summary:\n', 'a header without a leading pipe');
  assert.equal(painted(bare), 'Summary:\nname | size\n--- | ---\n', 'a row under the delimiter');
});

test('a table header appears only together with its delimiter row', () => {
  const table = 'Summary:\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';
  const header = table.indexOf('| --- |');
  assert.equal(painted(table, header), 'Summary:\n', 'the header waits at its line end');
  assert.equal(painted(table, header + 4), 'Summary:\n', 'and while the delimiter row is revealed');
  assert.equal(painted('Summary:\n| a | b |\n'), 'Summary:\n', 'nothing after the header yet');
  assert.equal(painted('Summary:\n| a | b |\n| --'), 'Summary:\n', 'a partial delimiter row');
  assert.equal(painted('Summary:\na | b\n--- | -'), 'Summary:\n', 'a header without a leading pipe');
  assert.equal(painted(table, table.indexOf('| 1 |')), 'Summary:\n| a | b |\n| --- | --- |\n');
  assert.equal(painted('use a | b here\nNext line'), 'use a | b here\nNext line', 'prose with a pipe');
  assert.equal(painted('use a | b here\n\nNext'), 'use a | b here\n\nNext');
  assert.equal(painted('done a | b\n', 11, false), 'done a | b\n', 'settled text is never held');
});

test('code reveals line by line, a possible closing fence included', () => {
  const code = 'Run:\n```js\nconst a = 1;\nconst b';
  assert.equal(painted(code), 'Run:\n```js\nconst a = 1;\n');
  assert.equal(painted('Run:\n```j'), 'Run:\n', 'the fence line waits for its end');
  assert.equal(painted('Run:\n```js\nx\n``'), 'Run:\n```js\nx\n', 'a half closing fence');
  assert.equal(painted('Run:\n```js\nx\n```'), 'Run:\n```js\nx\n', 'a closing fence waits for its line end');
  assert.equal(painted('Run:\n```js\nx\n```\nDone'), 'Run:\n```js\nx\n```\nDone');
  assert.equal(
    painted('Run:\n```js\nlet s = `a [b *c\n'),
    'Run:\n```js\nlet s = `a [b *c\n',
    'no inline holds in code'
  );
});

test('a trailing marker waits for the character after it while the text streams; settled text is never held', () => {
  assert.equal(painted('Done!'), 'Done');
  assert.equal(painted('Done! Next'), 'Done! Next');
  assert.equal(painted('a <'), 'a ');
  assert.equal(painted('Run `npm ins', 12, false), 'Run `npm ins', 'the settled end shows whole');
  assert.equal(painted('Done!', 5, false), 'Done!');
});

const paced = (text) => text.slice(0, pacedRevealCeiling(text));

test('paced: only a bare list or heading marker and a closing fence being typed are held', () => {
  for (const marker of ['- ', '* ', '12. ', '3)', '7', '- [', '- [x', '- [x] ', '> - ', '#', '## ', '> ###']) {
    assert.equal(paced(`Intro\n${marker}`), 'Intro\n', JSON.stringify(marker));
  }
  assert.equal(paced('Intro\n- item'), 'Intro\n- item', 'the first glyph after the marker shows');
  assert.equal(paced('## Head'), '## Head', 'heading text streams within its line');
  assert.equal(paced('```ts\nconst a = 1;\nconst b'), '```ts\nconst a = 1;\nconst b', 'code lines stream');
  assert.equal(paced('```ts\nconst a = 1;\n``'), '```ts\nconst a = 1;\n', 'a closing fence being typed waits');
  assert.equal(paced('```ts\nconst a = 1;\n```'), '```ts\nconst a = 1;\n```', 'a whole closing fence shows');
  assert.equal(paced('| a | b'), '', 'a table row waits for its newline');
  assert.equal(paced('An ![ima'), 'An ![ima', 'images are not held');
  assert.equal(paced('a <'), 'a <');
  assert.equal(paced('Use **bo'), 'Use **bo');
});

test('paced step: cut back to the last space past half a step; never stop on a bare marker', () => {
  const text = 'alpha beta gamma delta epsilon zeta';
  // 22 characters on from 0 end on the space after "delta": the step ends
  // after it.
  assert.equal(text.slice(0, pacedRevealStep(text, 0, text.length, 22)), 'alpha beta gamma delta ');
  assert.equal(text.slice(0, pacedRevealStep(text, 0, text.length, 20)), 'alpha beta gamma ', 'back to the space');
  const long = 'abcdefghijklmnopqrstuvwxyz';
  assert.equal(pacedRevealStep(long, 0, long.length, 22), 22, 'no space: the plain cut');
  assert.equal(pacedRevealStep('ab cdefghijklmnopqrstuvwxyz', 0, 27, 22), 22, 'a space before half a step is ignored');
  const list = 'Intro words.\n- first item here';
  assert.equal(
    list.slice(0, pacedRevealStep(list, 0, list.length, 15)),
    'Intro words.\n',
    'stops before the marker line'
  );
  assert.equal(list.slice(13, pacedRevealStep(list, 13, list.length, 2)), '- fi', 'steps on past the marker');
});

test('paced: a streaming table never paints a partial row; prose stays word by word', () => {
  const full = 'Intro words here\n\n| a | b |\n|---|---|\n| one | two |\n| three | four |\nAfter the table words.';
  for (let at = 1; at <= full.length; at += 1) {
    const shown = paced(full.slice(0, at));
    const tail = shown.slice(shown.lastIndexOf('\n') + 1);
    assert.ok(!tail.includes('|'), `partial row at ${at}: ${JSON.stringify(tail)}`);
  }
  assert.equal(paced('Intro\n\n| a | b |\n|---|---|\n| one | tw'), 'Intro\n\n| a | b |\n|---|---|\n');
  assert.equal(paced('Intro\n\n| a | b |\n|---|---|\n| one | two |'), 'Intro\n\n| a | b |\n|---|---|\n');
  assert.equal(
    paced('Intro\n\n| a | b |\n|---|---|\n| one | two |\n'),
    'Intro\n\n| a | b |\n|---|---|\n| one | two |\n',
    'the row appears with its newline'
  );
  assert.equal(paced('Some prose wor'), 'Some prose wor', 'prose streams');
  const table = 'Intro\n\n| a | b |\n|---|---|\n| one | two |\n';
  // (a) The parser renders a line directly under a body row as a table row,
  // so it waits for its newline like one.
  assert.equal(paced(`${table}After the table wor`), table, 'a line right under a row is a row');
  assert.equal(paced(`${table}After the table words.\n`), `${table}After the table words.\n`);
  // (b) Prose after a blank line streams word by word.
  assert.equal(paced(`${table}\nAfter the table wor`), `${table}\nAfter the table wor`);
  // (c) A heading, list item, quote or fence after the table is no row.
  assert.equal(paced(`${table}## Head wor`), `${table}## Head wor`);
  assert.equal(paced(`${table}- item wor`), `${table}- item wor`);
  assert.equal(paced(`${table}> quote wor`), `${table}> quote wor`);
  assert.equal(paced(`${table}\`\`\`ts\ncode wor`), `${table}\`\`\`ts\ncode wor`);
  assert.equal(paced(`${table}## Head\nprose wor`), `${table}## Head\nprose wor`, 'prose after a heading');
  // Held iff the real parser renders the line as a table row.
  const isRow = (node, word) =>
    node.tagName === 'tr'
      ? JSON.stringify(node).includes(word)
      : (node.children ?? []).some((child) => isRow(child, word));
  for (const [source, word] of [
    ['| a | b |\n| - | - |\n| c | d |\n---\nprose wor', 'prose'],
    ['| a | b |\n| - | - |\n| c | d |\n> q\nprose wor', 'prose'],
    ['> | a | b |\n> | - | - |\n> | c | d |\n>> nested prose wor', 'nested'],
    ['| a | b |\n| - | - |\n| c | d |\n<div>html wor', 'html'],
    ['| a | b |\n| - | - |\n| c | d |\nplain row wor', 'plain'],
  ]) {
    const parsed = isRow(parseMarkdownToHast(`${source}\n`), word);
    assert.equal(paced(source) !== source, parsed, `${JSON.stringify(source)} held iff a row (parser: ${parsed})`);
  }
  // A step through a table never ends mid-row.
  const text = 'Intro\n\n| a | b |\n|---|---|\n| one | two |\n\nTail words';
  let from = 0;
  while (from < text.length) {
    const end = pacedRevealStep(text, from, pacedRevealCeiling(text), 4);
    assert.ok(end > from, 'progress');
    const shown = text.slice(0, end);
    assert.ok(!shown.slice(shown.lastIndexOf('\n') + 1).includes('|'), JSON.stringify(shown));
    from = end;
  }
});
