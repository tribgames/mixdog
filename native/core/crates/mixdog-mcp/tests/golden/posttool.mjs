// Records, from today's Node product, what the session's post-tool hooks send and decide
// (session-hooks.mjs `afterToolHook` / `afterToolFailureHook` / `afterToolBatchHook` over the
// hook bus's `dispatch`): the payload each `mcp_tool` handler receives, and the aggregate the
// loop reads (`updatedToolOutput`, `blocked`, `reason`). The common fields come from the real
// `hookCommonPayload`. Usage: node posttool.mjs <repo-root> <out.json>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, out] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), 'posttool-golden-'));
const hooksFile = join(dir, 'hooks.json');
process.env.MIXDOG_HOOKS_FILE = hooksFile;
process.env.MIXDOG_DATA_DIR = dir;
const load = (...parts) => import(pathToFileURL(join(root, 'src', ...parts)).href);
const { createStandaloneHookBus } = await load('session-runtime', 'services', 'hook-bus.mjs');
const { createHookPayload } = await load('session-runtime', 'hook-payload.mjs');
const { attachSessionHooks } = await load('session-runtime', 'session-hooks.mjs');
const { normalizeHookUpdatedToolOutput } = await load('runtime', 'agent', 'orchestrator', 'session', 'loop', 'tool-helpers.mjs');

const sessionId = 'sess_posttool1';
const cwd = join(dir, 'work');
mkdirSync(join(dir, 'sessions'), { recursive: true });
mkdirSync(cwd, { recursive: true });
const rt = { route: { effectiveEffort: 'High' }, session: { id: sessionId, permissionMode: 'plan' }, currentCwd: cwd };
const { hookCommonPayload } = createHookPayload({ rt, cfgMod: { getPluginData: () => dir } });
const common = hookCommonPayload();

const post = (o) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', ...o } });
const ERR = (message) => ({ error: message });
const envelope = (...content) => ({ content });
const scenarios = [
  { name: 'tool: no output', event: 'PostToolUse', outputs: [''] },
  { name: 'tool: replaced with text', event: 'PostToolUse', outputs: [post({ updatedToolOutput: 'replaced' })] },
  { name: 'tool: replaced with empty text', event: 'PostToolUse', outputs: [post({ updatedToolOutput: '' })] },
  { name: 'tool: replaced with null', event: 'PostToolUse', outputs: [post({ updatedToolOutput: null })] },
  { name: 'tool: text envelope', event: 'PostToolUse', outputs: [post({ updatedToolOutput: envelope({ type: 'text', text: 'a' }, { type: 'text', text: 'b' }) })] },
  { name: 'tool: envelope with an untyped part', event: 'PostToolUse', outputs: [post({ updatedToolOutput: envelope({ type: 'text', text: 'a' }, { text: 'b' }) })] },
  { name: 'tool: envelope with a text part without text', event: 'PostToolUse', outputs: [post({ updatedToolOutput: envelope({ type: 'text' }) })] },
  { name: 'tool: envelope with an image', event: 'PostToolUse', outputs: [post({ updatedToolOutput: envelope({ type: 'text', text: 'a' }, { type: 'image', data: 'x' }) })] },
  { name: 'tool: empty envelope', event: 'PostToolUse', outputs: [post({ updatedToolOutput: envelope() })] },
  { name: 'tool: number', event: 'PostToolUse', outputs: [post({ updatedToolOutput: 5 })] },
  { name: 'tool: array', event: 'PostToolUse', outputs: [post({ updatedToolOutput: [1, 'a'] })] },
  { name: 'tool: object', event: 'PostToolUse', outputs: [post({ updatedToolOutput: { a: 1 } })] },
  { name: 'tool: boolean false', event: 'PostToolUse', outputs: [post({ updatedToolOutput: false })] },
  { name: 'tool: first replacement wins', event: 'PostToolUse', outputs: [post({ updatedToolOutput: 'one' }), post({ updatedToolOutput: 'two' })] },
  { name: 'tool: second replaces after a silent first', event: 'PostToolUse', outputs: [post({}), post({ updatedToolOutput: 'two' })] },
  { name: 'tool: replacement then error', event: 'PostToolUse', outputs: [post({ updatedToolOutput: 'one' }), ERR('boom')] },
  { name: 'tool: handler error', event: 'PostToolUse', outputs: [ERR('boom')] },
  { name: 'tool: wrong event name', event: 'PostToolUse', outputs: [JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedToolOutput: 'x' } })] },
  { name: 'tool: top-level block', event: 'PostToolUse', outputs: [JSON.stringify({ decision: 'block', reason: 'no' })] },
  { name: 'tool: shell with its own directory', event: 'PostToolUse', tool: 'shell', args: { command: 'ls', cwd: 'sub' }, outputs: [post({ updatedToolOutput: 'x' })] },
  { name: 'tool: shell with a blank directory', event: 'PostToolUse', tool: 'shell', args: { command: 'ls', cwd: '  ' }, outputs: [''] },
  { name: 'tool: matcher that does not match', event: 'PostToolUse', matcher: 'shell', outputs: [post({ updatedToolOutput: 'x' })] },
  { name: 'tool: matcher that matches', event: 'PostToolUse', matcher: 'edit|shell', outputs: [post({ updatedToolOutput: 'x' })] },
  { name: 'tool: result with text', event: 'PostToolUse', result: 'line one\nline two', outputs: [''] },
  { name: 'failure: payload', event: 'PostToolUseFailure', result: 'Error: it broke', outputs: [''] },
  { name: 'failure: a hook cannot change it', event: 'PostToolUseFailure', outputs: [post({ updatedToolOutput: 'x' })] },
  { name: 'failure: matcher that does not match', event: 'PostToolUseFailure', matcher: 'shell', outputs: [''] },
  { name: 'batch: no output', event: 'PostToolBatch', outputs: [''] },
  { name: 'batch: block with a reason', event: 'PostToolBatch', outputs: [JSON.stringify({ decision: 'block', reason: 'stop here' })] },
  { name: 'batch: block without a reason', event: 'PostToolBatch', outputs: [JSON.stringify({ decision: 'block' })] },
  { name: 'batch: block with a padded reason', event: 'PostToolBatch', outputs: [JSON.stringify({ decision: 'block', reason: '  padded  ' })] },
  { name: 'batch: approve', event: 'PostToolBatch', outputs: [JSON.stringify({ decision: 'approve' })] },
  { name: 'batch: continue false', event: 'PostToolBatch', outputs: [JSON.stringify({ continue: false, stopReason: 'halt' })] },
  { name: 'batch: second handler blocks', event: 'PostToolBatch', outputs: ['', JSON.stringify({ decision: 'block', reason: 'later' })] },
  { name: 'batch: two blocks keep the first', event: 'PostToolBatch', outputs: [JSON.stringify({ decision: 'block', reason: 'first' }), JSON.stringify({ decision: 'block', reason: 'second' })] },
  { name: 'batch: handler error', event: 'PostToolBatch', outputs: [ERR('boom')] },
];

