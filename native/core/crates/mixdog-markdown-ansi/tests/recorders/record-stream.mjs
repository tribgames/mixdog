#!/usr/bin/env node
// Records (or checks) the streaming golden of the mixdog-markdown-ansi crate from the Node product's own code.
//
//   node record-stream.mjs --tree <mixdog checkout> --write <goldens/stream.json>
//   node record-stream.mjs --tree <mixdog checkout> --check <goldens/stream.json>
//
// What is recorded, from the tree's modules:
//   - streaming: thirty documents (DOCS below: fences opened and closed mid-stream, tables arriving row by row, nested
//     emphasis, links split mid-URL, escapes, CJK, a document with carriage returns, one with characters outside the BMP)
//     are fed to the streaming code one UTF-16 unit at a time, every prefix in turn, under a stream key per document,
//     as a stream arrives. A cut inside a surrogate pair is skipped: a Rust string cannot hold half of one. Per prefix:
//       parts       resolveStreamingMarkdownParts(prefix, key)
//       partsNoKey  resolveStreamingMarkdownParts(prefix, null)
//       heal        healStreamingMarkdownTail(prefix)
//       window      windowPlainStreamingText(prefix, 20, 3, key) and (prefix, 7, 2, null)
//       fence       findOpenFenceStart(prefix, ownKey)  (the index in UTF-16 units)
//       tail        the tokens of renderTokenAnsiSegments(prefix, { width: 80, trimPartialFences: true }), the open-fence
//                   path and the partial closing fence trim of render-ansi.mjs (not for a text without markdown syntax,
//                   which that module answers with one paragraph before it gets there)
//     Each is recorded as the first 8 hex digits of the SHA-256 of its canonical JSON (sorted keys), the prefixes of a
//     document joined, so a failure names the document and the prefix.
//   - repl: src/ui/markdown.mjs `renderMarkdown(text, { width })` over the documents and the files of ../corpus
//     (strings.json, edge.json), at the widths 40, 80 and 120, with colour on (FORCE_COLOR) and off (NO_COLOR: that module
//     decides at import, so the colour-off rows are recorded by a child process of this script). A rendering is
//     recorded as the first 16 hex digits of the SHA-256 of its string; the documents at width 40 without colour also
//     keep the string, so a difference reads.
//   - finalize: src/ui/stream-finalize.mjs `buildStreamFinalPatch(raw, rendered, { columns })` over CASES.
//
// The display-width policy is fixed off (MIXDOG_TUI_AMBIGUOUS_WIDE=0) before the tree is imported.

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.MIXDOG_TUI_AMBIGUOUS_WIDE = '0';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, '..', 'corpus');
const REPL_WIDTHS = [40, 80, 120];
const REPL_CHILD = '--repl-child';

