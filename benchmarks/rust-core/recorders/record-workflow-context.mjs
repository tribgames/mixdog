#!/usr/bin/env node
// Golden of the pack half of `activeWorkflowContext(config, dir)` (`runtime-core/workflow/
// context.mjs`): `workflowSummary(pack, { hasAgents })` and `workflowContextBlockFromPack(pack)`
// over the real pack loader and agent scan of `createWorkflowHelpers`:
// `native/core/fixtures/workflow-surface/context.json`.
//
// Each case is a sandbox (install root + data dir, files as text), the workflow id the config names
// as active, and what Node answered: `summary`, `packContext` and whether the agent scan found a
// delegatable agent (`hasAgents`, which the summary's `delegatesAgents` follows).
//
//   node benchmarks/rust-core/recorders/record-workflow-context.mjs --tree <tree>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const sandbox = mkdtempSync(join(tmpdir(), 'mixdog-workflow-context-'));
for (const [name, dir] of [['HOME', 'home'], ['USERPROFILE', 'home'], ['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata']]) {
  mkdirSync(join(sandbox, dir), { recursive: true });
  process.env[name] = join(sandbox, dir);
}
process.env.MIXDOG_HOME = join(sandbox, 'mixdog-home');
process.env.MIXDOG_DATA_DIR = join(sandbox, 'mixdog-home', 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';

const { createWorkflowHelpers } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/workflow.mjs');
const { normalizeAgentPermissionOrNone, readMarkdownDocument } = await importFrom(tree, 'src/runtime/shared/markdown-frontmatter.mjs');

const pack = (fields, body) => {
  const head = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return head.length ? `---\n${head.join('\n')}\n---\n${body}` : body;
};
const DEFAULT = pack({ name: 'Default', description: 'The shipped default' }, '# Default\n\nShipped default body.\n');
const AGENT = { 'agents/mine/AGENT.md': pack({ name: 'Mine' }, 'Do things.') };

// `data` / `root`: path -> text. `active`: the id the config names; absent: the config has none.
const CASES = [
  { name: 'user-pack-drops-its-own-title', active: 'review', data: { 'workflows/review/WORKFLOW.md': pack({ id: 'review', name: 'Review', description: 'Checks twice' }, '# Review\n\nRead twice.\n') }, root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'title-matches-case-insensitively', active: 'review', data: { 'workflows/review/WORKFLOW.md': pack({ name: 'Review' }, '# REVIEW\n\n\n   Body after blanks.\n') }, root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'other-title-is-kept', active: 'review', data: { 'workflows/review/WORKFLOW.md': pack({ name: 'Review', description: 'd' }, '# Something else\n\nBody.\n') }, root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'one-line-body-equal-to-title-is-kept', active: 'review', data: { 'workflows/review/WORKFLOW.md': pack({ name: 'Review' }, '# Review') }, root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'no-description', active: 'review', data: { 'workflows/review/WORKFLOW.md': pack({ name: 'Review' }, 'Just text\nsecond line') }, root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'name-defaults-to-the-id', active: 'plain', data: { 'workflows/plain/WORKFLOW.md': pack({}, '# plain\n\nBody') }, root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'crlf-title-line', active: 'review', data: { 'workflows/review/WORKFLOW.md': pack({ name: 'Review' }, '# Review \r\nBody line\r\nnext\r\n') }, root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'special-lowercase-names', active: 'turkish', data: { 'workflows/turkish/WORKFLOW.md': pack({ name: 'İSTANBUL ΟΔΟΣ' }, '# i̇stanbul οδος\n\nBody') }, root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'description-with-dash-and-padding', active: 'review', data: { 'workflows/review/WORKFLOW.md': pack({ name: ' Review ', description: '  a — b  ' }, 'Body') }, root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'shipped-pack', active: 'headless', root: { 'workflows/default/WORKFLOW.md': DEFAULT, 'workflows/headless/WORKFLOW.md': pack({ name: 'Headless', description: 'No agents' }, '# Headless\n\nShipped headless.\n') } },
  { name: 'user-copy-of-a-shipped-pack-wins', active: 'headless', data: { 'workflows/headless/WORKFLOW.md': pack({ name: 'Mine' }, 'Mine body') }, root: { 'workflows/default/WORKFLOW.md': DEFAULT, 'workflows/headless/WORKFLOW.md': pack({ name: 'Headless' }, 'Shipped headless') } },
  { name: 'missing-id-falls-back-to-the-default-pack', active: 'nope', root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'solo-is-the-default-pack', active: 'solo', root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'no-active-workflow', root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'id-is-normalised', active: 'My Review_2', data: { 'workflows/my-review-2/WORKFLOW.md': pack({ name: 'My Review 2' }, 'Body') }, root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'declared-id-differs-from-the-folder', active: 'folder', data: { 'workflows/folder/WORKFLOW.md': pack({ id: 'Declared', name: 'Declared' }, 'Body') }, root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'hidden-pack-still-loads', active: 'quiet', data: { 'workflows/quiet/WORKFLOW.md': pack({ name: 'Quiet', hidden: 'true' }, 'Body') }, root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'empty-user-pack-falls-through', active: 'review', data: { 'workflows/review/WORKFLOW.md': '---\nname: Review\n---\n   \n' }, root: { 'workflows/default/WORKFLOW.md': DEFAULT, 'workflows/review/WORKFLOW.md': pack({ name: 'Review shipped' }, 'Shipped review') } },
  { name: 'agents-present', active: 'review', data: { 'workflows/review/WORKFLOW.md': pack({ name: 'Review' }, 'Body'), ...AGENT }, root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'agents-present-default', active: 'default', data: AGENT, root: { 'workflows/default/WORKFLOW.md': DEFAULT } },
  { name: 'no-pack-at-all', active: 'review' },
  { name: 'no-pack-at-all-with-agents', active: 'default', data: AGENT },
  { name: 'default-without-a-name', active: 'default', root: { 'workflows/default/WORKFLOW.md': 'Body only' } },
];

function lay(folder, files) {
  for (const [path, text] of Object.entries(files ?? {})) {
    const file = join(folder, ...path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

const recorded = [];
for (const [index, scenario] of CASES.entries()) {
  const root = join(sandbox, `case-${index}`, 'root');
  const data = join(sandbox, `case-${index}`, 'data');
  mkdirSync(root, { recursive: true });
  mkdirSync(data, { recursive: true });
  lay(root, scenario.root);
  lay(data, scenario.data);
  const helpers = createWorkflowHelpers({ rootDir: root, dataDir: () => data, readMarkdownDocument, normalizeAgentPermissionOrNone });
  const config = scenario.active === undefined ? {} : { workflow: { active: scenario.active } };
  const context = helpers.activeWorkflowContext(config, data);
  recorded.push({
    name: scenario.name,
    active: scenario.active ?? null,
    root: scenario.root ?? {},
    data: scenario.data ?? {},
    hasAgents: helpers.delegatableAgentIds(config, data).length > 0,
    summary: context.summary,
    packContext: context.packContext,
  });
}
rmSync(sandbox, { recursive: true, force: true });
writeJson(join(FIXTURES_ROOT, 'workflow-surface', 'context.json'), { cases: recorded });
console.log(`recorded ${recorded.length} cases`);
