// Records Node's provider tool exclusions of a session: `recordProviderToolExclusion` (the
// once-per-tool display notice), `beginProviderToolExclusions`, `dropSessionTool`,
// `providerToolExclusionReason`, and the answer a call of an excluded tool gets
// (`preDispatchDenyForSession`). Rust `SessionToolExclusions` + `SessionSurface::refusal_for_call`
// must give the same notices and answers for the same steps.
//
//   node benchmarks/rust-core/recorders/record-tool-exclusions.mjs [--tree <dir>]
//
// Output: native/core/fixtures/tool-exclusions/golden.json.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'tool-exclusions-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
process.env.TZ = 'UTC';
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'tool-exclusions');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-tool-exclusions.mjs';
const at = (path) => importFrom(tree, path);
const { beginProviderToolExclusions, recordProviderToolExclusion, dropSessionTool, providerToolExclusionReason } = await at(
  'src/runtime/agent/orchestrator/session/loop/provider-tool-exclusions.mjs'
);
const { preDispatchDenyForSession } = await at('src/runtime/agent/orchestrator/session/loop/pre-dispatch-deny.mjs');

const tool = (name, pointer, reason) => ({ name, pointer, reason });
const A = tool('mcp__x__broken', '/properties/mode/type', 'must be equal to one of the allowed values');
const SCENARIOS = [
  ['the first exclusion is noticed and a repeat is not', { provider: 'anthropic', model: 'claude-opus' }, [
    { op: 'record', tool: A }, { op: 'reason', name: A.name }, { op: 'deny', name: A.name },
    { op: 'record', tool: A }, { op: 'deny', name: 'mcp__x__fine' },
  ]],
  ['an empty pointer reads as the root', { provider: 'openai', model: 'gpt-5' }, [
    { op: 'record', tool: tool('b', '', 'non-object root') }, { op: 'reason', name: 'b' },
  ]],
  ['a new request forgets the current exclusions but not the notice', { provider: 'anthropic', model: 'claude-opus' }, [
    { op: 'record', tool: A }, { op: 'begin' }, { op: 'reason', name: A.name }, { op: 'deny', name: A.name },
    { op: 'record', tool: A }, { op: 'reason', name: A.name },
  ]],
  ['an unnamed tool is ignored', { provider: 'anthropic', model: 'claude-opus' }, [
    { op: 'record', tool: tool('', '/x', 'bad') }, { op: 'reason', name: '' },
  ]],
  ['a tool recorded again keeps the latest reason and one notice', { provider: 'gemini', model: 'gemini-3-pro' }, [
    { op: 'record', tool: tool('t', '/a', 'first') }, { op: 'record', tool: tool('t', '/b', 'second') }, { op: 'reason', name: 't' }, { op: 'deny', name: 't' },
  ]],
  ['two tools are noticed separately', { provider: 'anthropic', model: 'claude-opus' }, [
    { op: 'record', tool: tool('one', '/p', 'r1') }, { op: 'record', tool: tool('two', '/q', 'r2') }, { op: 'record', tool: tool('one', '/p', 'r1') },
    { op: 'reason', name: 'one' }, { op: 'reason', name: 'two' },
  ]],
  ['a tool dropped for the session holds on its wire family only', { provider: 'openai', model: 'gpt-5' }, [
    { op: 'drop', tool: A }, { op: 'begin' }, { op: 'reason', name: A.name }, { op: 'deny', name: A.name },
    { op: 'route', provider: 'gemini', model: 'gemini-3-pro' }, { op: 'reason', name: A.name },
    { op: 'route', provider: 'openai', model: 'gpt-4.1' }, { op: 'reason', name: A.name },
    { op: 'drop', tool: A },
  ]],
];

const cases = SCENARIOS.map(([name, route, steps]) => {
  const session = { ...route };
  const out = steps.map((step) => {
    const notices = [];
    const onStageChange = (stage, detail) => notices.push({ stage, tone: detail.tone, message: detail.message });
    const done = { ...step };
    switch (step.op) {
      case 'record': recordProviderToolExclusion(session, step.tool, onStageChange); break;
      case 'drop': dropSessionTool(session, step.tool, onStageChange); break;
      case 'begin': beginProviderToolExclusions(session); break;
      case 'route': session.provider = step.provider; session.model = step.model; break;
      case 'reason': done.reason = providerToolExclusionReason(session, step.name); break;
      case 'deny': done.answer = preDispatchDenyForSession(session, { name: step.name, arguments: {} }); break;
      default: throw new Error(step.op);
    }
    done.notices = notices;
    return done;
  });
  return { name, route, steps: out };
});
writeJson(join(stage, 'golden.json'), { cases });
writeSetManifest(stage, { set: 'tool-exclusions', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);