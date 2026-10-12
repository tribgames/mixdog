import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRichMarkdownRoundTrip, createRichMarkdownCodec } from './rich-markdown-codec.ts';
import { richMarkdownSupport } from './rich-markdown-support.ts';
import { RichMarkdownModelSync } from './rich-markdown-model-sync.ts';
import { createTestModel } from './rich-markdown-test-model.mjs';
import { Transform } from '@tiptap/pm/transform';

const codec = createRichMarkdownCodec();
const FRONT = '---\ntitle: Notes\ntags: [a, b]\n---\n';
const BODY = '# Notes\n\n* first\n* second\n\nSome __bold__ text.\n';

function start(text) {
  const model = createTestModel(text);
  const events = [];
  const sync = new RichMarkdownModelSync(model, codec, {
    onDocument: (doc, frontMatter) => events.push({ kind: 'document', doc, frontMatter }),
    onFrontMatter: (frontMatter) => events.push({ kind: 'frontMatter', frontMatter }),
    onUnsupported: (reason) => events.push({ kind: 'unsupported', reason }),
    onHeld: (reason) => events.push({ kind: 'held', reason }),
  });
  const started = sync.start();
  return { model, sync, events, started };
}

test('loading a document reports it with its front matter and never writes', () => {
  const { model, events, started } = start(FRONT + BODY);
  assert.equal(started, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'document');
  assert.equal(events[0].frontMatter, FRONT);
  assert.equal(events[0].doc.content[0].type, 'heading');
  assert.equal(model.edits.length, 0);
  assert.equal(model.getValue(), FRONT + BODY);
});

test('committing the unedited serialization writes nothing (no formatting churn)', () => {
  const { model, sync, events } = start(FRONT + BODY);
  assert.equal(sync.commit(events[0].doc), false);
  assert.equal(model.edits.length, 0);
  assert.equal(model.getValue(), FRONT + BODY);
});

test('an edit is written as one minimal replacement; front matter and untouched blocks keep their bytes', () => {
  const { model, sync, events } = start(FRONT + BODY);
  const edited = codec.serialize(events[0].doc).replace('Some **bold** text.', 'Some **bold** text, edited.');
  assert.equal(sync.commit(codec.parse(edited)), true);
  assert.equal(model.getValue(), `${FRONT}# Notes\n\n* first\n* second\n\nSome **bold** text, edited.\n`);
  assert.equal(model.edits.length, 1);
  const [edit] = model.edits;
  assert.ok(edit.start >= (FRONT + BODY).indexOf('Some __bold__'), 'the edit starts inside the changed block');
  assert.ok(model.stackElements.count >= 1, 'the edit is its own undo step');
  // Our own write does not reload the editor.
  assert.equal(events.filter((event) => event.kind === 'document').length, 1);
});

test('an indentation-only edit inside a code block is written', () => {
  const code = '# Code\n\n```python\nif x:\n    y()\n```\n';
  const { model, sync, events } = start(code);
  assert.equal(sync.commit(codec.parse(codec.serialize(events[0].doc).replace('    y()', '        y()'))), true);
  assert.equal(model.getValue(), code.replace('    y()', '        y()'));
});

test('CRLF documents stay CRLF after an edit', () => {
  const crlf = (FRONT + BODY).replace(/\n/g, '\r\n');
  const { model, sync, events } = start(crlf);
  sync.commit(codec.parse(codec.serialize(events[0].doc).replace('# Notes', '# Notes!')));
  assert.equal(model.getValue(), crlf.replace('# Notes', '# Notes!'));
});

test('changes made elsewhere reload the editor; identical bodies do not', () => {
  const { model, events } = start(FRONT + BODY);
  model.setValue(FRONT + BODY);
  assert.equal(events.length, 1);
  model.setValue(`${FRONT}# Renamed\n\nNew body.\n`);
  assert.equal(events.length, 2);
  assert.equal(events[1].kind, 'document');
  assert.equal(events[1].doc.content[0].content[0].text, 'Renamed');
  // A front matter-only change refreshes the banner, not the content.
  model.setValue(`---\ntitle: Other\n---\n# Renamed\n\nNew body.\n`);
  assert.deepEqual(events[2], { kind: 'frontMatter', frontMatter: '---\ntitle: Other\n---\n' });
});

