#!/usr/bin/env node
// Golden of the product's tool definition objects (`native/core/fixtures/tool-defs/definitions.json`):
// every definition the runtime holds (built-ins, the standalone tools, `call_tool`, `apply_patch`,
// `todo`, `goal`) plus the variants a session is sent instead (shell per shell kind, the delegated
// agent's git and task), whole as Node has them: name, title, trigger, description, inputSchema, annotations
// (each only where the definition has it). Rust's embedded definitions and the specs built from
// them are compared with these objects, key for key.
//
//   node benchmarks/rust-core/recorders/record-tool-definitions.mjs --tree <tree>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson } from './lib/common.mjs';
import { nodeToolDefinitions, nodeToolVariants } from './lib/tool-definitions.mjs';

const tree = resolveTree(parseArgs());
const sandbox = mkdtempSync(join(tmpdir(), 'mixdog-tool-definitions-'));
for (const [name, dir] of [['HOME', 'home'], ['USERPROFILE', 'home'], ['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata']]) {
  mkdirSync(join(sandbox, dir), { recursive: true });
  process.env[name] = join(sandbox, dir);
}
process.env.MIXDOG_HOME = join(sandbox, 'mixdog-home');
process.env.MIXDOG_DATA_DIR = join(sandbox, 'mixdog-home', 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';

const { definitions } = await nodeToolDefinitions(tree);
const variants = await nodeToolVariants(tree);
rmSync(sandbox, { recursive: true, force: true });
writeJson(join(FIXTURES_ROOT, 'tool-defs', 'definitions.json'), { definitions, variants });
console.log(`recorded ${definitions.length} definitions, ${variants.length} variants`);
