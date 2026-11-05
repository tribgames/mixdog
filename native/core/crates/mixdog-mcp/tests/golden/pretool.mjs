// Records, from today's Node product, what the PreToolUse hook bus decides
// (services/hook-bus.mjs `beforeTool`) for sequences of `mcp_tool` handler outputs, as the
// golden the Rust `BusPreToolHook` replays. Usage: node pretool.mjs <repo-root> <out.json>
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, out] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), 'pretool-golden-'));
const hooksFile = join(dir, 'hooks.json');
process.env.MIXDOG_HOOKS_FILE = hooksFile;
process.env.MIXDOG_DATA_DIR = dir;
const { createStandaloneHookBus } = await import(pathToFileURL(join(root, 'src', 'session-runtime', 'services', 'hook-bus.mjs')).href);

const pre = (o) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...o } });
const rewrite = { updatedToolName: 'read', updatedInput: { file_path: 'revised.txt' } };
const ask = { permissionDecision: 'ask', permissionDecisionReason: 'confirm revised request' };
const ERR = (message) => ({ error: message });

const scenarios = [
  { name: 'no output', outputs: [''] },
  { name: 'not json', outputs: ['not json'] },
  { name: 'empty object', outputs: ['{}'] },
  { name: 'allow', outputs: [pre({ permissionDecision: 'allow' })] },
  { name: 'allow with reason', outputs: [pre({ permissionDecision: 'allow', permissionDecisionReason: 'fine' })] },
  { name: 'deny with reason', outputs: [pre({ permissionDecision: 'deny', permissionDecisionReason: 'no way' })] },
  { name: 'deny without reason', outputs: [pre({ permissionDecision: 'deny' })] },
  { name: 'deny with a padded reason', outputs: [pre({ permissionDecision: 'deny', permissionDecisionReason: '  padded  ' })] },
  { name: 'ask with reason', outputs: [pre(ask)] },
  { name: 'ask without reason', outputs: [pre({ permissionDecision: 'ask' })] },
  { name: 'unknown decision', outputs: [pre({ permissionDecision: 'defer' })] },
  { name: 'decision in other case', outputs: [pre({ permissionDecision: 'DENY', permissionDecisionReason: 'x' })] },
  { name: 'rewrite only', outputs: [pre(rewrite)] },
  { name: 'rewrite input only', outputs: [pre({ updatedInput: { a: 1 } })] },
  { name: 'rewrite name only', outputs: [pre({ updatedToolName: 'read' })] },
  { name: 'rewrite with array input', outputs: [pre({ updatedInput: [1] })] },
  { name: 'rewrite with string input', outputs: [pre({ updatedInput: 'x' })] },
  { name: 'rewrite with null input', outputs: [pre({ updatedInput: null })] },
  { name: 'rewrite with an empty name', outputs: [pre({ updatedToolName: '', updatedInput: { a: 1 } })] },
  { name: 'rewrite with a padded name', outputs: [pre({ updatedToolName: '  read  ' })] },
  { name: 'rewrite with a non-string name', outputs: [pre({ updatedToolName: 5 })] },
  { name: 'rewrite and ask in one', outputs: [pre({ ...rewrite, ...ask })] },
  { name: 'rewrite then ask', outputs: [pre(rewrite), pre(ask)] },
  { name: 'ask then rewrite', outputs: [pre(ask), pre(rewrite)] },
  { name: 'rewrite then deny', outputs: [pre({ ...rewrite, ...ask }), pre({ permissionDecision: 'deny', permissionDecisionReason: 'fixture denial' }), pre({ permissionDecision: 'allow' })] },
  { name: 'two rewrites', outputs: [pre({ updatedInput: { a: 1 } }), pre({ updatedInput: { b: 2 }, updatedToolName: 'write' })] },
  { name: 'allow after ask', outputs: [pre(ask), pre({ permissionDecision: 'allow' })] },
  { name: 'ask after allow', outputs: [pre({ permissionDecision: 'allow' }), pre(ask)] },
  { name: 'two denials', outputs: [pre({ permissionDecision: 'deny', permissionDecisionReason: 'first' }), pre({ permissionDecision: 'deny', permissionDecisionReason: 'second' })] },
  { name: 'old style block', outputs: [JSON.stringify({ decision: 'block', reason: 'old block' })] },
  { name: 'old style approve', outputs: [JSON.stringify({ decision: 'approve' })] },
  { name: 'old style block without reason', outputs: [JSON.stringify({ decision: 'block' })] },
  { name: 'continue false', outputs: [JSON.stringify({ continue: false, stopReason: 'stop it' })] },
  { name: 'continue false without reason', outputs: [JSON.stringify({ continue: false })] },
  { name: 'additional context', outputs: [pre({ additionalContext: 'note' })] },
  { name: 'wrong event name', outputs: [JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', permissionDecision: 'deny' } })] },
  { name: 'no event name', outputs: [JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } })] },
  { name: 'padded json', outputs: [`  \n${pre({ permissionDecision: 'deny', permissionDecisionReason: 'p' })}\n `] },
  { name: 'json with a byte order mark', outputs: [`\ufeff${pre({ permissionDecision: 'deny', permissionDecisionReason: 'bom' })}`] },
  { name: 'json array', outputs: ['[]'] },
  { name: 'json string', outputs: ['"deny"'] },
  { name: 'handler error then deny', outputs: [ERR('boom'), pre({ permissionDecision: 'deny', permissionDecisionReason: 'after error' })] },
  { name: 'handler error alone', outputs: [ERR('boom')] },
  { name: 'matcher that matches', matcher: 'edit', outputs: [pre({ permissionDecision: 'deny', permissionDecisionReason: 'm' })] },
  { name: 'matcher that does not match', matcher: 'shell', outputs: [pre({ permissionDecision: 'deny', permissionDecisionReason: 'm' })] },
  { name: 'matcher alternation', matcher: 'shell|edit', outputs: [pre({ permissionDecision: 'deny', permissionDecisionReason: 'm' })] },
  { name: 'matcher is a regex', matcher: '^ed', outputs: [pre({ permissionDecision: 'deny', permissionDecisionReason: 'm' })] },
  { name: 'invalid matcher regex', matcher: '(', outputs: [pre({ permissionDecision: 'deny', permissionDecisionReason: 'm' })] },
  { name: 'empty matcher', matcher: '', outputs: [pre({ permissionDecision: 'deny', permissionDecisionReason: 'm' })] },
  { name: 'tool name with a prefix', tool: 'mcp__gmail__send_email', matcher: 'mcp__gmail__.*', outputs: [pre({ permissionDecision: 'ask', permissionDecisionReason: 'mail' })] },
];

