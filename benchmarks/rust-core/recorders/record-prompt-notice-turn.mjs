#!/usr/bin/env node
// Golden twin of how a staged prompt-settings notice reaches the model and when it is acknowledged:
// `buildUserTurn` (`session/manager/ask-turn-prepare.mjs:204`, the reminder suffix and the
// `promptSettingsNoticeRevision` / `runtimeUserContext` meta of the user message) and, on an accepted
// turn, `acknowledgePendingPromptSettingsNotice` (`ask-turn-settle.mjs:155-156`).
//
// A case is a conversation whose settings moved (`stagePromptSettingsNotice`), then the user turn built
// from its prompt; the recording keeps the message the model is sent and the session's notice fields
// after the turn was accepted (`settled`), and after it failed (`failed`: nothing acknowledged).
//
//   node benchmarks/rust-core/recorders/record-prompt-notice-turn.mjs --tree <dir with node_modules>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'prompt-notice-turn');
const stage = stageSet(outDir);

const work = mkdtempSync(join(tmpdir(), 'prompt-notice-turn-'));
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

const manager = 'src/runtime/agent/orchestrator/session/manager';
const settings = await importFrom(tree, `${manager}/prompt-settings.mjs`);
const prepare = await importFrom(tree, `${manager}/ask-turn-prepare.mjs`);
const { promptSettingsRecord, stagePromptSettingsNotice, acknowledgePendingPromptSettingsNotice } = settings;

const clone = (value) => JSON.parse(JSON.stringify(value));
const BASE = {
  meta: '# Output Style: Simple\n\nBe brief.',
  workflow: '# Active Workflow: Default\n\nWork.',
  workflowName: 'Default',
  orchestration: '',
  orchestrationMode: '',
  skills: '',
  instructionFiles: '',
  instructionFilesMode: 'all',
  coreMemory: '# Core Memory\nName: Sam\nLikes tea.',
  language: '',
  responseLanguage: null,
};
const MOVED = { ...BASE, coreMemory: '# Core Memory\nName: Sam\nLikes coffee.' };

const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
const CASES = [
  { name: 'a-text-prompt', prompt: 'Please continue with the plan.' },
  { name: 'a-prompt-with-blocks', prompt: [{ type: 'text', text: 'Look at this.' }, IMAGE] },
  { name: 'a-prompt-with-extra-context', prompt: 'Fix it.', context: 'The build is red.' },
  { name: 'an-injected-turn', prompt: 'Task finished.', turnPromptSource: { source: 'task-notification' } },
];

const results = [];
for (const item of CASES) {
  const session = { id: 'sess_x', provider: 'custom-a', model: 'm', effort: 'medium', messages: [], contextWindow: 200000, cwd: work, promptSettings: promptSettingsRecord(BASE) };
  const startRecord = clone(session.promptSettings);
  stagePromptSettingsNotice(session, clone(MOVED));
  const pending = clone(session.promptSettingsNotice);
  const prepared = await prepare.buildUserTurn({
    session,
    prompt: clone(item.prompt),
    context: item.context,
    explicitPrefetch: null,
    turnSignal: new AbortController().signal,
    transcriptMeta: null,
    turnPromptSource: item.turnPromptSource,
    effortConfiguration: null,
    currentAgents: [],
  });
  // A failed turn never reaches the settle: the notice stays pending, and a rebuilt turn carries it again.
  const failed = { notice: clone(session.promptSettingsNotice ?? null), revision: session.promptSettingsNoticeRevision ?? null };
  const again = await prepare.buildUserTurn({
    session,
    prompt: clone(item.prompt),
    context: item.context,
    explicitPrefetch: null,
    turnSignal: new AbortController().signal,
    transcriptMeta: null,
    turnPromptSource: item.turnPromptSource,
    effortConfiguration: null,
    currentAgents: [],
  });
  const acknowledged = acknowledgePendingPromptSettingsNotice(session, prepared.promptSettingsNotice.revision);
  const next = await prepare.buildUserTurn({
    session,
    prompt: clone(item.prompt),
    context: item.context,
    explicitPrefetch: null,
    turnSignal: new AbortController().signal,
    transcriptMeta: null,
    turnPromptSource: item.turnPromptSource,
    effortConfiguration: null,
    currentAgents: [],
  });
  results.push({
    name: item.name,
    prompt: item.prompt,
    context: item.context ?? null,
    turnPromptSource: item.turnPromptSource ?? null,
    startRecord,
    pending,
    message: prepared.userTurnMessage,
    carriedRevision: prepared.promptSettingsNotice?.revision ?? null,
    failed,
    again: { message: again.userTurnMessage, carriedRevision: again.promptSettingsNotice?.revision ?? null },
    acknowledged,
    after: {
      notice: session.promptSettingsNotice ?? null,
      told: clone(session.promptSettingsTold ?? null),
      recheck: session.promptSettingsRecheck ?? null,
      revision: session.promptSettingsNoticeRevision ?? null,
    },
    next: { message: next.userTurnMessage, carriedRevision: next.promptSettingsNotice?.revision ?? null },
  });
}

writeJson(join(stage, 'twin.json'), { base: BASE, moved: MOVED, cases: results });
writeSetManifest(stage, {
  set: 'prompt-notice-turn',
  recorder: 'benchmarks/rust-core/recorders/record-prompt-notice-turn.mjs',
  command: 'node benchmarks/rust-core/recorders/record-prompt-notice-turn.mjs --tree <tree>',
  identityTree: cli.get('identity-tree') ?? tree,
});
commitStage(stage, outDir);
rmSync(work, { recursive: true, force: true });
console.log(`prompt-notice-turn: ${results.length} cases -> ${outDir}`);
