#!/usr/bin/env node
// Golden twin of the reminder block every user turn carries: `buildUserTurn`
// (`session/manager/ask-turn-prepare.mjs:147-246`) and the acknowledgements an accepted turn makes
// (`ask-turn-settle.mjs:148-164`).
//
// A case is a session record (header fields + `messages`) and the turn built from it. The recording
// keeps the user message the model is sent, the revision each reminder carried, and the session record
// after the turn was accepted (`after`: every snapshot and acknowledgement applied, in Node's order).
// The clock cases record `buildCurrentTimeBlock` in several zones.
//
//   node benchmarks/rust-core/recorders/record-turn-reminders.mjs --tree <dir with node_modules>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'turn-reminders');
const stage = stageSet(outDir);

const work = mkdtempSync(join(tmpdir(), 'turn-reminders-'));
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

// The instant `new Date()` reads (the current-time reminder). `Date.now()` stays real, so deadline loops in the
// modules under test still end; the `updatedAt` stamps it writes are normalised to this instant below.
const NOW = '2026-11-07T15:20:00.123Z';
const RealDate = Date;
const FIXED = RealDate.parse(NOW);
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(FIXED);
  }
};
process.env.TZ = 'Asia/Seoul';

const manager = 'src/runtime/agent/orchestrator/session/manager';
const core = 'src/runtime/agent/orchestrator/runtime-core';
const prepare = await importFrom(tree, `${manager}/ask-turn-prepare.mjs`);
const promptSettings = await importFrom(tree, `${manager}/prompt-settings.mjs`);
const promptUtils = await importFrom(tree, `${manager}/prompt-utils.mjs`);
const workflowNotice = await importFrom(tree, `${manager}/workflow-switch-notice.mjs`);
const modeNotice = await importFrom(tree, `${manager}/orchestration-mode-switch-notice.mjs`);
const delta = await importFrom(tree, `${core}/deferred-tool-delta.mjs`);
const goalReminder = await importFrom(tree, `${core}/goal-reminder.mjs`);
const orchestration = await importFrom(tree, `${core}/orchestration.mjs`);
const listing = await importFrom(tree, `${manager}/agent-listing-notice.mjs`);
const attachments = await importFrom(tree, 'src/runtime/attachments/store.mjs');

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const BP3_SEPARATOR = '\n\n---\n\n';
const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };

const agentLine = (id, name, description) => `- ${name} (${id})${description ? `: ${description}` : ''}`;
const agentEntry = (id, name, description) => ({ id, name, line: agentLine(id, name, description) });
const CATALOG = [agentEntry('reviewer', 'Reviewer', 'Reads diffs.'), agentEntry('worker', 'Worker', 'Implements.')];
const catalogSlice = (entries) => `# Available Agents\n\n${entries.map((entry) => entry.line).join('\n')}`;

// A conversation's system prefix, as the manager keeps it: BP1, BP2, the tier3 core and the env block.
function session(extra = {}) {
  const core = [`# Active Workflow: Default\n\nWork.`, catalogSlice(CATALOG)].join(BP3_SEPARATOR);
  return {
    id: 'sess_x',
    provider: 'custom-a',
    model: 'm',
    effort: 'medium',
    contextWindow: 200000,
    cwd: '/work/old',
    bp3EnvSplit: true,
    bp3CoreContext: core,
    bp3EnvironmentContext: '- Cwd: /work/old — the active Project root\n- Shell: bash',
    workflow: { id: 'default', name: 'Default' },
    orchestrationMode: 'swarm',
    messages: [
      { role: 'system', content: 'BP1 rules' },
      { role: 'system', content: 'BP2 stable' },
      { role: 'system', content: core, cacheTier: 'tier3' },
      { role: 'system', content: '# Session\nCwd: /work/old\n\n---\n\n- Cwd: /work/old — the active Project root', cacheTier: 'env' },
    ],
    ...extra,
  };
}
const withHistory = (base) => ({
  ...base,
  messages: [
    ...base.messages,
    { role: 'user', content: 'Earlier question.', meta: { transcript: { messageId: 'm1' } } },
    { role: 'assistant', content: 'Earlier answer.' },
  ],
});