const results = [];
for (const scenario of scenarios) {
  const matcher = scenario.matcher ?? '*';
  const hooks = scenario.event === 'PostToolBatch' ? {} : { matcher };
  writeFileSync(
    hooksFile,
    JSON.stringify({ hooks: { [scenario.event]: [{ ...hooks, hooks: scenario.outputs.map((_, index) => ({ type: 'mcp_tool', tool: `fixture_${index}` })) }] } })
  );
  const calls = [];
  const payloads = [];
  const bus = createStandaloneHookBus({
    dataDir: dir,
    mcpToolRunner: async ({ name, args }) => {
      calls.push(name);
      payloads.push(args);
      const output = scenario.outputs[Number(name.slice('fixture_'.length))];
      if (output && typeof output === 'object') return `Error: ${output.error}`;
      return output;
    },
  });
  const session = {};
  attachSessionHooks(session, { hooks: bus, hookCommonPayload, getCwd: () => cwd });
  const tool = scenario.tool ?? 'edit';
  const args = scenario.args ?? { file_path: 'a.txt' };
  const result = scenario.result ?? 'ok';
  const input = { name: tool, args, cwd: cwd, sessionId, result };
  let decision;
  if (scenario.event === 'PostToolUse') decision = await session.afterToolHook(input);
  else if (scenario.event === 'PostToolUseFailure') decision = await session.afterToolFailureHook(input);
  else decision = await session.afterToolBatchHook({ sessionId, cwd, toolCount: 2 });
  results.push({
    name: scenario.name,
    event: scenario.event,
    matcher,
    tool,
    args,
    result,
    outputs: scenario.outputs,
    calls,
    payloads,
    decision: decision ?? null,
    // What the loop makes of the replacement (resolveToolResultAfterHook).
    updated: scenario.event === 'PostToolUse' && decision?.updatedToolOutput !== undefined ? { value: normalizeHookUpdatedToolOutput(decision.updatedToolOutput) } : null,
  });
}
rmSync(dir, { recursive: true, force: true });
const text = JSON.stringify({ common: { ...common, cwd: '<CWD>' }, cwd, dir, cases: results }).split(JSON.stringify(dir).slice(1, -1)).join('<DIR>');
writeFileSync(out, `${text}\n`);
console.log(`recorded ${results.length} cases`);
