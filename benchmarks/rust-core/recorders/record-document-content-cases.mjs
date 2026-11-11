#!/usr/bin/env node
// Records Node's document extraction for the k1 UNTESTED document-content.test.mjs (gaps-tools.md row 80, mixdog-tools
// `web/extract.rs`). Every input of the test goes through Node's real `extractDocument`; the whole page (or the error's
// code and message) is recorded.
//
//   node benchmarks/rust-core/recorders/record-document-content-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/document-content-cases/{golden.json,MANIFEST.json}.
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-document-content-cases.mjs';
const TEST = 'src/runtime/web-search/lib/document-content.test.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const { extractDocument } = await importFrom(tree, 'src/runtime/web-search/lib/document-content.mjs');

const inputs = {
  'source documents preserve embedded HTML, whitespace, code and JSON verbatim': [
    ['https://example.com/guide', '# Guide\n\n<div>Example, not an HTML page</div>\n\n\n    indented code\n', 'text/plain'],
    ['https://example.com/guide', '# Guide\n\n```html\n<main>hello</main>\n```\n', 'text/markdown'],
    ['https://example.com/guide', '{\n  "name": "<main>literal</main>"\n}\n', 'application/ld+json'],
    ['https://example.com/guide', '<feed><item>example</item></feed>', 'application/xml'],
  ],
  'semantic HTML retains headings, links, fenced code and tables without navigation': [
    [
      'https://example.com/docs/start',
      `
    <title>Setup</title><nav>Navigation noise</nav>
    <main><h1>Setup guide</h1><p>Use <a href="../api">the API</a>.</p>
    <pre><code class="language-js">const x = 1;


  console.log(x);</code></pre>
    <table><tr><th>Option</th><th>Value</th></tr><tr><td>port</td><td>8080</td></tr></table>
    <ul><li>First</li><li>Second</li></ul><div hidden>Hidden noise</div>
    <script>throw new Error('must not execute')</script></main><aside>Advertisement</aside>`,
      'text/html',
    ],
  ],
  'empty JS shells cannot become successes through metadata alone': [
    ['https://example.com', '<meta property="og:image" content="/cover.png"><div id="root"></div><script>render()</script>', 'text/html'],
  ],
  'article fallback returns text even without a semantic container': [
    ['https://example.com', '<title>Small page</title><div><p>A small useful page.</p><p>More details here.</p></div>', 'text/html'],
  ],
  'short HTML documentation is not rejected for login or challenge vocabulary': ['Just a moment...', 'Access denied', 'Sign in - Example'].map((title) => [
    'https://example.com/docs',
    `<title>${title}</title>
      <main><h1>${title}</h1><p>When checking your browser, you may see “Please enable JavaScript”.</p>
      <p>This guide explains how to verify you are human and sign in.</p></main>`,
    'text/html',
  ]),
};

const cases = [];
for (const [name, calls] of Object.entries(inputs)) {
  const recorded = [];
  for (const [url, body, type] of calls) {
    try {
      recorded.push({ url, body, type, page: { ...(await extractDocument(url, body, type)) } });
    } catch (error) {
      recorded.push({ url, body, type, error: { code: error.code, message: error.message } });
    }
  }
  cases.push({ case: name, recorded });
}

const finalDir = join(FIXTURES_ROOT, 'document-content-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's extractDocument at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'document-content-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: { ...recorderProvenance(import.meta.url), compared: "each call's whole page, or its error's code and message", excluded: {} },
});
commitStage(stage, finalDir);
console.log(`document-content-cases: ${cases.length} case(s)`);
process.exit(0);