const results = [];
for (const scenario of scenarios) {
  writeFileSync(
    hooksFile,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            ...(scenario.matcher === undefined ? { matcher: '*' } : { matcher: scenario.matcher }),
            hooks: scenario.outputs.map((_, index) => ({ type: 'mcp_tool', tool: `fixture_${index}` })),
          },
        ],
      },
    })
  );
  const calls = [];
  const bus = createStandaloneHookBus({
    dataDir: dir,
    mcpToolRunner: async ({ name }) => {
      calls.push(name);
      const output = scenario.outputs[Number(name.slice('fixture_'.length))];
      // A tool that reports `isError` answers the model-visible `Error:` text, not an exception
      // (executeMcpTool), so it reaches the hook output parser as ordinary stdout.
      if (output && typeof output === 'object') return `Error: ${output.error}`;
      return output;
    },
  });
  const tool = scenario.tool || 'edit';
  const decision = await bus.beforeTool({ name: tool, args: { file_path: 'original.txt' }, cwd: dir });
  results.push({ name: scenario.name, matcher: scenario.matcher ?? '*', tool, outputs: scenario.outputs, calls, decision: decision ?? null });
}
rmSync(dir, { recursive: true, force: true });
writeFileSync(out, `${JSON.stringify({ cases: results })}\n`);
console.log(`recorded ${results.length} cases`);