test('content that cannot round-trip is reported instead of loaded', () => {
  const initial = start('<div>raw html</div>\n');
  assert.equal(initial.started, false);
  assert.equal(initial.events[0].kind, 'unsupported');
  assert.match(initial.events[0].reason, /HTML/);
  initial.sync.refresh();
  assert.equal(initial.events.length, 1, 'reported once per content');
  initial.model.setValue('# Fixed\n');
  assert.equal(initial.events.at(-1).kind, 'document');

  const { model, events } = start(BODY);
  model.setValue(`${BODY}\n&copy; 2024\n`);
  assert.equal(events.at(-1).kind, 'unsupported');
});

test('a fence line typed inside a code block cannot close it early', () => {
  const { model, sync, events } = start('# Code\n\n```js\nlet a;\n```\n');
  const doc = structuredClone(events[0].doc);
  doc.content[1].content[0].text = 'let a;\n```\nlet b;';
  assert.equal(sync.commit(doc), true);
  assert.equal(model.getValue(), '# Code\n\n````js\nlet a;\n```\nlet b;\n````\n');
  const reread = codec.parse(model.getValue());
  assert.equal(reread.content.length, 2);
  assert.equal(reread.content[1].content[0].text, 'let a;\n```\nlet b;');
});

test('a line break in a table cell is written so it reads back as a break', () => {
  const { model, sync, events } = start('| A | B |\n| --- | --- |\n| one | two |\n');
  const doc = structuredClone(events[0].doc);
  doc.content[0].content[1].content[0].content[0].content = [
    { type: 'text', text: 'one' },
    { type: 'hardBreak' },
    { type: 'text', text: 'more' },
  ];
  assert.equal(sync.commit(doc), true);
  assert.match(model.getValue(), /\| one<br>more \|/);
  const cell = codec.parse(model.getValue()).content[0].content[1].content[0].content[0];
  assert.deepEqual(
    cell.content.map((node) => node.type),
    ['text', 'hardBreak', 'text']
  );
  // The written file opens in the rich editor again.
  const reopened = start(model.getValue());
  assert.equal(reopened.started, true);
});

test('an edit whose Markdown would not read back is held, never written and never dropped silently', () => {
  const original = '| A |\n| --- |\n| one |\n';
  const { model, sync, events } = start(original);
  const doc = structuredClone(events[0].doc);
  // Two paragraphs in a cell: Markdown can only hold one line of them.
  doc.content[0].content[1].content[0].content.push({ type: 'paragraph', content: [{ type: 'text', text: 'two' }] });
  assert.equal(sync.commit(doc), false);
  assert.equal(model.getValue(), original);
  assert.equal(model.edits.length, 0);
  // Reported at once, and saving or leaving is refused while it is held.
  assert.equal(events.at(-1).kind, 'held');
  assert.ok(events.at(-1).reason);
  assert.equal(sync.heldReason, events.at(-1).reason);
  assert.equal(sync.flush(), false);
  assert.equal(sync.canUndo(), true, 'the held edit can be undone (discarded)');
  // A change made elsewhere does not replace the held edit.
  model.setValue('| A |\n| --- |\n| changed |\n');
  assert.equal(events.filter((event) => event.kind === 'document').length, 1);
  assert.equal(events.at(-1).kind, 'held');
  assert.equal(sync.commit(doc), false, 'nor is it written over that change');
  assert.equal(model.getValue(), '| A |\n| --- |\n| changed |\n');
  // Only an explicit discard drops it and loads the file.
  sync.discard();
  assert.deepEqual(
    events.slice(-2).map((event) => event.kind),
    ['held', 'document']
  );
  assert.equal(events.at(-2).reason, null);
  assert.equal(sync.heldReason, null);
  assert.equal(sync.flush(), true);
});