// The prompt-settings sections a conversation was built with (the notice's own recorder moves them).
const SETTINGS = {
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

const CASES = [];
const add = (name, make, turn = {}) => CASES.push({ name, make, turn });

add('no-reminder-plain-turn', () => session(), { prompt: 'Please continue with the plan.', currentAgents: CATALOG });

add('workflow-overlay', () => {
  const content = workflowNotice.workflowOverlayContent({
    promptName: 'Default',
    workflow: { id: 'review', name: 'Review' },
    instructions: '# Active Workflow: Review\n\nReview only.',
    deniedTools: ['edit'],
    loadableTools: ['web_search'],
    unavailableTools: ['computer'],
  });
  return withHistory(
    session({
      workflowSwitch: { version: 1, revision: 2, from: { id: 'default', name: 'Default' }, to: { id: 'review', name: 'Review' } },
      workflowOverlay: {
        prompt: { id: 'default', name: 'Default' },
        promptOrchestrationMode: 'swarm',
        workflow: { id: 'review', name: 'Review' },
        deniedTools: ['edit'],
        unavailableTools: ['computer'],
        content,
      },
    })
  );
}, { prompt: 'Continue.', currentAgents: CATALOG });

add('workflow-carried-by-prompt', () =>
  withHistory(session({ workflowSwitch: { version: 1, revision: 5, from: { id: 'review', name: 'Review' }, to: { id: 'default', name: 'Default' } } })),
  { prompt: 'Continue.', currentAgents: CATALOG });

add('workflow-from-unnamed', () =>
  withHistory(session({ workflowSwitch: { version: 1, revision: 1, from: null, to: { id: 'default', name: 'Default' } } })),
  { prompt: 'Continue.', currentAgents: CATALOG });

add('orchestration-overlay', () =>
  withHistory(
    session({
      orchestrationModeSwitch: { version: 1, revision: 3, from: 'swarm', to: 'focused' },
      orchestrationModeOverlay: {
        prompt: 'swarm',
        mode: 'focused',
        loadableTools: ['agent'],
        content: modeNotice.orchestrationModeNoticeContent({ mode: 'focused', loadableTools: ['agent'] }),
      },
    })
  ),
  { prompt: 'Continue.', currentAgents: CATALOG });

add('orchestration-carried-by-prompt', () =>
  withHistory(session({ orchestrationModeSwitch: { version: 1, revision: 4, from: 'focused', to: 'none' } })),
  { prompt: 'Continue.', currentAgents: CATALOG });

add('agents-added-and-removed', () => withHistory(session()), {
  prompt: 'Continue.',
  currentAgents: [CATALOG[0], agentEntry('scout', 'Scout', 'Looks around.'), agentEntry('plain', 'Plain', '')],
});

add('agents-all-removed', () => withHistory(session()), { prompt: 'Continue.', currentAgents: [] });

add('agents-told-by-an-earlier-turn', () => {
  const base = withHistory(session());
  base.messages.push({
    role: 'user',
    content: 'Next.\n\nreminder',
    meta: {
      agentListing: { added: [{ id: 'scout', name: 'Scout' }], removed: [{ id: 'worker', name: 'Worker' }] },
      runtimeUserContext: { prefix: '', suffix: '\n\nreminder' },
    },
  });
  base.messages.push({ role: 'assistant', content: 'Done.' });
  return base;
}, { prompt: 'Continue.', currentAgents: [CATALOG[0], agentEntry('scout', 'Scout', 'Looks around.')] });

add('agents-unknown-for-a-worker', () => withHistory(session()), { prompt: 'Continue.', currentAgents: undefined });

add('workspace-moved', () => {
  const s = withHistory(session());
  promptUtils.refreshSessionWorkspaceContext(s, {
    cwd: '/work/new',
    environmentContext: '- Cwd: /work/new — the active Project root\n- Shell: bash\n- Git: clean',
    coreMemoryContext: 'New memory.',
    instructionFilesContext: '# Instruction Files\n\nBe careful.',
    move: { from: '/work/old', changes: 'carried' },
  });
  return s;
}, { prompt: 'Continue.', currentAgents: CATALOG });

add('workspace-moved-nothing-else-changed', () => {
  const s = withHistory(session());
  promptUtils.refreshSessionWorkspaceContext(s, { cwd: '/work/other', instructionFilesContext: '', coreMemoryContext: '' });
  return s;
}, { prompt: 'Continue.', currentAgents: CATALOG });

add('workspace-same-folder', () => {
  const s = withHistory(session());
  promptUtils.refreshSessionWorkspaceContext(s, { cwd: '/work/old', environmentContext: '- Cwd: /work/old' });
  return s;
}, { prompt: 'Continue.', currentAgents: CATALOG });

add('setup-notice', () =>
  withHistory(
    session({
      pendingSetupNotice: { revision: 7, content: '<system-reminder>\n# Worktree Prepared\nLinked 2 files; installed dependencies.\n</system-reminder>' },
    })
  ),
  { prompt: 'Continue.', currentAgents: CATALOG });

add('current-time-asked', () => withHistory(session()), { prompt: 'what time is it now?', currentAgents: CATALOG });
add('current-date-asked-in-korean', () => withHistory(session()), { prompt: '오늘 날짜가 뭐야?', currentAgents: CATALOG });
add('current-time-asked-with-blocks', () => withHistory(session()), {
  prompt: [{ type: 'text', text: 'Look at this, and tell me tomorrow\'s plan.' }, IMAGE],
  currentAgents: CATALOG,
});
add('time-words-in-the-context-only', () => withHistory(session()), { prompt: 'Fix it.', context: 'It is today.', currentAgents: CATALOG });

add('deferred-delta', () => {
  const s = withHistory(
    session({
      deferredToolCatalog: [
        { name: 'mcp__alpha__list', mcpServerName: 'alpha', description: 'List things.' },
        { name: 'mcp__alpha__get', mcpServerName: 'alpha', description: 'Get a thing.' },
        { name: 'web_search', description: 'Search the web <b>now</b>   with   spaces.' },
        { name: 'mcp__beta__run', mcpServerName: 'beta', description: 'Run beta.' },
      ],
      deferredMcpToolNames: ['mcp__alpha__list', 'mcp__alpha__get'],
      mcpServerInstructions: { alpha: 'Alpha tools. They list and get things.' },
    })
  );
  delta.mergePendingDeferredToolDelta(s, {
    added: [
      { name: 'mcp__alpha__list', description: 'List things.' },
      { name: 'mcp__alpha__get', description: 'Get a thing.' },
      { name: 'web_search', description: 'Search the web <b>now</b>   with   spaces.' },
      { name: 'Zeta', description: 'x'.repeat(120) },
    ],
    removed: [{ name: 'mcp__beta__run', server: 'beta' }, 'old_tool', { name: 'mcp__gamma__a', server: 'gamma' }, 'mcp__gamma__b'],
  });
  return s;
}, { prompt: 'Continue.', currentAgents: CATALOG });

add('deferred-delta-removals-only', () => {
  const s = withHistory(session({ deferredMcpToolNames: ['mcp__alpha__list'] }));
  delta.mergePendingDeferredToolDelta(s, { removed: ['mcp__alpha__get', 'mcp__beta__run', 'mcp__beta__stop'] });
  return s;
}, { prompt: 'Continue.', currentAgents: CATALOG });

add('goal-slot-carries-the-compacted-todo-list', () =>
  withHistory(
    session({
      pendingGoalReminder: { version: 1, type: 'goal_state', revision: 2, reason: 'compaction' },
      goalReminderRevision: 2,
      todo: { phases: [{ name: 'Tasks', tasks: [{ content: 'Write it', status: 'in_progress' }, { content: 'Test it', status: 'pending' }] }], updatedAt: 1 },
    })
  ),
  { prompt: 'Continue.', currentAgents: CATALOG });

add('deferred-delta-before-the-goal-slot', () => {
  const s = withHistory(
    session({
      pendingGoalReminder: { version: 1, type: 'goal_state', revision: 3, reason: 'compaction' },
      goalReminderRevision: 3,
      todo: { phases: [{ name: 'Tasks', tasks: [{ content: 'Write it', status: 'in_progress' }] }], updatedAt: 1 },
    })
  );
  delta.mergePendingDeferredToolDelta(s, { added: [{ name: 'web_search', description: 'Search the web.' }] });
  return s;
}, { prompt: 'Continue.', currentAgents: CATALOG });

// Stored text attachments: a reference part reads its blob (`attachmentTextForPart`, `attachments/store.mjs:445`).
const attach = (text, extra = {}) => ({ type: 'text', ...attachments.storeAttachmentBuffer(Buffer.from(text)), ...extra });
const tampered = attach('what time is it, really');
writeFileSync(attachments.attachmentFilePath(tampered.attachmentRef), 'other bytes');
// Node keeps verified blobs in memory; the cases below are about what is on disk.
attachments.clearAttachmentBufferCache();
const ATTACHED = [
  ['a-pasted-text-asks-the-time', [{ type: 'text', text: 'See below.' }, attach('what time is it now')]],
  ['a-file-asks-the-date', [attach('Meeting notes: tomorrow at nine.', { textKind: 'file', filename: 'notes <a>"b\'.txt' })]],
  ['a-file-without-a-name', [attach('today?', { textKind: 'file' })]],
  ['an-attachment-says-nothing-temporal', [{ type: 'text', text: 'Review this.' }, attach('plain words only')]],
  ['an-image-and-an-attachment', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, attach('current date please')]],
  ['a-reference-with-a-bad-digest-is-plain-text', [{ type: 'text', text: 'tomorrow', attachmentRef: 'XYZ' }]],
  ['an-attachment-that-is-gone', [{ type: 'text', attachmentRef: 'ab'.repeat(32), sizeBytes: 5 }]],
  ['an-attachment-that-was-tampered-with', [{ type: 'text', text: 'Hi.' }, tampered]],
];
for (const [name, prompt] of ATTACHED) add(name, () => withHistory(session()), { prompt, currentAgents: CATALOG });

