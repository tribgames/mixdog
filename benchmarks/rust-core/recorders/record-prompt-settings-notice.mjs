#!/usr/bin/env node
// Golden twin of the prompt-settings notice (`session/manager/prompt-settings.mjs`):
// `stagePromptSettingsNotice`, `snapshotPendingPromptSettingsNotice`,
// `acknowledgePendingPromptSettingsNotice` and `notePromptSettingsPresented` (`mixdog-core-prompt`
// `prompt/notice.rs`).
//
// A case is a session that presents `base` sections and a list of steps replayed on it in order:
// `stage` (a conversation meets `sections`), `snapshot` (the notice the next turn carries), `ack` (the
// provider accepted the turn that carried it), `presented` (a rebuilt prompt presents `sections`). Each
// step records what it returned and the session fields the notice machinery owns afterwards
// (`updatedAt` is a clock reading and left out). Every folder is a fresh temp one before any Mixdog
// module is imported.
//
//   node benchmarks/rust-core/recorders/record-prompt-settings-notice.mjs --tree <dir with node_modules>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'prompt-settings-notice');
const stage = stageSet(outDir);

const work = mkdtempSync(join(tmpdir(), 'prompt-settings-notice-'));
const dir = (name) => {
  const path = join(work, name);
  mkdirSync(path, { recursive: true });
  return path;
};
const home = dir('home');
process.env.MIXDOG_DATA_DIR = dir('data');
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_BACKUP_DIR = dir('backup');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.APPDATA = dir('appdata');
process.env.LOCALAPPDATA = dir('localappdata');

const settings = await importFrom(tree, 'src/runtime/agent/orchestrator/session/manager/prompt-settings.mjs');
const { promptSettingsRecord, stagePromptSettingsNotice, snapshotPendingPromptSettingsNotice, acknowledgePendingPromptSettingsNotice, notePromptSettingsPresented } = settings;

const clone = (value) => JSON.parse(JSON.stringify(value));
const META = '# Profile Preferences\n- Language: Korean\n- Level: expert\n\n# Output Style: Simple\n\nBe brief.';
const SKILLS = '<available_skills>\nSelection triggers and linked tools.\n- tidy: Clean up code. [tools: tidy]\n- pdf: Read PDFs.\n- zeta: Last.\n</available_skills>';
const FILES = '# Instruction Files\n\n## /w/AGENTS.md\n\nBe careful.\nRun tests.\n\n## /w/proj/CLAUDE.md\n\nUse tabs.';
const BASE = {
  meta: META,
  workflow: '# Active Workflow: Default\n\nWork.',
  workflowName: 'Default',
  orchestration: '# Orchestration Mode: Balanced\n\nDelegate when useful.',
  orchestrationMode: 'balanced',
  skills: SKILLS,
  instructionFiles: FILES,
  instructionFilesMode: 'all',
  coreMemory: '# Core Memory\nName: Sam\nLikes tea.',
  language: '# Language\n\nAlways respond in Korean.',
  responseLanguage: { id: 'ko', name: 'Korean' },
};
const with_ = (changes) => ({ ...clone(BASE), ...changes });
const big = (tag, count) => Array.from({ length: count }, (_, i) => `${tag} line ${i} ${'x'.repeat(60)}`).join('\n');
const manyFiles = (count, body) =>
  ['# Instruction Files', ...Array.from({ length: count }, (_, i) => `## /w/dir${i}/AGENTS.md\n\n${body(i)}`)].join('\n\n');

const OWNED = ['promptSettings', 'promptSettingsNotice', 'promptSettingsNoticeRevision', 'promptSettingsTold', 'promptSettingsRecheck', 'responseLanguage'];
const owned = (session) => {
  const out = {};
  for (const key of OWNED) if (session[key] !== undefined) out[key] = clone(session[key]);
  return out;
};

