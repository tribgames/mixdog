#!/usr/bin/env node
// Writes the embedded definition files of the built-in tools (`mixdog-tools` `fs/specs`,
// `code_graph/specs`, `git/specs`, `github/specs`, `exec/specs`) from the recorded Node
// definitions (`fixtures/tool-defs/definitions.json`, `record-tool-definitions.mjs`): the whole
// objects, so the description and the schema the model is sent are Node's own.
//
//   node benchmarks/rust-core/recorders/gen-tool-def-files.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, REPO_ROOT, orderedStringify, writeText } from './lib/common.mjs';

const src = join(REPO_ROOT, 'native', 'core', 'crates', 'mixdog-tools', 'src');
const golden = JSON.parse(readFileSync(join(FIXTURES_ROOT, 'tool-defs', 'definitions.json'), 'utf8'));
const lead = (name) => golden.definitions.find((definition) => definition.name === name);
const variant = (name, surface, shellKind, foreground = false) =>
  golden.variants.find((row) => row.name === name && row.surface === surface && row.shellKind === shellKind && Boolean(row.foreground) === foreground)
    .definition;

const FILES = {
  'fs/specs/read.json': lead('read'),
  'fs/specs/edit.json': lead('edit'),
  'fs/specs/apply_patch.json': lead('apply_patch'),
  'fs/specs/list.json': lead('list'),
  'fs/specs/glob.json': lead('glob'),
  'fs/specs/find.json': lead('find'),
  'fs/specs/grep.json': lead('grep'),
  'code_graph/specs/code_graph.json': lead('code_graph'),
  'git/specs/git.json': lead('git'),
  'git/specs/git.agent.json': variant('git', 'agent'),
  'github/specs/github.json': lead('github'),
  'exec/specs/shell.posix.json': variant('shell', 'lead', 'posix'),
  'exec/specs/shell.powershell.json': variant('shell', 'lead', 'powershell'),
  'exec/specs/shell.posix.foreground.json': variant('shell', 'lead', 'posix', true),
  'exec/specs/shell.powershell.foreground.json': variant('shell', 'lead', 'powershell', true),
  'exec/specs/task.json': lead('task'),
  'exec/specs/task.agent.json': variant('task', 'agent'),
};
for (const [path, definition] of Object.entries(FILES)) writeText(join(src, ...path.split('/')), orderedStringify(definition));
console.log(`wrote ${Object.keys(FILES).length} files`);