const agentSession = (extra = {}) =>
  withHistory(
    session({
      owner: 'agent',
      agent: 'worker-agent',
      tools: [{ name: 'read' }, { name: 'todo' }],
      ...extra,
    })
  );
add('todo-start-for-a-brief', () => agentSession(), { prompt: 'Do the three things.', currentAgents: undefined });
add('todo-start-not-for-an-injected-turn', () => agentSession(), {
  prompt: 'A task finished.',
  turnPromptSource: { source: 'task-notification' },
  currentAgents: undefined,
});
add('todo-start-not-with-an-open-list', () =>
  agentSession({ todo: { phases: [{ name: 'Tasks', tasks: [{ content: 'Open item', status: 'pending' }] }], updatedAt: 1 } }),
  { prompt: 'Do the three things.', currentAgents: undefined });
add('todo-start-not-without-the-todo-tool', () => agentSession({ tools: [{ name: 'read' }] }), { prompt: 'Do it.', currentAgents: undefined });
add('todo-start-not-for-a-hidden-agent', () => agentSession({ agent: 'explore-agent' }), { prompt: 'Do it.', currentAgents: undefined });
add('todo-start-not-for-a-lead', () => withHistory(session({ tools: [{ name: 'todo' }] })), { prompt: 'Do it.', currentAgents: CATALOG });

