// Records, from today's Node product, what the session's compaction hooks send (session-hooks.mjs
// `preCompactHook` / `postCompactHook` over the hook bus's `dispatch`): the payload each `mcp_tool`
// handler receives for `PreCompact` and `PostCompact`. The common fields come from the real
// `hookCommonPayload`. Usage: node compact.mjs <repo-root> <out.json>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, out] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), 'compact-golden-'));
const hooksFile = join(dir, 'hooks.json');
process.env.MIXDOG_HOOKS_FILE = hooksFile;
process.env.MIXDOG_DATA_DIR = dir;
const load = (...parts) => import(pathToFileURL(join(root, 'src', ...parts)).href);
const { createStandaloneHookBus } = await load('session-runtime', 'services', 'hook-bus.mjs');
const { createHookPayload } = await load('session-runtime', 'hook-payload.mjs');
const { attachSessionHooks } = await load('session-runtime', 'session-hooks.mjs');

const sessionId = 'sess_compact1';
const cwd = join(dir, 'work');
mkdirSync(join(dir, 'sessions'), { recursive: true });
mkdirSync(cwd, { recursive: true });
const rt = { route: { effectiveEffort: 'High' }, session: { id: sessionId, permissionMode: 'plan' }, currentCwd: cwd };
const { hookCommonPayload } = createHookPayload({ rt, cfgMod: { getPluginData: () => dir } });
const common = hookCommonPayload();

const scenarios = [
  { name: 'pre: manual', event: 'PreCompact', trigger: 'manual', outputs: [''] },
  { name: 'pre: auto_clear', event: 'PreCompact', trigger: 'auto_clear', outputs: [''] },
  { name: 'pre: auto', event: 'PreCompact', trigger: 'auto', outputs: [''] },
  { name: 'pre: no trigger defaults to auto', event: 'PreCompact', trigger: undefined, outputs: [''] },
  { name: 'pre: empty trigger defaults to auto', event: 'PreCompact', trigger: '', outputs: [''] },
  { name: 'pre: matcher that matches', event: 'PreCompact', trigger: 'manual', matcher: 'manual', outputs: [''] },
  { name: 'pre: matcher that does not match', event: 'PreCompact', trigger: 'auto_clear', matcher: 'manual', outputs: [''] },
  { name: 'pre: two handlers', event: 'PreCompact', trigger: 'manual', outputs: ['', ''] },
  { name: 'pre: handler error', event: 'PreCompact', trigger: 'manual', outputs: [{ error: 'boom' }] },
  { name: 'pre: a block changes nothing', event: 'PreCompact', trigger: 'manual', outputs: [JSON.stringify({ decision: 'block', reason: 'no' })] },
  { name: 'post: manual', event: 'PostCompact', trigger: 'manual', outputs: [''] },
  { name: 'post: auto_clear', event: 'PostCompact', trigger: 'auto_clear', outputs: [''] },
  { name: 'post: matcher that does not match', event: 'PostCompact', trigger: 'auto_clear', matcher: 'manual', outputs: [''] },
  { name: 'post: handler error', event: 'PostCompact', trigger: 'manual', outputs: [{ error: 'boom' }] },
];
const results = [];
for (const scenario of scenarios) {
  const matcher = scenario.matcher ?? '*';
  writeFileSync(
    hooksFile,
    JSON.stringify({ hooks: { [scenario.event]: [{ matcher, hooks: scenario.outputs.map((_, index) => ({ type: 'mcp_tool', tool: `fixture_${index}` })) }] } })
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
  const session = { id: sessionId };
  attachSessionHooks(session, { hooks: bus, hookCommonPayload, getCwd: () => cwd });
  const input = scenario.trigger === undefined ? {} : { trigger: scenario.trigger };
  if (scenario.event === 'PreCompact') await session.preCompactHook(input);
  else await session.postCompactHook(input);
  results.push({ name: scenario.name, event: scenario.event, matcher, trigger: scenario.trigger ?? null, outputs: scenario.outputs, calls, payloads });
}
rmSync(dir, { recursive: true, force: true });
const text = JSON.stringify({ common: { ...common, cwd: '<CWD>' }, cwd, dir, cases: results }).split(JSON.stringify(dir).slice(1, -1)).join('<DIR>');
writeFileSync(out, `${text}\n`);
console.log(`recorded ${results.length} cases`);