const CASES = [
  { name: 'nothing-changed', steps: [{ op: 'stage', sections: with_({}) }] },
  { name: 'output-style-and-profile', steps: [{ op: 'stage', sections: with_({ meta: '# Profile Preferences\n- Language: English\n- Level: expert\n\n# Output Style: Detailed\n\nExplain more.' }) }, { op: 'snapshot' }] },
  { name: 'output-style-removed', steps: [{ op: 'stage', sections: with_({ meta: '# Profile Preferences\n- Language: Korean\n- Level: expert' }) }] },
  { name: 'long-output-style', steps: [{ op: 'stage', sections: with_({ meta: `# Output Style: Long\n\n${big('style', 40)}` }) }] },
  { name: 'skills-added-removed-reordered', steps: [{ op: 'stage', sections: with_({ skills: '<available_skills>\n- zeta: Last.\n- new: Fresh.\n- tidy: Clean up code. [tools: tidy]\n</available_skills>' }) }] },
  {
    name: 'instruction-files',
    steps: [
      { op: 'stage', sections: with_({ instructionFiles: '# Instruction Files\n\n## /w/proj/CLAUDE.md\n\nUse spaces.\n\n## /w/AGENTS.md\n\nBe careful.\nRun tests.\n\n## /w/new/AGENTS.md\n\nNew rule.' }) },
    ],
  },
  { name: 'instruction-file-removed', steps: [{ op: 'stage', sections: with_({ instructionFiles: '# Instruction Files\n\n## /w/AGENTS.md\n\nBe careful.\nRun tests.' }) }] },
  { name: 'instruction-files-mode', steps: [{ op: 'stage', sections: with_({ instructionFilesMode: 'off', instructionFiles: '' }) }] },
  { name: 'core-memory-diff', steps: [{ op: 'stage', sections: with_({ coreMemory: '# Core Memory\nName: Sam\nLikes coffee.' }) }] },
  { name: 'workflow-and-language', steps: [{ op: 'stage', sections: with_({ workflow: '# Active Workflow: Review\n\nReview.', workflowName: 'Review', language: '# Language\n\nAlways respond in English.', responseLanguage: { id: 'en', name: 'English' } }) }] },
  { name: 'language-removed', steps: [{ op: 'stage', sections: with_({ language: '', responseLanguage: null }) }] },
  { name: 'workflow-without-a-name', steps: [{ op: 'stage', sections: with_({ workflow: '# Active Workflow: X\n\nX.', workflowName: null }) }] },
  { name: 'orchestration-text-edited', steps: [{ op: 'stage', sections: with_({ orchestration: '# Orchestration Mode: Balanced\n\nDelegate when useful.\nAlways ask first.' }) }] },
  { name: 'orchestration-mode-switched', steps: [{ op: 'stage', sections: with_({ orchestration: '# Orchestration Mode: Swarm\n\nDelegate.', orchestrationMode: 'swarm' }) }] },
  {
    name: 'told-then-unchanged-then-moved-back',
    steps: [
      { op: 'stage', sections: with_({ coreMemory: '# Core Memory\nName: Sam\nLikes coffee.' }) },
      { op: 'snapshot' },
      { op: 'ack' },
      { op: 'stage', sections: with_({ coreMemory: '# Core Memory\nName: Sam\nLikes coffee.' }) },
      { op: 'snapshot' },
      { op: 'stage', sections: with_({}) },
      { op: 'snapshot' },
    ],
  },
  {
    name: 'a-newer-change-replaces-an-unsent-notice',
    steps: [
      { op: 'stage', sections: with_({ coreMemory: '# Core Memory\nOne.' }) },
      { op: 'stage', sections: with_({ coreMemory: '# Core Memory\nOne.' }) },
      { op: 'stage', sections: with_({ coreMemory: '# Core Memory\nTwo.', skills: '<available_skills>\n- tidy: x\n</available_skills>' }) },
      { op: 'ack', revision: 1 },
      { op: 'ack' },
    ],
  },
  {
    name: 'budget-degrades-to-compact-and-minimal',
    steps: [
      {
        op: 'stage',
        sections: with_({
          meta: `# Profile Preferences\n${Array.from({ length: 30 }, (_, i) => `- Pref ${i}: ${'v'.repeat(50)}`).join('\n')}\n\n# Output Style: Wide\n\n${big('style', 18)}`,
          skills: `<available_skills>\n${Array.from({ length: 80 }, (_, i) => `- skill-${i}: d`).join('\n')}\n</available_skills>`,
          coreMemory: `# Core Memory\n${big('memory', 80)}`,
          instructionFiles: manyFiles(30, (i) => big(`file${i}`, 6)),
          workflow: '# Active Workflow: Big\n\nBig.',
          workflowName: 'Big',
          language: '# Language\n\nAlways respond in English.',
          responseLanguage: { id: 'en', name: 'English' },
        }),
      },
      { op: 'snapshot' },
      { op: 'ack' },
      { op: 'stage', sections: with_({ instructionFiles: manyFiles(30, (i) => big(`file${i}`, 6)) }) },
    ],
  },
  {
    name: 'instruction-files-named-one-by-one',
    steps: [
      { op: 'stage', sections: with_({ instructionFiles: manyFiles(200, (i) => `rule ${i} ${'y'.repeat(30)}`) }) },
      { op: 'ack' },
      { op: 'stage', sections: with_({ instructionFiles: manyFiles(200, (i) => `rule ${i} ${'y'.repeat(30)}`) }) },
    ],
  },
  { name: 'after-a-compaction-compact-forms-only', session: { promptSettingsRecheck: 'compact' }, steps: [{ op: 'stage', sections: with_({ coreMemory: `# Core Memory\n${big('memory', 5)}`, instructionFiles: FILES.replace('Use tabs.', 'Use spaces.') }) }] },
  { name: 'a-prompt-from-before-settings-were-recorded', noRecord: true, steps: [{ op: 'stage', sections: with_({}) }, { op: 'stage', sections: with_({ coreMemory: '# Core Memory\nNew.' }) }] },
  {
    name: 'a-record-that-predates-a-section',
    dropHash: 'coreMemory',
    steps: [{ op: 'stage', sections: with_({ coreMemory: '# Core Memory\nNew.' }) }],
  },
  {
    name: 'a-staged-working-folder-change-tells-its-own-files',
    session: { workspaceReroot: { target: { instructionFilesContext: '# Instruction Files\n\n## /w/AGENTS.md\n\nBe careful.\nRun tests.\nNew rule.\n\n## /w/proj/CLAUDE.md\n\nUse tabs.', coreMemoryContext: '# Core Memory\nMoved.' } } },
    steps: [{ op: 'stage', sections: with_({ instructionFiles: '# Instruction Files\n\n## /w/AGENTS.md\n\nBe careful.\nRun tests.\nNew rule.\n\n## /w/proj/CLAUDE.md\n\nUse tabs.', coreMemory: '# Core Memory\nMoved.', skills: '<available_skills>\n- tidy: x\n</available_skills>' }) }],
  },
  {
    name: 'a-rebuilt-prompt-presents-the-sections',
    steps: [{ op: 'stage', sections: with_({ coreMemory: '# Core Memory\nOne.' }) }, { op: 'presented', sections: with_({ coreMemory: '# Core Memory\nOne.' }) }, { op: 'stage', sections: with_({ coreMemory: '# Core Memory\nOne.' }) }],
  },
];