add('every-reminder-in-node-order', () => {
  const s = agentSession({
    workflowSwitch: { version: 1, revision: 2, from: { id: 'review', name: 'Review' }, to: { id: 'default', name: 'Default' } },
    orchestrationModeSwitch: { version: 1, revision: 3, from: 'focused', to: 'swarm' },
    pendingSetupNotice: { revision: 7, content: '<system-reminder>\n# Worktree Prepared\nDone.\n</system-reminder>' },
    pendingGoalReminder: { version: 1, type: 'goal_state', revision: 4, reason: 'compaction' },
    goalReminderRevision: 4,
    todo: { phases: [{ name: 'Done', tasks: [{ content: 'Closed', status: 'completed' }] }], updatedAt: 1 },
    deferredMcpToolNames: [],
  });
  s.owner = 'agent';
  promptUtils.refreshSessionWorkspaceContext(s, { cwd: '/work/new', environmentContext: '- Cwd: /work/new' });
  delta.mergePendingDeferredToolDelta(s, { added: [{ name: 'web_search', description: 'Search.' }] });
  s.promptSettings = promptSettings.promptSettingsRecord(SETTINGS);
  promptSettings.stagePromptSettingsNotice(s, { ...SETTINGS, coreMemory: '# Core Memory\nName: Sam\nLikes coffee.' });
  return s;
}, { prompt: 'what is the current time', currentAgents: [CATALOG[1]] });

// A session's own `updatedAt` stamp (a real `Date.now()` of this run) reads as the recorded instant.
const RUN_STARTED = RealDate.now() - 1;
function stampTime(session) {
  if (typeof session.updatedAt === 'number' && session.updatedAt >= RUN_STARTED) session.updatedAt = FIXED;
}