test('a held edit can be read as the whole file for backups, front matter and line endings kept', () => {
  const original = `${FRONT}# T\n\n| A |\n| --- |\n| one |\n\nKeep __this__.\n`.replace(/\n/g, '\r\n');
  const { sync, events } = start(original);
  assert.equal(sync.heldMarkdown(), null);
  const doc = structuredClone(events[0].doc);
  doc.content[1].content[1].content[0].content.push({ type: 'paragraph', content: [{ type: 'text', text: 'two' }] });
  assert.equal(sync.commit(doc), false);
  const held = sync.heldMarkdown();
  assert.ok(held.startsWith(FRONT.replace(/\n/g, '\r\n')));
  assert.match(held, /\| one.*two.*\|\r\n/);
  assert.match(held, /\r\n\r\nKeep __this__\.\r\n$/, 'untouched blocks keep their bytes');
  sync.discard();
  assert.equal(sync.heldMarkdown(), null);
});

test('edits made while held after an outside change still update the held text and its backup', () => {
  const original = '| A |\n| --- |\n| one |\n';
  const { model, sync, events } = start(original);
  const doc = structuredClone(events[0].doc);
  const cell = doc.content[0].content[1].content[0];
  cell.content.push({ type: 'paragraph', content: [{ type: 'text', text: 'two' }] });
  assert.equal(sync.commit(doc), false);
  model.setValue('| A |\n| --- |\n| changed |\n');
  const heldBefore = events.filter((event) => event.kind === 'held').length;
  // Typing on in Rich.
  cell.content[1].content[0].text = 'two three';
  assert.equal(sync.commit(doc), false);
  assert.equal(model.getValue(), '| A |\n| --- |\n| changed |\n', 'the model is not written');
  assert.equal(model.edits.length, 0);
  assert.match(sync.heldMarkdown(), /two three/, 'the held text is the latest visible edit');
  assert.ok(events.filter((event) => event.kind === 'held').length > heldBefore, 'the held edit is reported again');
  assert.ok(events.at(-1).reason);
});

test('text rejected and then restored loads the editor again instead of staying unsupported', () => {
  const { model, sync, events } = start(BODY);
  model.setValue('<div>raw</div>\n');
  assert.equal(events.at(-1).kind, 'unsupported');
  model.setValue(BODY);
  assert.equal(events.at(-1).kind, 'document');
  assert.deepEqual(events.at(-1).doc, codec.parse(BODY));
  sync.refresh();
  assert.equal(events.at(-1).kind, 'document');
});

test('a later edit that can be written releases the held one', () => {
  const original = '| A |\n| --- |\n| one |\n';
  const { model, sync, events } = start(original);
  const broken = structuredClone(events[0].doc);
  broken.content[0].content[1].content[0].content.push({ type: 'paragraph', content: [{ type: 'text', text: 'two' }] });
  sync.commit(broken);
  const fixed = structuredClone(events[0].doc);
  fixed.content[0].content[1].content[0].content[0].content[0].text = 'one two';
  assert.equal(sync.commit(fixed), true);
  assert.deepEqual(events.at(-1), { kind: 'held', reason: null });
  assert.equal(model.getValue(), '| A |\n| --- |\n| one two |\n');
});

test('ordinary text typed one character at a time reaches the model as that text', () => {
  for (const typed of [
    '1) item',
    '2. item',
    '- dash',
    '+ plus',
    '# hash',
    '> quote',
    '---',
    '===',
    '|--|--|',
    '```js',
    '~~~',
    '[ ] box',
    '$x$ math-like',
    'https://example.com/a_b',
    'https://example.com/$HOME$',
    'go https://e.com/$a $b$ and $c$',
    'see www.example.com.',
    'mail a_b@example.com',
  ]) {
    const { model, sync, events } = start('# Title\n\nBody.\n');
    let doc = codec.schema.nodeFromJSON(events[0].doc);
    for (let length = 1; length <= typed.length; length++) {
      const json = doc.toJSON();
      json.content[1] = { type: 'paragraph', content: [{ type: 'text', text: typed.slice(0, length) }] };
      doc = codec.schema.nodeFromJSON(json);
      sync.commit(doc);
      assert.equal(sync.heldReason, null, `${JSON.stringify(typed.slice(0, length))} is held`);
    }
    const reread = codec.parse(model.getValue());
    assert.equal(reread.content.length, 2, JSON.stringify(model.getValue()));
    assert.equal(reread.content[1].type, 'paragraph', JSON.stringify(model.getValue()));
    assert.equal(reread.content[1].content.map((node) => node.text).join(''), typed, JSON.stringify(model.getValue()));
  }
});

