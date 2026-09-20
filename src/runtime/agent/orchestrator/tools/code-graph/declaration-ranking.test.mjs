// Declaration ranking (`.d.ts`/`.d.mts`/`.d.cts` type faces never outrank an
// implementation) and the scoped find_symbol answer when the only hits inside
// the requested files are imports.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const graphBinary = resolve(
  'native/mixdog-graph/target/release',
  process.platform === 'win32' ? 'mixdog-graph.exe' : 'mixdog-graph'
);
// The real-binary cases need a build that emits symbol record v2; the packaged
// default binary may be older, so point at the release build when it exists.
if (existsSync(graphBinary)) process.env.MIXDOG_GRAPH_BIN = graphBinary;
const REAL_BINARY = existsSync(process.env.MIXDOG_GRAPH_BIN || graphBinary);

const { codeGraph, executeCodeGraphTool } = await import('./dispatch.mjs');
const { _attachGraphRuntimeCaches } = await import('./graph-model.mjs');

const CWD = process.cwd();

function sym(name, kind, startLine, endLine, startCol = 1, extra = {}) {
  return {
    name,
    kind,
    startLine,
    endLine,
    startCol,
    endCol: startCol + String(name).length,
    ...(extra.exported ? { exported: true } : {}),
    ...(extra.sig ? { sig: extra.sig } : {}),
  };
}

const tokens = (text) => [...new Set(String(text || '').match(/[A-Za-z_$][\w$]*/g) || [])];

function makeGraph(files) {
  const nodes = new Map();
  const graph = _attachGraphRuntimeCaches({ cwd: CWD, nodes, reverse: new Map() });
  for (const file of files) {
    const node = {
      abs: resolve(CWD, file.rel),
      rel: file.rel,
      lang: file.lang,
      fingerprint: 'fp',
      parseError: '',
      rawImports: file.rawImports || [],
      resolvedImportsRel: [],
      resolvedImports: [],
      importedBy: [],
      packageName: '',
      namespaceName: '',
      goPackageName: '',
      topLevelTypes: [],
      tokenSymbols: tokens(file.text),
      symbols: file.symbols || [],
      calls: null,
    };
    nodes.set(node.rel, node);
    graph._sourceTextCache.set(node.rel, { fingerprint: 'fp', text: file.text });
  }
  return graph;
}

const dispatch = async (graph, args) => String(await codeGraph(args, CWD, null, { graph }));