// Build the turn, then settle it as an accepted one (`commitAskTurn`).
async function record(item) {
  const input = item.make();
  stampTime(input);
  const live = clone(input);
  // What the store holds for each attachment the prompt names, as the Rust store answers it.
  const blobs = {};
  for (const part of Array.isArray(item.turn.prompt) ? item.turn.prompt : []) {
    if (!attachments.isAttachmentReference(part)) continue;
    try {
      blobs[part.attachmentRef] = { state: 'text', text: attachments.readAttachmentBuffer(part).toString('utf8') };
    } catch (error) {
      blobs[part.attachmentRef] = { state: error.code === 'ENOENT' ? 'missing' : 'invalid' };
    }
  }
  attachments.clearAttachmentBufferCache();
  let prepared;
  let failure = null;
  try {
    prepared = await prepare.buildUserTurn({
      session: live,
      prompt: clone(item.turn.prompt),
      context: item.turn.context,
      explicitPrefetch: null,
      turnSignal: new AbortController().signal,
      transcriptMeta: null,
      turnPromptSource: item.turn.turnPromptSource,
      effortConfiguration: null,
      currentAgents: clone(item.turn.currentAgents),
    });
  } catch (error) {
    failure = error.code ?? error.message;
  }
  if (failure) {
    return { name: item.name, session: input, turn: { prompt: item.turn.prompt, context: null, turnPromptSource: null, currentAgents: item.turn.currentAgents ?? null, modeInstructions: null }, blobs, error: failure };
  }
  const afterBuild = clone(live);
  // ask-turn-settle.mjs:148-164, in Node's order.
  if (prepared.deferredToolDelta) delta.acknowledgePendingDeferredToolDelta(live, prepared.deferredToolDelta.revision);
  if (prepared.goalReminder) goalReminder.acknowledgePendingGoalReminder(live, prepared.goalReminder.revision);
  if (prepared.workflowNotice) workflowNotice.acknowledgePendingWorkflowNotice(live, prepared.workflowNotice.revision);
  if (prepared.promptSettingsNotice) promptSettings.acknowledgePendingPromptSettingsNotice(live, prepared.promptSettingsNotice.revision);
  if (prepared.orchestrationModeNotice) modeNotice.acknowledgePendingOrchestrationModeNotice(live, prepared.orchestrationModeNotice.revision);
  if (prepared.workspaceNotice) promptUtils.acknowledgePendingWorkspaceNotice(live, prepared.workspaceNotice.revision);
  if (prepared.setupNotice) promptUtils.acknowledgePendingSetupNotice(live, prepared.setupNotice.revision);
  const revision = (notice) => notice?.revision ?? null;
  stampTime(afterBuild);
  stampTime(live);
  return {
    name: item.name,
    session: input,
    turn: {
      prompt: item.turn.prompt,
      context: item.turn.context ?? null,
      turnPromptSource: item.turn.turnPromptSource ?? null,
      currentAgents: item.turn.currentAgents ?? null,
      // What the host supplies a carried orchestration notice with (`orchestrationInstructions(mode)`).
      modeInstructions: input.orchestrationModeSwitch?.to ? orchestration.orchestrationInstructions(input.orchestrationModeSwitch.to) : null,
    },
    blobs,
    error: null,
    message: prepared.userTurnMessage,
    revisions: {
      deferred: revision(prepared.deferredToolDelta),
      goal: revision(prepared.goalReminder),
      workflow: revision(prepared.workflowNotice),
      settings: revision(prepared.promptSettingsNotice),
      orchestration: revision(prepared.orchestrationModeNotice),
      workspace: revision(prepared.workspaceNotice),
      setup: revision(prepared.setupNotice),
    },
    contents: {
      workflow: prepared.workflowNotice?.content ?? null,
      orchestration: prepared.orchestrationModeNotice?.content ?? null,
      agentListing: prepared.agentListingNotice ?? null,
      workspace: prepared.workspaceNotice?.content ?? null,
      deferred: prepared.deferredToolDelta?.content ?? null,
      goal: prepared.goalReminder?.content ?? null,
    },
    afterBuild,
    after: live,
  };
}

const cases = [];
for (const item of CASES) cases.push(await record(item));

