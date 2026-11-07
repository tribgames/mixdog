#!/usr/bin/env node
// Golden twin of the workflow pack listing (`listWorkflows()` of `workflow-agents-api/workflow-packs.mjs`
// over `listWorkflowPacks` of `runtime-core/workflow/packs.mjs`): the real functions over temp
// install and data folders, for worlds of shipped and user packs (hidden, unnamed, bodiless,
// user copies of shipped packs, names that sort differently by case and accent) and configured
// active workflows.
//
//   node benchmarks/rust-core/recorders/record-workflow-list.mjs --tree <dir>
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } = await import('./lib/common.mjs');
const tree = resolveTree(parseArgs());
const { createWorkflowPacks } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/workflow/packs.mjs');
const { createWorkflowPacksApi } = await importFrom(tree, 'src/session-runtime/workflow-agents-api/workflow-packs.mjs');
const { readMarkdownDocument } = await importFrom(tree, 'src/runtime/shared/markdown-frontmatter.mjs');

const pack = (meta, body = 'Body text.') => `---\n${Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`;

const WORLDS = [
  { name: 'empty', files: [] },
  { name: 'default only', files: [{ side: 'root', path: 'default/WORKFLOW.md', text: pack({ name: 'Default', description: 'The default.' }) }] },
  {
    name: 'mixed',
    files: [
      { side: 'root', path: 'default/WORKFLOW.md', text: pack({ name: 'Default', description: 'The default.' }) },
      { side: 'root', path: 'review/WORKFLOW.md', text: pack({ name: 'Review', description: 'Reviews.' }) },
      { side: 'root', path: 'headless/WORKFLOW.md', text: pack({ name: 'Headless', hidden: 'true' }) },
      { side: 'root', path: 'alpha/WORKFLOW.md', text: pack({ name: 'alpha' }) },
      { side: 'root', path: 'stray/readme.txt', text: 'x' },
      { side: 'data', path: 'review/WORKFLOW.md', text: pack({ name: 'My Review', description: 'Mine.' }) },
      { side: 'data', path: 'mine/WORKFLOW.md', text: pack({ id: 'Mine Pack', name: 'Zeta' }) },
      { side: 'data', path: 'Éclair/WORKFLOW.md', text: pack({ name: 'Éclair', description: 'Accent.' }) },
      { side: 'data', path: 'bodiless/WORKFLOW.md', text: '---\nname: Bodiless\n---\n' },
      { side: 'data', path: 'hidden-user/WORKFLOW.md', text: pack({ name: 'Hidden', hidden: ' TRUE ' }) },
      { side: 'data', path: 'unnamed/WORKFLOW.md', text: pack({ description: 'No name.' }) },
      { side: 'data', path: 'not-hidden/WORKFLOW.md', text: pack({ name: 'Shown', hidden: 'false' }) },
    ],
  },
  {
    name: 'user default override and hidden shipped override',
    files: [
      { side: 'root', path: 'default/WORKFLOW.md', text: pack({ name: 'Default' }) },
      { side: 'root', path: 'review/WORKFLOW.md', text: pack({ name: 'Review' }) },
      { side: 'data', path: 'default/WORKFLOW.md', text: pack({ name: 'My Default' }) },
      { side: 'data', path: 'review/WORKFLOW.md', text: pack({ name: 'Review', hidden: 'true' }) },
    ],
  },
  {
    name: 'sorting',
    files: [
      { side: 'data', path: 'b/WORKFLOW.md', text: pack({ name: 'banana' }) },
      { side: 'data', path: 'a/WORKFLOW.md', text: pack({ name: 'Apple' }) },
      { side: 'data', path: 'c/WORKFLOW.md', text: pack({ name: 'cherry' }) },
      { side: 'data', path: 'd/WORKFLOW.md', text: pack({ name: 'apple' }) },
      { side: 'data', path: 'e/WORKFLOW.md', text: pack({ name: 'Zed' }) },
      { side: 'data', path: 'f/WORKFLOW.md', text: pack({ name: 'ábaco' }) },
      { side: 'data', path: 'g/WORKFLOW.md', text: pack({ name: '10 ten' }) },
      { side: 'data', path: 'h/WORKFLOW.md', text: pack({ name: '9 nine' }) },
    ],
  },
];
const ACTIVE = [undefined, 'review', 'Review', 'solo', 'default', 'ghost', '', null, 'mine-pack', 'a'];

const cases = [];
for (const world of WORLDS) {
  const root = mkdtempSync(join(tmpdir(), 'wf-list-root-'));
  const data = mkdtempSync(join(tmpdir(), 'wf-list-data-'));
  for (const file of world.files) {
    const target = join(file.side === 'root' ? root : data, 'workflows', file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.text);
  }
  const packs = createWorkflowPacks({ rootDir: root, dataDir: data, readMarkdownDocument });
  for (const active of ACTIVE) {
    const config = active === undefined ? {} : { workflow: { active } };
    const api = createWorkflowPacksApi({
      cfgMod: { getPluginData: () => data },
      STANDALONE_DATA_DIR: data,
      getConfig: () => config,
      displayConfig: () => config,
      saveConfigAndAdopt: () => {},
      activeWorkflowId: packs.activeWorkflowId,
      listWorkflowPacks: packs.listWorkflowPacks,
      loadWorkflowPack: packs.loadWorkflowPack,
      workflowSummary: (p) => p,
    });
    cases.push({ world: world.name, files: world.files, config, result: JSON.parse(JSON.stringify(api.listWorkflows())) });
  }
}

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'workflow-list-twin.json'), {
  domain: 'workflow-list-twin',
  recorder: 'benchmarks/rust-core/recorders/record-workflow-list.mjs',
  cases,
});
console.log(`recorded ${cases.length} cases`);