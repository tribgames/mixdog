// Records the goldens of the explorer's result (explore/explorer.mjs `runExplorer`).
//
//   node native/core/fixtures/agent/record-explorer.mjs [--tree <node checkout with node_modules>]
//
// Each case is a scripted provider: a send streams its `text`, then either
// finishes (`stop`), or `hang`s until the deadline aborts it with the
// salvage-flagged reason `explore/tool.mjs` uses. The text `runExplorer`
// resolves, or the error it rejects with, is written beside the script to
// `explorer/cases.json`, which `tests/explorer.rs` replays.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commitStage, parseArgs, refreshSetManifest, resolveTree, stageSet } from '../../../../benchmarks/rust-core/recorders/lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolveTree(parseArgs());
const stage = stageSet(here, ['explorer']);
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-explorer-'));
const { runExplorer } = await import(pathToFileURL(join(nodeRoot, 'src/runtime/explore/explorer.mjs')).href);

const call = (id, name, args = {}) => ({ id, name, arguments: args });
const cases = [
  { name: 'finished_answer_is_trimmed', script: [{ text: '  done \n', stop: 'end_turn' }] },
  { name: 'deadline_returns_streamed_text', script: [{ text: 'src/a.rs:1 foo', hang: true }] },
  { name: 'deadline_with_nothing_written_throws', script: [{ hang: true }] },
  { name: 'deadline_with_only_blank_text_throws', script: [{ text: ' \n ', hang: true }] },
  {
    name: 'committed_turn_text_and_streamed_tail_are_joined',
    script: [{ text: 'looking', stop: 'tool_use', toolCalls: [call('c1', 'nope')] }, { text: 'tail', hang: true }],
  },
  {
    name: 'a_dot_only_turn_is_dropped',
    script: [{ text: '.', stop: 'tool_use', toolCalls: [call('c1', 'nope')] }, { text: 'tail', hang: true }],
  },
  {
    name: 'committed_turn_text_alone_survives_a_silent_deadline',
    script: [{ text: 'first', stop: 'tool_use', toolCalls: [call('c1', 'nope')] }, { hang: true }],
  },
];

const out = [];
for (const c of cases) {
  const controller = new AbortController();
  let sends = 0;
  const provider = {
    name: 'openrouter',
    escalatedMaxTokens: () => null,
    async send(_sent, _model, _tools, opts) {
      const entry = c.script[sends];
      sends += 1;
      if (!entry) throw new Error(`script exhausted at send ${sends}`);
      if (entry.text) opts.onTextDelta?.(entry.text);
      if (entry.hang) {
        // The deadline of explore/tool.mjs: aborts with a salvage-flagged reason.
        const reason = Object.assign(new Error('explore timed out after 120s'), { salvagePartial: true });
        const timer = setTimeout(() => controller.abort(reason), 20);
        await new Promise((_, reject) => controller.signal.addEventListener('abort', () => { clearTimeout(timer); reject(reason); }));
      }
      return { content: entry.text ?? '', toolCalls: entry.toolCalls ?? [], stopReason: entry.stop };
    },
  };
  const route = { provider: 'openrouter', model: 'fixture-model' };
  try {
    const text = await runExplorer({ query: 'where?', route, provider, cwd: process.cwd(), signal: controller.signal });
    out.push({ ...c, text });
  } catch (error) {
    out.push({ ...c, error: String(error?.message || error) });
  }
}

const dir = join(stage, 'explorer');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'cases.json'), `${JSON.stringify(out, null, 2)}\n`);
refreshSetManifest(stage, nodeRoot);
commitStage(stage, here);
for (const c of out) console.log(c.name, c.error ? `ERROR ${c.error.slice(0, 60)}` : JSON.stringify(c.text));
process.exit(0);