const DOCS = [
  ['plain-prose', 'The quick brown fox jumps over the lazy dog.\nA second line of plain prose follows here.\n'],
  ['headings', '# Title\n\nSome intro text with **bold** and *italic* words.\n\n## Section\n\nMore text.\n\n### Third\n'],
  ['fence-backtick', 'Before\n\n```js\nconst a = 1;\nconsole.log(a);\n```\n\nAfter the block.\n'],
  ['fence-tilde-nested', "~~~python\nprint('hi')\n~~~\n\n````md\n```js\nx\n```\n````\n\ndone"],
  ['table-rows', '| Name | Qty | Price |\n| --- | ---: | :---: |\n| Apple | 3 | 1.20 |\n| Pear | 10 | 0.75 |\n\nTotal row above.\n'],
  ['table-no-pipes', 'Name | Qty\n--- | ---\na | 1\nb | 2\n'],
  ['nested-emphasis', 'This is ***bold italic*** and **bold with _nested italic_ inside** and _it **bold**_ end.\n'],
  ['links-split', 'See [the docs](https://example.com/a/b?c=d) and [other](http://x.y/z_(1)) plus <https://auto.link/x> done.\n'],
  ['images', '![alt text](https://img.example/a.png "title") and ![](x.png) and ![nested [br]](y.png)\n'],
  ['cjk', '# 제목\n\n한국어 문장입니다. **굵게** 그리고 `코드` 와 [링크](https://예시.kr)\n\n日本語のテキストです。\n- 項目一\n- 項目二\n'],
  ['inline-code', 'Use `code` and ``double `tick` code`` and an `unclosed span\nnext line\n'],
  ['lists', '- one\n- two\n  - nested a\n  - nested b\n- three\n\n1. first\n2. second\n3) third\n'],
  ['task-list', '- [ ] todo item\n- [x] done item\n- [X] also done\n'],
  ['quote-code', '> quoted **text**\n> more\n>\n> ```js\n> let a;\n> ```\n\nafter'],
  ['setext', 'Heading One\n===\n\nHeading Two\n---\n\nparagraph\n'],
  ['rules-html', 'above\n\n---\n\n<div>html block</div>\n\n<!-- comment -->\n\n***\n\nbelow\n'],
  ['footnote-defs', 'Text with note[^1] and ref [site][s].\n\n[^1]: The footnote.\n\n[s]: https://example.com\n'],
  ['escapes', 'Escaped \\*not bold\\* and \\`not code\\` and a\\_b\\_c and 1\\. not list and \\[x\\](y)\n'],
  ['strike', '~~struck~~ text and 1~2 range and ~~~ not and ~~half\n'],
  ['block-markers', 'intro\n-\nitem\n\n1\n1.\n1. one\n\n>\n> quote\n\n##\n## h\n\n+\n+ plus\n'],
  ['code-in-list', '1. Step one:\n\n   ```sh\n   npm install\n   ```\n\n2. Step two\n'],
  ['crlf', '# Win\r\n\r\nLine one\r\nLine two with **bold**\r\n\r\n```c\r\nint x;\r\n```\r\n\r\n| a | b |\r\n| - | - |\r\n| 1 | 2 |\r\n'],
  ['non-bmp', 'Emoji 😀 and **bold 🚀 text** with `code 🧪` and [link 🔗](http://e.x)\n\n日本 🇯🇵\n\n```\n😀\n```\n'],
  ['unclosed-everything', '**bold *both _three ~~four `five [six](http://x'],
  ['fence-info', '```  rust  ignore\nfn main() {}\n```   \n\n```a`b\ntext\n\n~~~ tilde `tick`\nz\n~~~~\n'],
  ['partial-closing', '```text\nline1\nline2\n```\nafter\n\n~~~\nx\n~~\n~\n\n````\ny\n```\n````\n'],
  ['indented-code', 'para\n\n    indented code\n    more\n\n\ttabbed\n\nend\n'],
  ['autolinks', 'Visit https://example.com/path_with_underscores and www.foo.bar or mail a@b.co now.\n'],
  ['table-emphasis', 'Intro **bold**\n\n| `a` | *b* |\n|:---|---:|\n| [l](u) | **x** |\n\n- item after\n'],
  [
    'plain-wrap',
    'alpha beta gamma delta epsilon zeta eta theta\niota kappa lambda mu nu xi omicron pi rho sigma tau\nupsilon phi chi psi omega and more words to wrap\n日本語の長い文章がここに続きます。ワイドな文字\nlast line',
  ],
].map(([id, text]) => ({ id, text }));

// buildStreamFinalPatch: [raw, rendered, columns (null: not given)].
const CASES = [
  ['a\nb', 'a\nb', 80],
  ['a\n**b**', 'a\nB', 80],
  ['one', 'two', null],
  ['one\ntwo\nthree', 'ONE\ntwo\nTHREE', 80],
  ['x\ny', 'x', 80],
  ['a\r\nb', 'a\nb', 80],
  ['0123456789', 'x', 10],
  ['0123456789', 'x', 11],
  ['a', '0123456789', 10],
  ['a\n\nb', 'A\n\nB', 80],
  ['plain text', '\u001b[1mplain\u001b[0m text', 80],
  ['plain text', '\u001b[1mplain\u001b[0m text', 0],
  ['日本語\nx', '日本語\ny', 80],
  ['', '', 80],
  ['a', 'b', 1],
  ['a\nb\nc\nd', 'a\nB\nc\nD', 5],
];

function parseArgs(argv) {
  const out = { tree: '', check: '', write: '', child: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tree') out.tree = argv[++i] ?? '';
    else if (a === '--check') out.check = argv[++i] ?? '';
    else if (a === '--write') out.write = argv[++i] ?? '';
    else if (a === REPL_CHILD) out.child = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.tree) throw new Error('--tree <checkout> is required');
  if (!out.child) {
    if (!out.check && !out.write) throw new Error('--check <golden> or --write <golden> is required');
    if (out.check && out.write) throw new Error('--check and --write are exclusive');
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(text, hex) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, hex);
}

function firstDifference(a, b, where) {
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return a === b ? '' : `${where}`;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const d = firstDifference(a[key], b[key], `${where}.${key}`);
    if (d) return d;
  }
  return '';
}

/** The prefixes of a text, one per UTF-16 unit, without the cuts inside a surrogate pair. */
function prefixes(text) {
  const out = [];
  for (let k = 1; k <= text.length; k += 1) {
    const code = text.charCodeAt(k - 1);
    if (k < text.length && code >= 0xd800 && code <= 0xdbff) continue;
    out.push(text.slice(0, k));
  }
  return out;
}

const toUrl = (tree, rel) => pathToFileURL(path.join(tree, rel)).href;

