// Records from Node at b6f10295a what its own tool-result text and context-measurement modules answer for the
// inputs of cases.mjs, into node-oracle.golden.json:
//   node record.mjs <node-repo> [out.json]
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportNodeTree } from '../../../../../src/tui/components/status-line/footer-golden/node-tree.mjs';
import { CONTEXT_MEASUREMENT, TOOL_RESULT_TEXT } from './cases.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
const out = process.argv[3] || join(here, 'node-oracle.golden.json');
if (!repo) throw new Error('usage: node record.mjs <node-repo> [out.json]');
const { tree, commit } = exportNodeTree(repo);

const child = `
import { pathToFileURL } from 'node:url';
const url = (p) => pathToFileURL(process.env.NODE_TREE + '/' + p).href;
const text = await import(url('src/runtime/agent/orchestrator/session/transcript-restore/tool-result-text.mjs'));
const ctx = await import(url('src/runtime/shared/context-measurement.mjs'));
const { text: textCases, ctx: ctxCases } = JSON.parse(process.env.CASES);
const textOut = textCases.map(([fn, args]) => text[fn](...args) ?? null);
const ctxOut = ctxCases.map(([kind, input, opts]) => {
  if (kind === 'usage') return { usage: ctx.measuredContextUsage({ stats: input, ...opts }) };
  const stats = ctx.contextMeasurementStats(input);
  return { stats, usage: ctx.measuredContextUsage({ stats, ...opts }) };
});
process.stdout.write(JSON.stringify({ text: textOut, ctx: ctxOut }));
process.exit(0);
`;
const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
  cwd: tree,
  encoding: 'utf8',
  env: { ...process.env, NODE_TREE: tree, CASES: JSON.stringify({ text: TOOL_RESULT_TEXT, ctx: CONTEXT_MEASUREMENT }) },
});
if (run.status !== 0) throw new Error(run.stderr);
const result = JSON.parse(run.stdout);
writeFileSync(
  out,
  `${JSON.stringify(
    {
      recordedFrom: commit,
      text: TOOL_RESULT_TEXT.map(([fn, args], i) => ({ fn, args, result: result.text[i] })),
      ctx: CONTEXT_MEASUREMENT.map(([kind, input, opts], i) => ({ kind, input, opts, result: result.ctx[i] })),
    },
    null,
    1
  )}\n`
);
