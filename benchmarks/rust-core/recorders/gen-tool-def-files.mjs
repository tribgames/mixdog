#!/usr/bin/env node
// Writes the embedded definition files of the built-in tools (`mixdog-tools` `fs/specs`,
// `code_graph/specs`, `git/specs`, `github/specs`, `exec/specs`) from the recorded Node
// definitions (`fixtures/tool-definitions/definitions.json`, `record-tool-definitions.mjs`): the whole
// objects, so the description and the schema the model is sent are Node's own.
//
//   node benchmarks/rust-core/recorders/gen-tool-def-files.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, REPO_ROOT, orderedStringify, writeText } from './lib/common.mjs';

const src = join(REPO_ROOT, 'native', 'core', 'crates', 'mixdog-tools', 'src');
const definitions = JSON.parse(readFileSync(join(FIXTURES_ROOT, 'tool-definitions', 'definitions.json'), 'utf8')).definitions;
// A definition by key: `name` for the Lead's, `name@variant` for a variant (`git@agent`, `shell@posix-foreground`...).
const def = (key) => {
  if (!definitions[key]) throw new Error(`no recorded definition ${key}`);
  return definitions[key].definition;
};

const FILES = {
  'fs/specs/read.json': def('read'),
  'fs/specs/edit.json': def('edit'),
  'fs/specs/apply_patch.json': def('apply_patch'),
  'fs/specs/list.json': def('list'),
  'fs/specs/glob.json': def('glob'),
  'fs/specs/find.json': def('find'),
  'fs/specs/grep.json': def('grep'),
  'code_graph/specs/code_graph.json': def('code_graph'),
  'git/specs/git.json': def('git'),
  'git/specs/git.agent.json': def('git@agent'),
  'github/specs/github.json': def('github'),
  'exec/specs/shell.posix.json': def('shell@posix'),
  'exec/specs/shell.powershell.json': def('shell@powershell'),
  'exec/specs/shell.posix.foreground.json': def('shell@posix-foreground'),
  'exec/specs/shell.powershell.foreground.json': def('shell@powershell-foreground'),
  'exec/specs/task.json': def('task'),
  'exec/specs/task.agent.json': def('task@agent'),
};
for (const [path, definition] of Object.entries(FILES)) writeText(join(src, ...path.split('/')), orderedStringify(definition));
console.log(`wrote ${Object.keys(FILES).length} files`);