test('a single-character edit in a large document is fast: only the changed block is written and checked', () => {
  const section = (i) =>
    `## Section ${i}\n\nSome __bold__ text with *emphasis*, \`code\` and a [link](https://example.com/${i}).\n\n` +
    `* first item ${i}\n* second item\n  * nested\n\n| A | B |\n| --- | --- |\n| ${i} | two |\n\n` +
    `\`\`\`js\nconst x = ${i};\n\`\`\`\n\n> Quote ${i}\n\n`;
  let text = '# Big\n\n';
  let count = 0;
  while (text.length < 100_000) text += section(count++);
  const { model, sync, events } = start(text);
  let doc = codec.schema.nodeFromJSON(events[0].doc);
  let target = -1;
  let seen = 0;
  doc.descendants((node, pos) => {
    if (node.isText && node.text.startsWith('Some ') && seen++ === Math.floor(count / 2)) target = pos + 5;
  });
  const times = [];
  for (let step = 0; step < 6; step++) {
    doc = new Transform(doc).insert(target + step, codec.schema.text('x')).doc;
    const started = performance.now();
    assert.equal(sync.commit(doc), true);
    times.push(performance.now() - started);
  }
  // The first edit compares blocks by value once; later ones by identity.
  const typical = times.slice(1).sort((a, b) => a - b)[2];
  assert.ok(typical < 250, `single-character commits took ${times.map((time) => time.toFixed(1)).join(', ')} ms`);
  const middle = Math.floor(count / 2);
  assert.equal(
    model.getValue(),
    text.replace(
      `Some __bold__ text with *emphasis*, \`code\` and a [link](https://example.com/${middle})`,
      `Some xxxxxx**bold** text with *emphasis*, \`code\` and a [link](https://example.com/${middle})`
    )
  );
  assert.equal(model.edits.length, 6);
});

test('edits undo and redo through the model history, which Source shares', () => {
  const { model, sync, events } = start(BODY);
  sync.commit(codec.parse(codec.serialize(events[0].doc).replace('# Notes', '# Notes!')));
  sync.commit(codec.parse(codec.serialize(events[0].doc).replace('# Notes', '# Notes!!')));
  assert.equal(model.getValue(), BODY.replace('# Notes', '# Notes!!'));
  assert.equal(sync.canUndo(), true);
  // Quick successive edits are one undo step.
  sync.undo();
  assert.equal(model.getValue(), BODY);
  assert.equal(events.at(-1).kind, 'document');
  assert.equal(events.at(-1).doc.content[0].content[0].text, 'Notes');
  assert.equal(sync.canRedo(), true);
  sync.redo();
  assert.equal(model.getValue(), BODY.replace('# Notes', '# Notes!!'));
  assert.equal(events.at(-1).doc.content[0].content[0].text, 'Notes!!');
  // Source's own Ctrl+Z is the same history.
  model.undo();
  assert.equal(events.at(-1).doc.content[0].content[0].text, 'Notes');
});

const bigSection = (i) =>
  `## Section ${i}\n\nSome __bold__ text with *emphasis*, \`code\` and a [link](https://example.com/${i}).\n\n` +
  `* first item ${i}\n* second item\n  * nested\n\nTasks:\n\n- [ ] task ${i}\n- [x] done\n  - [ ] sub\n\n` +
  `| A | B |\n| --- | --- |\n| ${i} | two |\n\n\`\`\`js\nconst x = ${i};\n\`\`\`\n\n> Quote ${i}\n\n`;
function bigDocument(size, title) {
  let text = `# ${title}\n\n`;
  let count = 0;
  while (text.length < size) text += bigSection(count++);
  return { text, count };
}

test('opening a large document is fast, and reopening unchanged content is near instant', () => {
  for (const [size, bound] of [
    [100_000, 1500],
    [250_000, 3000],
  ]) {
    const { text } = bigDocument(size, `Opening ${size}`);
    let started = performance.now();
    const first = start(text);
    const opened = performance.now() - started;
    assert.equal(first.started, true);
    assert.deepEqual(first.events[0].doc, codec.parse(text), 'the document is the full parse');
    assert.ok(opened < bound, `opening ${size} characters took ${opened.toFixed(0)} ms`);
    started = performance.now();
    const again = start(text);
    const reopened = performance.now() - started;
    assert.equal(again.started, true);
    assert.ok(reopened < Math.min(250, bound / 4), `reopening took ${reopened.toFixed(0)} ms`);
  }
});

