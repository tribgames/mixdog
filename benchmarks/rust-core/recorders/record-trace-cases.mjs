#!/usr/bin/env node
// Records Node's `classifyToolFailure` for every call of the k1 UNTESTED trace cases (gaps-tools.md section 3,
// `mixdog-trace/src/tool.rs`): exit-classification.test.mjs 'shell trace classification uses only the leading status marker',
// 'glob missing bases are navigation misses, not runtime failures', and failure-taxonomy.test.mjs's three classification tests.
// Each test's own body runs at b6f10295a with `classifyToolFailure` wrapped to record every call it makes (text, tool name,
// Node's class), so the inputs are the test's own.
//
//   node benchmarks/rust-core/recorders/record-trace-cases.mjs --tree <exact export of b6f10295a with node_modules> --work <temp dir>
//
// Writes native/core/fixtures/trace-cases/{golden.json,MANIFEST.json}: per test, its calls in order.
import { mkdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-trace-cases.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const workRoot = resolve(args.get('work') ?? (() => { throw new Error('--work <temp dir> is required'); })());
mkdirSync(workRoot, { recursive: true });
process.env.MIXDOG_DATA_DIR = join(workRoot, 'data');

// The tests import it through scripts/shellhardening/_shared.mjs, which re-exports this module's function (and needs the
// native spawn test binary for its other exports).
const { classifyToolFailure } = await importFrom(tree, 'src/runtime/agent/orchestrator/agent-trace-format.mjs');

const EC = 'scripts/shellhardening/exit-classification.test.mjs';
const FT = 'scripts/shellhardening/failure-taxonomy.test.mjs';
const TESTS = [
  [EC, 'shell trace classification uses only the leading status marker'],
  [EC, 'glob missing bases are navigation misses, not runtime failures'],
  [FT, 'apply_patch taxonomy separates parse, context, verification, path and resource guards'],
  [FT, 'committed or uncertain patch writes outrank lock and permission detail'],
  [FT, 'shell-quoted patch output stays a command exit, never a patch failure'],
];

/** The body of `test('<title>', () => { … });` in the test file's source. */
function testBody(file, title) {
  const source = readFileSync(join(tree, file), 'utf8');
  const head = `test('${title}', () => {\n`;
  const start = source.indexOf(head);
  if (start < 0) throw new Error(`${file}: no synchronous test '${title}'`);
  const end = source.indexOf('\n});\n', start);
  return source.slice(start + head.length, end);
}

const cases = [];
for (const [file, title] of TESTS) {
  const calls = [];
  const recording = (text, tool) => {
    const result = classifyToolFailure(text, tool);
    calls.push({ text, tool, result });
    return result;
  };
  // The body sees only `classifyToolFailure` and `assert`; its assertions run, so a recording is of a passing test.
  new Function('classifyToolFailure', 'assert', testBody(file, title))(recording, assert);
  cases.push({ test: file, case: title, calls });
}

const finalDir = join(FIXTURES_ROOT, 'trace-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's classifyToolFailure at ${NODE_COMMIT}, per call of ${RECORDER}`, cases });
writeSetManifest(stage, {
  set: 'trace-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}> --work <temp dir>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: "every recorded call's class string through mixdog_trace::classify_tool_failure (the result text as a JSON string, the tool name), whole",
    excluded: {
      [EC]: {
        'glob empty-result diagnostics reuse settled stat records': 'a glob tool case: recorded in fs-search-cases (glob-empty-result), where it is named as a difference',
      },
    },
  },
});
commitStage(stage, finalDir);
console.log(`trace-cases: ${cases.length} test(s), ${cases.reduce((n, c) => n + c.calls.length, 0)} call(s)`);