test('one declaration omits candidate and scope banners without losing its body', async () => {
  const text = 'export function uniqueTask() {\n  return 42;\n}\n';
  const graph = makeGraph([{
    rel: 'src/unique.mjs',
    lang: 'javascript',
    text,
    symbols: [sym('uniqueTask', 'function', 1, 3, 17, { exported: true })],
  }]);
  for (const mode of ['find_symbol', 'symbol_search']) {
    const out = await codeGraph({ mode, symbol: 'uniqueTask' }, CWD, null, { graph, _defaultCwd: tmpdir() });
    assert.match(out, /src\/unique\.mjs:1-3:/);
    assert.doesNotMatch(out, /# candidates|# scope:|graph=\d+-nodes/);
    if (mode === 'find_symbol') assert.match(out, /1: export function uniqueTask\(\) \{\n2:   return 42;\n3: \}/);
  }
});

// ── 1. type declaration vs implementation ──────────────────────────────────
const IMPL_TEXT = 'export function computerErrorCode(error) {\n  return String(error);\n}\n';
const DTS_TEXT = 'export function computerErrorCode(error: unknown): string;\n';

function typeFaceGraph() {
  return makeGraph([
    {
      rel: 'src/bridge/error-code.mjs',
      lang: 'javascript',
      text: IMPL_TEXT,
      symbols: [
        sym('computerErrorCode', 'function', 1, 3, 17, { exported: true, sig: 'function computerErrorCode(error)' }),
      ],
    },
    {
      rel: 'src/bridge/error-code.d.mts',
      lang: 'typescript',
      text: DTS_TEXT,
      symbols: [
        sym('computerErrorCode', 'function', 1, 1, 17, {
          exported: true,
          sig: 'function computerErrorCode(error: unknown): string',
        }),
      ],
    },
  ]);
}

test('an implementation outranks its .d.mts type face, which is reported separately', async () => {
  const out = await dispatch(typeFaceGraph(), { mode: 'find_symbol', symbol: 'computerErrorCode', body: false });
  assert.match(out, /^src\/bridge\/error-code\.mjs:1-3:\d+ \(javascript, export function, matches=\d+\)$/m);
  // One implementation → nothing to "verify", and no declarations= counter.
  assert.doesNotMatch(out, /declarations found/);
  assert.doesNotMatch(out, /declarations=/);
  assert.doesNotMatch(out, /other declarations:/);
  assert.match(out, /^type declaration: src\/bridge\/error-code\.d\.mts:1-1:\d+ \[typescript\]$/m);
  // The candidate list still shows the implementation first.
  assert.match(out, /^1\. src\/bridge\/error-code\.mjs:/m);
});

test('references anchors its declaration block on the implementation too', async () => {
  const out = await dispatch(typeFaceGraph(), { mode: 'references', symbol: 'computerErrorCode' });
  assert.match(out, /# best declaration candidate\nsrc\/bridge\/error-code\.mjs:/);
  assert.doesNotMatch(out, /declarations found/);
  assert.match(out, /type declaration: src\/bridge\/error-code\.d\.mts:/);
});

test('two real implementations still raise the ambiguity warning', async () => {
  const graph = makeGraph([
    {
      rel: 'src/a/run.mjs',
      lang: 'javascript',
      text: 'export function runTask(x) {\n  return x;\n}\n',
      symbols: [sym('runTask', 'function', 1, 3, 17, { exported: true, sig: 'function runTask(x)' })],
    },
    {
      rel: 'src/b/run.mjs',
      lang: 'javascript',
      text: 'export function runTask(y) {\n  return y;\n}\n',
      symbols: [sym('runTask', 'function', 1, 3, 17, { exported: true, sig: 'function runTask(y)' })],
    },
    {
      rel: 'src/b/run.d.ts',
      lang: 'typescript',
      text: 'export function runTask(y: number): number;\n',
      symbols: [sym('runTask', 'function', 1, 1, 17, { exported: true })],
    },
  ]);
  const out = await dispatch(graph, { mode: 'find_symbol', symbol: 'runTask', body: false });
  // The .d.ts is excluded from the count — two implementations, not three.
  assert.match(out, /^⚠ 2 declarations found — verify which one you intend$/m);
  assert.match(out, /^other declarations: src\/[ab]\/run\.mjs:/m);
  assert.match(out, /^type declaration: src\/b\/run\.d\.ts:/m);
  assert.match(out, /^# candidates$/m);
  assert.doesNotMatch(out, /# scope:/);
  const external = await codeGraph({ mode: 'find_symbol', symbol: 'runTask' }, CWD, null, {
    graph,
    _defaultCwd: tmpdir(),
  });
  assert.ok(external.endsWith(`# scope: cwd=${CWD}`));
  assert.doesNotMatch(external, /graph=\d+-nodes/);
});

test('a same-named .d.ts in ANOTHER package is a rival declaration, not a type face', async () => {
  // The type face belongs to the module it sits next to. `vendor/x.d.ts` and
  // `src/other/foo.mjs` are two unrelated declarations: filing the first under
  // the second would hide it AND claim a module relationship that is false.
  const graph = makeGraph([
    {
      rel: 'vendor/x.d.ts',
      lang: 'typescript',
      text: 'export function foo(a: string): void;\n',
      symbols: [sym('foo', 'function', 1, 1, 17, { exported: true })],
    },
    {
      rel: 'src/other/foo.mjs',
      lang: 'javascript',
      text: 'export function foo() {\n  return 1;\n}\n',
      symbols: [sym('foo', 'function', 1, 3, 17, { exported: true, sig: 'function foo()' })],
    },
  ]);
  const out = await dispatch(graph, { mode: 'find_symbol', symbol: 'foo', body: false });
  assert.match(out, /^⚠ 2 declarations found — verify which one you intend$/m);
  assert.match(out, /^other declarations: vendor\/x\.d\.ts:/m);
  assert.doesNotMatch(out, /type declaration:/);
});

// ── 2. scoped find_symbol whose hits are imports ───────────────────────────
test('a scoped miss names the declaring file instead of calling the symbol a builtin', async () => {
  const graph = makeGraph([
    {
      rel: 'src/mem/memory.mjs',
      lang: 'javascript',
      text: "import { cleanMemoryText } from './memory-extraction.mjs';\n\nexport const use = (t) => cleanMemoryText(t);\n",
      symbols: [sym('use', 'variable', 3, 3, 14, { exported: true })],
      rawImports: ['./memory-extraction.mjs'],
    },
    {
      rel: 'src/mem/memory-extraction.mjs',
      lang: 'javascript',
      text: 'export function cleanMemoryText(text) {\n  return text.trim();\n}\n',
      symbols: [
        sym('cleanMemoryText', 'function', 1, 3, 17, { exported: true, sig: 'function cleanMemoryText(text)' }),
      ],
    },
  ]);
  const out = await dispatch(graph, {
    mode: 'find_symbol',
    symbol: 'cleanMemoryText',
    file: 'src/mem/memory.mjs',
    body: false,
  });
  assert.match(
    out,
    /^declared outside the requested files: src\/mem\/memory-extraction\.mjs:1 \(javascript, export function\)$/m
  );
  assert.match(out, /^\(the 1 hit\(s\) in the requested scope are imports\/references\)$/m);
  assert.doesNotMatch(out, /global\/builtin/);
});

test('with no declaration in the graph the import specifier itself is resolved', async () => {
  const graph = makeGraph([
    {
      rel: 'src/mem/memory.mjs',
      lang: 'javascript',
      text: "import { cleanMemoryText } from './memory-extraction.mjs';\n\nexport const use = (t) => cleanMemoryText(t);\n",
      symbols: [sym('use', 'variable', 3, 3, 14, { exported: true })],
      rawImports: ['./memory-extraction.mjs'],
    },
  ]);
  const out = await dispatch(graph, {
    mode: 'find_symbol',
    symbol: 'cleanMemoryText',
    file: 'src/mem/memory.mjs',
    body: false,
  });
  assert.match(
    out,
    /^declared outside the requested files: src\/mem\/memory-extraction\.mjs \(resolved from the import specifier\)$/m
  );
  assert.doesNotMatch(out, /global\/builtin/);
});

test('the scope points at the module it IMPORTS, not a same-named declaration elsewhere', async () => {
  // The importer sits next to the type declaration it uses; a same-named
  // implementation in another package is not the file it asked about.
  const graph = makeGraph([
    {
      rel: 'vendor/x.d.ts',
      lang: 'typescript',
      text: 'export function foo(a: string): void;\n',
      symbols: [sym('foo', 'function', 1, 1, 17, { exported: true })],
    },
    {
      rel: 'src/other/foo.mjs',
      lang: 'javascript',
      text: 'export function foo() {\n  return 1;\n}\n',
      symbols: [sym('foo', 'function', 1, 3, 17, { exported: true, sig: 'function foo()' })],
    },
    {
      rel: 'vendor/index.mjs',
      lang: 'javascript',
      text: "import { foo } from './x.d.ts';\n\nexport const call = () => foo('a');\n",
      rawImports: ['./x.d.ts'],
      symbols: [sym('call', 'variable', 3, 3, 14, { exported: true })],
    },
  ]);
  const out = await dispatch(graph, { mode: 'find_symbol', symbol: 'foo', file: 'vendor/index.mjs', body: false });
  assert.match(out, /^declared outside the requested files: vendor\/x\.d\.ts:1 \(typescript, export function\)$/m);
  assert.doesNotMatch(out, /src\/other\/foo\.mjs/);
});

test('an extensionless specifier resolves to the module file it names', async () => {
  const graph = makeGraph([
    {
      rel: 'src/app/main.mjs',
      lang: 'javascript',
      text: "import { helper } from './x';\n\nexport const use = () => helper();\n",
      rawImports: ['./x'],
      symbols: [sym('use', 'variable', 3, 3, 14, { exported: true })],
    },
    {
      rel: 'src/app/x.mjs',
      lang: 'javascript',
      text: 'export function helper() {\n  return 1;\n}\n',
      symbols: [sym('helper', 'function', 1, 3, 17, { exported: true, sig: 'function helper()' })],
    },
  ]);
  const out = await dispatch(graph, { mode: 'find_symbol', symbol: 'helper', file: 'src/app/main.mjs', body: false });
  assert.match(out, /^declared outside the requested files: src\/app\/x\.mjs:1 \(javascript, export function\)$/m);
});

test('a bare or aliased specifier is reported as an unresolved import, never as a builtin', async () => {
  const graph = makeGraph([
    {
      rel: 'src/app/main.mjs',
      lang: 'javascript',
      text: "import { aliasFn } from '@app/tools';\n\nexport const use = () => aliasFn();\n",
      rawImports: ['@app/tools'],
      symbols: [sym('use', 'variable', 3, 3, 14, { exported: true })],
    },
  ]);
  const out = await dispatch(graph, { mode: 'find_symbol', symbol: 'aliasFn', file: 'src/app/main.mjs', body: false });
  assert.match(
    out,
    /^declared outside the requested files: imported from '@app\/tools' \(specifier does not resolve to a file of this project\)$/m
  );
  assert.doesNotMatch(out, /global\/builtin/);
});

test('a symbol no file declares or imports keeps the global/builtin wording', async () => {
  const graph = makeGraph([
    {
      rel: 'src/mem/memory.mjs',
      lang: 'javascript',
      text: 'export const use = (t) => structuredClone(t);\n',
      symbols: [sym('use', 'variable', 1, 1, 14, { exported: true })],
    },
  ]);
  const out = await dispatch(graph, {
    mode: 'find_symbol',
    symbol: 'structuredClone',
    file: 'src/mem/memory.mjs',
    body: false,
  });
  assert.match(out, /global\/builtin identifier/);
  assert.doesNotMatch(out, /declared outside the requested files/);
});

// ── real-binary end-to-end ─────────────────────────────────────────────────
test('real binary: the implementation wins over its .d.mts and the scoped import is resolved', {
  skip: REAL_BINARY ? false : 'release mixdog-graph binary not built',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-decl-rank-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"decl-rank-fixture"}\n');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'error-code.mjs'), IMPL_TEXT);
    writeFileSync(join(root, 'src', 'error-code.d.mts'), DTS_TEXT);
    writeFileSync(
      join(root, 'src', 'memory.mjs'),
      "import { cleanMemoryText } from './memory-extraction.mjs';\n\nexport const use = (t) => cleanMemoryText(t);\n"
    );
    writeFileSync(
      join(root, 'src', 'memory-extraction.mjs'),
      'export function cleanMemoryText(text) {\n  return text.trim();\n}\n'
    );

    const ranked = String(
      await executeCodeGraphTool(
        'code_graph',
        {
          mode: 'find_symbol',
          symbol: 'computerErrorCode',
          body: false,
          cwd: root,
        },
        root
      )
    );
    assert.match(ranked, /# best declaration candidate\nsrc\/error-code\.mjs:/);
    assert.doesNotMatch(ranked, /declarations found/);
    assert.match(ranked, /^type declaration: src\/error-code\.d\.mts:/m);

    const scoped = String(
      await executeCodeGraphTool(
        'code_graph',
        {
          mode: 'find_symbol',
          symbol: 'cleanMemoryText',
          files: ['src/memory.mjs'],
          body: false,
          cwd: root,
        },
        root
      )
    );
    assert.match(
      scoped,
      /^declared outside the requested files: src\/memory-extraction\.mjs:1 \(javascript, export function\)$/m
    );
    assert.doesNotMatch(scoped, /global\/builtin/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real binary: a dependency path is named but never indexed, and paths stay forward-slashed', {
  skip: REAL_BINARY ? false : 'release mixdog-graph binary not built',
}, async () => {
  const base = mkdtempSync(join(tmpdir(), 'mixdog-decl-vendor-'));
  const root = join(base, 'app');
  const outside = join(base, 'outside-pkg');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"decl-vendor-fixture"}\n');
    writeFileSync(
      join(root, 'src', 'main.mjs'),
      "import { vendorFn } from '../node_modules/pkg/index.js';\n" +
        "import { outsideFn } from '../../outside-pkg/out.mjs';\n\n" +
        'export const use = () => [vendorFn(), outsideFn()];\n'
    );
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'export function vendorFn() {\n  return 2;\n}\n');
    writeFileSync(join(outside, 'out.mjs'), 'export function outsideFn() {\n  return 5;\n}\n');

    // node_modules: the path is the answer. A record (line + kind) would mean
    // a file of the dependency tree was parsed to produce it.
    const vendor = String(
      await executeCodeGraphTool(
        'code_graph',
        {
          mode: 'find_symbol',
          symbol: 'vendorFn',
          files: ['src/main.mjs'],
          body: false,
          cwd: root,
        },
        root
      )
    );
    assert.match(
      vendor,
      /^declared outside the requested files: node_modules\/pkg\/index\.js \(resolved from the import specifier\)$/m
    );
    assert.doesNotMatch(vendor, /node_modules\/pkg\/index\.js:\d/);

    // A target outside cwd is an absolute path — with no backslash, on any OS.
    const away = String(
      await executeCodeGraphTool(
        'code_graph',
        {
          mode: 'find_symbol',
          symbol: 'outsideFn',
          files: ['src/main.mjs'],
          body: false,
          cwd: root,
        },
        root
      )
    );
    const awayLine = away.split('\n').find((line) => line.startsWith('declared outside the requested files:')) || '';
    assert.match(awayLine, /outside-pkg\/out\.mjs:1 \(javascript, export function\)$/);
    assert.doesNotMatch(awayLine, /\\/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