test('undo and redo at 250 KB reparse only the blocks they change', () => {
  const { text, count } = bigDocument(250_000, 'Undo');
  const { model, sync, events } = start(text);
  let doc = codec.schema.nodeFromJSON(events[0].doc);
  let target = -1;
  let seen = 0;
  doc.descendants((node, pos) => {
    if (node.isText && node.text.startsWith('Some ') && seen++ === Math.floor(count / 2)) target = pos + 5;
  });
  doc = new Transform(doc).insert(target, codec.schema.text('typed ')).doc;
  assert.equal(sync.commit(doc), true);
  const edited = model.getValue();
  const timed = (run) => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };
  const undo = timed(() => sync.undo());
  assert.equal(model.getValue(), text);
  assert.deepEqual(events.at(-1).doc, codec.parse(text));
  const redo = timed(() => sync.redo());
  assert.equal(model.getValue(), edited);
  assert.deepEqual(events.at(-1).doc, codec.parse(edited));
  assert.ok(undo < 500 && redo < 500, `undo ${undo.toFixed(0)} ms, redo ${redo.toFixed(0)} ms`);
  assert.equal(events.filter((event) => event.kind === 'unsupported').length, 0);
});

test('changes made elsewhere are applied block by block exactly as a full reload would read them', () => {
  const initial =
    '# Title\n\nFirst paragraph.\n\n* one\n* two\n\nMiddle text.\n\n- [ ] task\n\n```js\ncode\n```\n\nLast.\n';
  const { model, events } = start(initial);
  const edits = [
    (text) => text.replace('Middle text.', '* three'), // joins the list above it
    (text) => text.replace('First paragraph.\n\n', 'First paragraph.\n'), // merges into the heading's neighbour
    (text) => text.replace('```js\ncode\n```', '```js\ncode\n\nmore\n```'),
    (text) => text.replace('- [ ] task', '- [x] task\n  - [ ] nested'),
    (text) => text.replace('Last.\n', 'Last.\n\n> quoted\n'),
    (text) => text.replace('# Title\n\n', ''),
    (text) => `${text}\n\n\n\nTrailing.\n`,
    (text) => text.replace('code', '<div>raw</div>').replace('```js\n', '').replace('\n```', ''),
  ];
  for (const edit of edits) {
    const before = events.length;
    const text = edit(model.getValue());
    model.setValue(text);
    const last = events.at(-1);
    assert.equal(events.length, before + 1);
    // What loading the whole text from scratch decides.
    const support = richMarkdownSupport(text);
    const whole = support.ok ? checkRichMarkdownRoundTrip(codec, text) : support;
    assert.equal(last.kind, whole.ok ? 'document' : 'unsupported', JSON.stringify(text));
    if (whole.ok) assert.deepEqual(last.doc, whole.doc, JSON.stringify(text));
    else assert.equal(last.reason, whole.reason);
  }
  assert.equal(events.at(-1).kind, 'unsupported');
});

test('a disposed sync stops following the model', () => {
  const { model, sync, events } = start(BODY);
  sync.dispose();
  model.setValue('# Changed\n');
  assert.equal(events.length, 1);
});

for (const [label, front] of [
  ['YAML', '---\ntitle: Notes\n---'],
  ['TOML', '+++\ntitle = "Notes"\n+++'],
]) {
  for (const eol of ['\n', '\r\n']) {
    test(`${label} front matter without a trailing line ending survives consecutive edits (${JSON.stringify(eol)})`, () => {
      const source = front.replace(/\n/g, eol);
      const { model, sync } = start(source);
      assert.equal(sync.commit(codec.parse('Hello')), true);
      assert.ok(model.getValue().startsWith(`${source}${eol}Hello`));
      assert.equal(sync.commit(codec.parse('Hello world')), true);
      assert.ok(model.getValue().startsWith(`${source}${eol}Hello world`), JSON.stringify(model.getValue()));
    });
  }
}