/** The renderMarkdown rows of every input, at every width: digests, and the strings of the documents at width 40. */
async function replRows(tree, withFull) {
  const { renderMarkdown } = await import(toUrl(tree, 'src/ui/markdown.mjs'));
  const strings = readJson(path.join(corpusDir, 'strings.json'));
  const edge = readJson(path.join(corpusDir, 'edge.json'));
  const groups = { docs: DOCS, strings, edge };
  const out = { digests: {}, full: {} };
  for (const [name, entries] of Object.entries(groups)) {
    out.digests[name] = entries.map((entry) =>
      REPL_WIDTHS.map((width) => digest(renderMarkdown(entry.text, { width }), 16)).join('')
    );
    if (withFull && name === 'docs') out.full = entries.map((entry) => renderMarkdown(entry.text, { width: 40 }));
  }
  return out;
}

async function record(tree) {
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  const streaming = await import(toUrl(tree, 'src/tui/markdown/streaming-markdown.mjs'));
  const fence = await import(toUrl(tree, 'src/tui/markdown/stream-fence.mjs'));
  const heal = await import(toUrl(tree, 'src/ui/streaming-markdown-heal.mjs'));
  const render = await import(toUrl(tree, 'src/tui/markdown/render-ansi.mjs'));
  const finalize = await import(toUrl(tree, 'src/ui/stream-finalize.mjs'));

  const entries = [];
  for (const doc of DOCS) {
    streaming.resetAllStreamingMarkdownStablePrefixes();
    const key = `doc:${doc.id}`;
    const fenceKey = `fence:${doc.id}`;
    const columns = { parts: [], partsNoKey: [], heal: [], window: [], fence: [], tail: [] };
    const cuts = prefixes(doc.text);
    for (const prefix of cuts) {
      const parts = (p) => ({
        plain: p.plain === true,
        openFence: p.openFence === true,
        stablePrefix: p.stablePrefix,
        stableChunks: [...(p.stableChunks ?? [])],
        unstableSuffix: p.unstableSuffix,
        unstableForRender: p.unstableForRender,
      });
      columns.parts.push(digest(canonical(parts(streaming.resolveStreamingMarkdownParts(prefix, key))), 8));
      columns.partsNoKey.push(digest(canonical(parts(streaming.resolveStreamingMarkdownParts(prefix, null))), 8));
      columns.heal.push(digest(canonical(heal.healStreamingMarkdownTail(prefix)), 8));
      columns.window.push(
        digest(
          canonical([
            streaming.windowPlainStreamingText(prefix, 20, 3, key),
            streaming.windowPlainStreamingText(prefix, 7, 2, null),
          ]),
          8
        )
      );
      columns.fence.push(digest(canonical(fence.findOpenFenceStart(prefix, fenceKey)), 8));
      if (render.hasMarkdownSyntax(prefix)) {
        const segments = render.renderTokenAnsiSegments(prefix, { width: 80, trimPartialFences: true });
        columns.tail.push(digest(canonical(segments.map((segment) => segment.token)), 8));
      } else {
        columns.tail.push('--------');
      }
    }
    entries.push({
      id: doc.id,
      text: doc.text,
      count: cuts.length,
      parts: columns.parts.join(''),
      partsNoKey: columns.partsNoKey.join(''),
      heal: columns.heal.join(''),
      window: columns.window.join(''),
      fence: columns.fence.join(''),
      tail: columns.tail.join(''),
    });
  }

  const on = await replRows(tree, false);
  const childOutput = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--tree', tree, REPL_CHILD], {
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '' },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const off = JSON.parse(childOutput);

  const cases = CASES.map(([raw, rendered, columnsValue]) => {
    const patch =
      columnsValue === null
        ? finalize.buildStreamFinalPatch(raw, rendered)
        : finalize.buildStreamFinalPatch(raw, rendered, { columns: columnsValue });
    return { raw, rendered, columns: columnsValue, patch };
  });

  return {
    widths: REPL_WIDTHS,
    entries,
    repl: { on: on.digests, off: off.digests, offFull: off.full },
    finalize: cases,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tree = path.resolve(args.tree);
  if (args.child) {
    process.stdout.write(JSON.stringify(await replRows(tree, true)));
    return;
  }
  const recorded = await record(tree);
  if (args.write) {
    fs.writeFileSync(args.write, `${JSON.stringify(recorded)}\n`);
    console.log(`wrote ${args.write}`);
    return;
  }
  const golden = readJson(args.check);
  const diff = firstDifference(golden, JSON.parse(JSON.stringify(recorded)), 'golden');
  if (diff) {
    console.error(`stream golden differs from the tree's code at ${diff}`);
    process.exit(1);
  }
  console.log('stream golden matches');
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