const results = [];
for (const item of CASES) {
  const session = { id: 'sess_x', ...clone(item.session ?? {}) };
  if (!item.noRecord) {
    session.promptSettings = promptSettingsRecord(BASE);
    if (item.dropHash) delete session.promptSettings.hashes[item.dropHash];
  }
  const steps = [];
  for (const step of item.steps) {
    const entry = { ...step };
    if (step.op === 'stage') entry.returned = stagePromptSettingsNotice(session, clone(step.sections));
    else if (step.op === 'snapshot') entry.returned = snapshotPendingPromptSettingsNotice(session);
    else if (step.op === 'ack') {
      const pending = session.promptSettingsNotice;
      entry.revision = step.revision ?? pending?.revision;
      entry.returned = acknowledgePendingPromptSettingsNotice(session, entry.revision);
    } else if (step.op === 'presented') {
      notePromptSettingsPresented(session, clone(step.sections));
      entry.returned = null;
    }
    entry.session = owned(session);
    steps.push(entry);
  }
  results.push({ name: item.name, session: clone(item.session ?? {}), noRecord: item.noRecord === true, dropHash: item.dropHash ?? null, steps });
}

writeJson(join(stage, 'twin.json'), { base: BASE, cases: results });
writeSetManifest(stage, {
  set: 'prompt-settings-notice',
  recorder: 'benchmarks/rust-core/recorders/record-prompt-settings-notice.mjs',
  command: 'node benchmarks/rust-core/recorders/record-prompt-settings-notice.mjs --tree <tree>',
  identityTree: cli.get('identity-tree') ?? tree,
});
commitStage(stage, outDir);
rmSync(work, { recursive: true, force: true });
console.log(`prompt-settings-notice: ${results.length} cases -> ${outDir}`);