// A retried failed turn (`retainedUserTurn`, `ask-turn-execute.mjs:38-69`): the failed message is resubmitted over the history
// before it; `withAgentListingNotice` (`agent-listing-notice.mjs:87`) adds what changed in the agent list. The message is a real
// `buildUserTurn` output (or a plain one), failed, then resent with the agents now enabled.
const SCOUT = agentEntry('scout', 'Scout', 'Looks around.');
const RETAINED = [];
async function retain(name, { build = null, message = null, now, blocks = false }) {
  const base = withHistory(session());
  build?.stage?.(base);
  let sent = message;
  if (build) {
    const live = clone(base);
    const prepared = await prepare.buildUserTurn({
      session: live,
      prompt: blocks ? [{ type: 'text', text: 'Fix it.' }, IMAGE] : 'Fix it.',
      context: undefined,
      explicitPrefetch: null,
      turnSignal: new AbortController().signal,
      transcriptMeta: { messageId: 'm9' },
      turnPromptSource: undefined,
      effortConfiguration: null,
      currentAgents: clone(build.told),
    });
    sent = prepared.userTurnMessage;
  }
  sent = clone(sent);
  sent.meta = { ...sent.meta, transcript: { messageId: 'm9', at: 1, completion: { status: 'failed', at: 2 } } };
  const stored = clone(base);
  stored.messages.push(sent);
  const index = stored.messages.length - 1;
  const resent = listing.withAgentListingNotice(stored, index, clone(sent), clone(now));
  stampTime(stored);
  RETAINED.push({
    name,
    session: stored,
    index,
    currentAgents: now ?? null,
    resent,
    settings: sent.meta.promptSettingsNoticeRevision || null,
  });
}
const stageSettings = (s) => {
  s.promptSettings = promptSettings.promptSettingsRecord(SETTINGS);
  promptSettings.stagePromptSettingsNotice(s, { ...SETTINGS, coreMemory: '# Core Memory\nName: Sam\nLikes coffee.' });
};
await retain('retry-with-the-same-agents-resends-the-message-as-it-is', { build: { told: [CATALOG[0]], stage: stageSettings }, now: [CATALOG[0]] });
await retain('retry-with-agents-changed-since-adds-the-list-reminder', { build: { told: [CATALOG[0]], stage: stageSettings }, now: [CATALOG[0], SCOUT] });
await retain('retry-with-blocks-and-agents-changed', { build: { told: [CATALOG[0]] }, now: [SCOUT], blocks: true });
await retain('retry-of-a-message-without-reminders', { message: { role: 'user', content: 'Fix it.' }, now: [CATALOG[0], SCOUT] });
await retain('retry-of-a-message-without-reminders-and-no-change', { message: { role: 'user', content: 'Fix it.' }, now: CATALOG });
await retain('retry-with-a-stale-runtime-context', { message: { role: 'user', content: 'Fix it. (edited)', meta: { agentListing: { added: [], removed: [{ id: 'reviewer', name: 'Reviewer' }] }, runtimeUserContext: { prefix: '', suffix: '\n\nold reminder' } } }, now: [CATALOG[0], SCOUT] });
await retain('retry-of-a-worker-gets-no-list', { build: { told: undefined }, now: undefined });

// buildCurrentTimeBlock in other zones (its offset is read from the zone's long-offset name). The renamed ones are the zones
// ICU prints under another name than the tz database (`Asia/Kolkata` reads `Asia/Calcutta`).
const CLOCK = [];
for (const zone of ['Asia/Seoul', 'UTC', 'America/New_York', 'Australia/Adelaide', 'America/St_Johns', 'Pacific/Auckland', 'Asia/Kolkata', 'Asia/Kathmandu', 'Europe/Kyiv', 'Etc/UTC', 'GMT', 'ROK', 'Asia/Ho_Chi_Minh', 'Asia/Yangon', 'Atlantic/Faroe', 'America/Argentina/Buenos_Aires', 'Pacific/Chuuk', 'Antarctica/Troll']) {
  process.env.TZ = zone;
  for (const prompt of ['what time is it', 'today', 'hello', 'Tomorrow?', '지금 몇 시야', 'yesterday at noon', 'the weekday of release', 'current   DATE', 'timeless']) {
    CLOCK.push({ zone, prompt, block: promptUtils.buildCurrentTimeBlock(prompt) });
  }
}
process.env.TZ = 'Asia/Seoul';

writeJson(join(stage, 'twin.json'), { now: NOW, ignored: ['messages', 'todo', 'todoCheck'], cases, retained: RETAINED, clock: CLOCK });
writeSetManifest(stage, {
  set: 'turn-reminders',
  recorder: 'benchmarks/rust-core/recorders/record-turn-reminders.mjs',
  command: 'node benchmarks/rust-core/recorders/record-turn-reminders.mjs --tree <tree>',
  identityTree: cli.get('identity-tree') ?? tree,
});
commitStage(stage, outDir);
rmSync(work, { recursive: true, force: true });
console.log(`turn-reminders: ${cases.length} cases, ${RETAINED.length} retries, ${CLOCK.length} clock rows -> ${outDir}`);
