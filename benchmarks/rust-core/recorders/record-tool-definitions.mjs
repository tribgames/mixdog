// The one fixture of the real Node tool definitions. Every definition the runtime holds (built-ins, the standalone
// tools, `call_tool`, `apply_patch`, `todo`, `goal`, the `public:false` fetch tools), plus the variants a session is
// sent instead: the delegated agent's `git`/`task` (`name@agent`), the `shell` text per shell kind with and without
// background tasks (`shell@posix`, `shell@powershell`, `shell@posix-foreground`, `shell@powershell-foreground`), the
// internal tools as `_getMcpTools` projects them (`name@internal`) and the edit dialects (`shell@claude`, `shell@gpt`).
// Each entry is the whole definition as Node has it (name, title, trigger, description, inputSchema, annotations, each
// only where the definition has it) with the content hash of its canonical JSON.
//
// Rust embedded definitions and the specs built from them are compared with these objects, key for key, through
// `mixdog_js::fixture_tools::definition`; the goldens that carry tool definitions reference them
// (`lib/tool-definitions.mjs` `compactTools`, loaded by `fixture_tools::parse_golden`). This replaces the former
// `fixtures/tool-defs/definitions.json` and its recorder.
////   node benchmarks/rust-core/recorders/record-tool-definitions.mjs --tree <dir with node_modules>
//
// Output: native/core/fixtures/tool-definitions/definitions.json (`tree` names the product tree's `src` hash).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'tool-definitions-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';
const { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, productIdentity, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { toolDefinitionsFixture } = await import('./lib/tool-definitions.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');

// `--patch <file>`: the tree is the reference commit with that Node fix applied (a clear Node bug fixed on both sides);
// the manifest names the fix.
const BASE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'tool-definitions');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-tool-definitions.mjs';
const patched = args.get('patch');
const identity = patched ? nodeTreeIdentity(args, tree, BASE_COMMIT) : productIdentity(tree);
const fixture = await toolDefinitionsFixture(tree, { srcSha256: identity.srcSha256 });
writeJson(join(stage, 'definitions.json'), fixture);
writeSetManifest(stage, {
  set: 'tool-definitions',
  recorder,
  command: `node ${recorder} --tree <tree>${patched ? ` --patch ${patched}` : ''}`,
  ...(patched ? { identity } : { identityTree: tree }),
  extra: recorderProvenance(import.meta.url),
});
commitStage(stage, finalDir);
console.log(`tool definitions: ${Object.keys(fixture.definitions).length} entries`);