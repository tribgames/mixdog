// Validator parity: every row of the Rust boundary validators' fixtures, and every input the TUI and the phone send
// (clients-accepted.json), is run through the TypeScript validator that guarded the same input in the desktop main
// process. Both must give the same verdict. Where the Rust validator is deliberately more open than the desktop call
// could be (a protocol client leaves an argument as `{}` or `null`, which a positional call could not), the row is
// listed in DIVERGENCES with its kind, and the test fails when a listed row stops diverging.
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { DESKTOP_CAPABILITIES } from '../shared/contract-capabilities.ts';
import { DIRECT_KEYS } from '../shared/desktop-api-split.ts';
import { ACTION_NAMESPACES } from '../../../../packages/protocol-client/src/actions/action-namespaces.mjs';
import { ACTION_OVERRIDES } from '../../../../packages/protocol-client/src/actions/action-overrides.mjs';
import { METHOD_ARGS } from '../../../../packages/protocol-client/src/actions/method-args.generated.mjs';
import {
  projectDisplayName,
  requiredAbortOptions,
  requiredDesktopCapabilityRequest,
  requiredFileSearchLimit,
  requiredLspDocumentInput,
  requiredLspRequestInput,
  requiredModelCatalogOptions,
  requiredModelSelection,
  requiredNewTaskDraft,
  requiredPromptContent,
  requiredSessionMessageCount,
  requiredSubmitOptions,
  requiredTextFileContent,
  requiredToolApprovalDecision,
  requiredTranscriptHistoryRequest,
  requiredTranscriptItemLimit,
  requiredWorkspaceFolders,
  requiredWorkspaceSearchOptions,
  requiredWorkspaceTextWrites,
  sessionDisplayName,
} from './ipc-validation.ts';

const FIXTURES = new URL(
  '../../../../native/core/crates/mixdog-app-protocol/src/boundary/validate/fixtures/',
  import.meta.url
);
const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(name, FIXTURES)), 'utf8'));

// ---- the capability call a protocol method resolves to (the inverse of resolveAction) ----------------------------------

const ACTION_OF_METHOD = new Map();
for (const [namespace, actions] of Object.entries(ACTION_NAMESPACES)) {
  for (const action of actions) ACTION_OF_METHOD.set(`${namespace}/${action}`, action);
}
for (const action of Object.keys(ACTION_OVERRIDES)) {
  for (const args of [[], [{}], ['s', 'r'], [{ action: 'set' }], [{ action: 'clear' }]]) {
    try {
      const { method } = ACTION_OVERRIDES[action](args, { threadId: 't' });
      if (!ACTION_OF_METHOD.has(method)) ACTION_OF_METHOD.set(method, action);
    } catch {
      // a probe argument list this builder does not take
    }
  }
}

const CAPABILITIES = new Set(DESKTOP_CAPABILITIES);

const trimTrailing = (args) => {
  while (args.length && args[args.length - 1] === undefined) args.pop();
  return args;
};

/** The capability request the desktop's IPC carried for `method` with `params`; `null` when no capability resolves to it. */
function capabilityRequest(method, params) {
  const capability = ACTION_OF_METHOD.get(method);
  // A session action the desktop served on a channel of its own (delete, quota resume, fast mode, ...) had no capability call.
  if (!capability || !CAPABILITIES.has(capability)) return null;
  let args;
  switch (method) {
    case 'thread/rewind':
      args = [params.itemId];
      break;
    case 'turn/retryFailed':
      args = [params.threadId, params.turnKey];
      break;
    case 'thread/goal/set':
      args = [params.goal];
      break;
    case 'thread/goal/clear':
      args = [{ action: 'clear' }];
      break;
    case 'thread/name/set':
      args = [params.threadId, params.title];
      break;
    default: {
      const spec = METHOD_ARGS[method];
      args = spec ? spec.args.map((name) => params[name]) : [];
    }
  }
  return { capability, sessionId: params.threadId, args: trimTrailing(args) };
}

// ---- the validators that are not capability calls -----------------------------------------------------------------------

const PROTOCOL_ONLY_SUBMIT_KEYS = new Set(['retryTurnId', 'retryAttemptId']);

/** The desktop's own option names: the protocol calls `id` `clientSubmissionId` and adds the retry ids. */
function submitOptionsOfProtocol(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options;
  return Object.fromEntries(
    Object.entries(options)
      .filter(([key]) => !PROTOCOL_ONLY_SUBMIT_KEYS.has(key))
      .map(([key, value]) => [key === 'clientSubmissionId' ? 'id' : key, value])
  );
}

const present = (value) => value !== undefined && value !== null;

function turnInput(input) {
  if (!input || typeof input !== 'object') return;
  requiredPromptContent(input.prompt);
  if (present(input.options)) requiredSubmitOptions(submitOptionsOfProtocol(input.options));
}

/** The LSP calls: the protocol names the project once at the top, the desktop's input carried it inside. */
function lspInput(params, input) {
  if (params.projectPath === undefined) return input;
  requiredLspDocumentInput({ kind: 'open', version: 0, relPath: 'a', languageId: 'l', projectPath: params.projectPath });
  return input && typeof input === 'object' && !Array.isArray(input) ? { projectPath: params.projectPath, ...input } : input;
}

/** One validator per method that is not a capability call: `(params) => void`, throwing a TypeError to refuse. */
const DIRECT = {
  'thread/start': (params) => {
    if (present(params.initialInput)) turnInput(params.initialInput);
    if (present(params.draft)) requiredNewTaskDraft(params.draft);
  },
  'turn/start': (params) => {
    if (present(params.input)) turnInput(params.input);
  },
  'turn/interrupt': (params) => {
    const options = {};
    for (const key of ['restorePrompt', 'submissionId']) if (present(params[key])) options[key] = params[key];
    requiredAbortOptions(options);
  },
  'route/set': (params) => {
    if (params.route !== undefined) requiredModelSelection(params.route);
  },
  'thread/continueInModel': (params) => DIRECT['route/set'](params),
  'thread/fork': (params) => {
    if (params.route !== undefined && params.route !== null) requiredModelSelection(params.route);
  },
  'model/list': (params) => {
    requiredModelCatalogOptions(params);
  },
  'thread/approval/answer': (params) => {
    if (params.result !== undefined) requiredToolApprovalDecision(params.result);
  },
  'project/update': (params) => {
    if (params.alias !== undefined) projectDisplayName(params.alias);
  },
  'thread/name/set': (params) => {
    if (params.title !== undefined) sessionDisplayName(params.title);
  },
  'thread/read': (params) => {
    if (params.window && typeof params.window === 'object') requiredTranscriptItemLimit(params.window.lastItems);
  },
  'thread/items/list': (params) => {
    if (present(params.limit) || present(params.byteBudget)) {
      requiredTranscriptHistoryRequest({
        before: 'hist_s_0_0',
        limit: present(params.limit) ? params.limit : 1,
        ...(present(params.byteBudget) ? { byteBudget: params.byteBudget } : {}),
      });
    }
  },
  'search/start': (params) => {
    if (present(params.limit)) requiredFileSearchLimit(params.limit);
  },
  'thread/readState/update': (params) => {
    if (params.messageCount !== undefined) requiredSessionMessageCount(params.messageCount);
  },
  'projectFs/writeText': (params) => {
    if (params.content !== undefined) requiredTextFileContent(params.content, 'file content');
    if (params.expectedContent !== undefined) requiredTextFileContent(params.expectedContent, 'expected file content');
  },
  'projectFs/writeTextBatch': (params) => {
    if (params.files !== undefined) requiredWorkspaceTextWrites(params.files);
  },
  'projectFs/searchText': (params) => {
    if (params.options !== undefined) requiredWorkspaceSearchOptions(params.options);
  },
  'projectFs/replaceText': (params) => DIRECT['projectFs/searchText'](params),
  'projectFs/workspaceFile/write': (params) => {
    if (params.folders !== undefined) requiredWorkspaceFolders(params.folders);
  },
  'lsp/document': (params) => {
    const input = lspInput(params, params.document);
    if (params.document !== undefined) requiredLspDocumentInput(input);
  },
  'lsp/request': (params) => {
    const input = lspInput(params, params.request);
    if (params.request !== undefined) requiredLspRequestInput(input);
  },
};

/** `null`: no desktop validator guarded the method. */
function typeScriptVerdict(method, rawParams) {
  const params = rawParams ?? {};
  let run;
  if (DIRECT[method]) {
    run = () => DIRECT[method](params);
  } else {
    const request = capabilityRequest(method, params);
    if (!request) return null;
    run = () => requiredDesktopCapabilityRequest(request);
  }
  try {
    run();
    return { ok: true };
  } catch (error) {
    assert.ok(error instanceof TypeError, `${method}: a validator refuses with a TypeError, not ${error?.name}: ${error?.message}`);
    return { ok: false, message: error.message };
  }
}

// ---- the divergences ----------------------------------------------------------------------------------------------------

/**
 * `file:method|case` -> kind. `open`: the fixture accepts what the desktop's call refused, because a protocol client has
 * no way to leave an argument out of a positional list (it sends `{}` or `null`, see clients-accepted.json) and the
 * owner's direction is that nothing a client sends today is refused. `wording`: both refuse; the desktop's argument-count
 * rule spoke before the argument's own rule, the protocol names the argument. A row the desktop accepted and the Rust
 * validator refuses is never listed.
 */
const DIVERGENCES = new Map();
function diverge(file, kind, rows) {
  for (const row of rows) DIVERGENCES.set(`${file}:${row}`, kind);
}

diverge('capability', 'open', [
  "thread/contextStatus|context status empty options",
  "thread/contextStatus|context status null options",
  "skills/skillsStatus|skills status empty options",
]);
diverge('capability_settings', 'wording', [
  "config/setAutoUpdate|absent",
  "config/setRecapEnabled|absent",
  "config/setAiSessionTitles|absent",
  "config/setCacheWarmingEnabled|absent",
  "config/setHeartbeatEnabled|absent",
  "config/setReactionsEnabled|absent",
  "config/setWebSearchEnabled|absent",
  "config/setMemoryToolsEnabled|absent",
  "voice/toggleVoice|absent",
  "mcp/setMcpServerEnabled|absent",
  "channel/setScheduleEnabled|absent",
  "channel/setWebhookEnabled|absent",
  "config/setHeartbeatInterval|absent",
  "instructions/setInstructionFiles|absent",
  "config/setDeveloperOption|id absent",
  "config/setNetworkProxy|patch absent",
  "media/createMediaBoard|name absent",
  "media/renameMediaBoard|id absent",
  "media/setMediaAssetBoard|ids absent",
  "media/setMediaAssetBoard|ids 10001",
  "media/setMediaAssetBoard|board absent",
  "localProvider/cancelLocalProviderInstallation|absent",
  "localProvider/setLocalProviderContext|tokens absent",
  "localProvider/getLocalProviderModelDetails|absent",
  "localProvider/startLocalProviderModelMaintenance|model first",
  "localProvider/deleteLocalProviderModel|absent",
  "account/authenticateProvider|absent",
  "account/saveProviderApiKey|no secret",
  "account/saveProviderApiKey|adc without secret field",
  "account/checkCustomProviderKeyEnv|absent",
  "account/removeCustomProvider|absent",
  "account/saveCustomProviderKey|id absent",
  "account/saveOpenAIUsageSessionKey|absent",
]);
diverge('capability_settings', 'open', [
  "media/setMediaAssetBoard|ids 10000",
]);
diverge('custom_provider', 'open', [
  "account/saveCustomProvider|empty input placeholder",
  "account/saveCustomProviderKey|key client provider id",
  "config/setModelPreferences|prefs placeholder object",
]);
diverge('custom_provider', 'wording', [
  "account/saveCustomProvider|modelWires proto id",
  "account/saveCustomProvider|override id __proto__",
  "account/saveCustomProvider|override id prototype",
  "config/setModelPreferences|prefs changes 5001",
]);
diverge('model', 'open', [
  "route/set|empty route (phone and desktop route/set)",
  "route/set|128 astral characters are 256 units",
  "model/list|providerId belongs to the typed decode",
  "thread/approval/answer|empty result",
  "route/set|contextPercent 5 (the runtime snaps it to a 10% step from 10 to 100, as the phone sent it)",
  "route/set|contextPercent 9 (the runtime snaps it to a 10% step from 10 to 100, as the phone sent it)",
  "route/set|contextPercent 15 (the runtime snaps it to a 10% step from 10 to 100, as the phone sent it)",
  "route/set|contextPercent 110 (the runtime snaps it to a 10% step from 10 to 100, as the phone sent it)",
  "route/set|contextPercent 0 (the runtime snaps it to a 10% step from 10 to 100, as the phone sent it)",
]);
diverge('model', 'wording', [
  "route/set|model null",
  "route/set|model too long",
]);
diverge('prompt', 'wording', [
  "turn/start|text null only",
]);
diverge('prompt', 'open', [
  "turn/start|stored text part",
  "turn/start|image stored by reference",
  "turn/start|file text type kept open",
  "turn/start|file stored by reference",
  "turn/start|options nulls",
]);
diverge('workspace_names', 'open', [
  "project/update|alias placeholder",
  "projectFs/writeTextBatch|placeholder",
  "projectFs/searchText|placeholder",
  "projectFs/replaceText|placeholder",
  "projectFs/workspaceFile/write|placeholder",
  "lsp/document|placeholder",
  "lsp/request|placeholder",
]);
diverge('worktree_import', 'open', [
  "project/inspectProjectBranch|empty object passes",
  "project/manageProjectBranch|empty object passes",
  "thread/selectBranch|empty object passes",
  "project/getProjectBranchMenu|empty object passes",
  "project/selectProjectBranch|empty object passes",
  "project/mergeProjectBranch|empty object passes",
  "thread/mergeWorkspace|empty object passes",
  "project/removeWorktree|null argument is no argument",
  "project/removeWorktree|options are not checked here",
  "config/setWorktreeSettings|empty object passes",
  "project/deleteWorktree|empty object passes",
  "project/pruneWorktrees|null argument is no argument",
  "project/previewWorktreeCleanup|null argument is no argument",
  "import/listImportableConversations|empty object passes",
  "import/getConversationImportJobs|null argument is no argument",
  "import/registerConversationImportFile|empty object passes",
  "import/startConversationImport|empty object passes",
  "import/cancelConversationImport|empty object passes",
]);
const FILES = ['capability', 'capability_settings', 'custom_provider', 'model', 'prompt', 'workspace_names', 'worktree_import'];

function expectedVerdict(row) {
  if (row.expected === null || row.expected === undefined) return { ok: true };
  return { ok: false, message: row.expected.expected ?? row.expected };
}

const same = (a, b) => a.ok === b.ok && a.message === b.message;

function divergenceOf(ts, rust) {
  if (!ts.ok && rust.ok) return 'open';
  if (!ts.ok && !rust.ok) return 'wording';
  return 'rust-narrower';
}

for (const file of FILES) {
  test(`${file}: every fixture row has the same verdict from the desktop's validator`, () => {
    const rows = fixture(`${file}.json`);
    assert.ok(rows.length > 0);
    const unexplained = [];
    const seen = new Set();
    let covered = 0;
    for (const row of rows) {
      const ts = typeScriptVerdict(row.method, row.params);
      if (ts === null) continue;
      covered += 1;
      const rust = expectedVerdict(row);
      if (same(ts, rust)) continue;
      const key = `${file}:${row.method}|${row.case}`;
      seen.add(key);
      const kind = divergenceOf(ts, rust);
      if (DIVERGENCES.get(key) !== kind) {
        unexplained.push(`${key} [${kind}] desktop=${JSON.stringify(ts)} fixture=${JSON.stringify(rust)}`);
      }
    }
    assert.ok(covered > 0, `${file}: no row reached a desktop validator`);
    assert.deepEqual(unexplained, []);
    const stale = [...DIVERGENCES.keys()].filter((key) => key.startsWith(`${file}:`) && !seen.has(key));
    assert.deepEqual(stale, [], 'a listed divergence no longer diverges: delete it');
  });
}

/** Client inputs the desktop's positional validators refused and the Rust validators accept (`open` divergences). */
const CLIENT_REFUSALS = new Set([
  "desktop lsp/document: LSP document kind is invalid.",
  "desktop lsp/request: LSP method must be a string.",
  "desktop project/update: alias must be a string.",
  "desktop projectFs/replaceText: search query must be a string.",
  "desktop projectFs/searchText: search query must be a string.",
  "desktop projectFs/workspaceFile/write: Workspace folders are invalid.",
  "desktop projectFs/writeTextBatch: Workspace edit files are invalid.",
  "desktop route/set: selection.provider must be a string.",
  "desktop thread/approval/answer: decision is invalid.",
  "desktop thread/backgroundTerminals/release: capability releaseShellJob received an invalid number of arguments.",
  "desktop turn/start: goal command is invalid.",
  "desktop turn/start: prompt text part is invalid.",
  "phone lsp/document: LSP document kind is invalid.",
  "phone lsp/request: LSP method must be a string.",
  "phone project/update: alias must be a string.",
  "phone projectFs/replaceText: search query must be a string.",
  "phone projectFs/searchText: search query must be a string.",
  "phone projectFs/workspaceFile/write: Workspace folders are invalid.",
  "phone projectFs/writeTextBatch: Workspace edit files are invalid.",
  "phone route/set: selection.provider must be a string.",
  "phone thread/approval/answer: decision is invalid.",
  "phone thread/backgroundTerminals/release: capability releaseShellJob received an invalid number of arguments.",
  "phone thread/clear: capability clear received an invalid number of arguments.",
  "phone thread/continueInModel: selection.contextPercent must be a 10-point percentage from 10 to 100.",
  "phone thread/fork: selection.contextPercent must be a 10-point percentage from 10 to 100.",
  "phone turn/start: file type is unsupported.",
  "protocol-client account/discoverCustomProviderModels: custom provider name must be a string.",
  "protocol-client account/saveCustomProvider: custom provider name must be a string.",
  "protocol-client account/testCustomProvider: custom provider name must be a string.",
  "protocol-client agent/saveAgentDefinition: capability saveAgentDefinition received an invalid number of arguments.",
  "protocol-client agent/setAgentConnectorEnabled: capability setAgentConnectorEnabled received an invalid number of arguments.",
  "protocol-client agent/setAgentConnectorToolPermission: capability setAgentConnectorToolPermission received an invalid number of arguments.",
  "protocol-client agent/setAgentConnectors: capability setAgentConnectors received an invalid number of arguments.",
  "protocol-client agent/setAgentPermission: capability setAgentPermission received an invalid number of arguments.",
  "protocol-client config/saveStarterGuideState: starter guide closed and welcomed must be booleans.",
  "protocol-client config/setModelPreferences: model preference changes are invalid.",
  "protocol-client config/setWorktreeSettings: worktree settings require at least one setting.",
  "protocol-client diagnostics/runDoctor: capability runDoctor received an invalid number of arguments.",
  "protocol-client import/cancelConversationImport: cancelConversationImport input.jobId must be a non-empty string.",
  "protocol-client import/listImportableConversations: listImportableConversations input.source must be codex, claude, or cowork.",
  "protocol-client import/registerConversationImportFile: registerConversationImportFile input.source must be codex, claude, or cowork.",
  "protocol-client import/startConversationImport: startConversationImport input.requestId must be a non-empty string.",
  "protocol-client mcp/reconnectMcp: capability reconnectMcp received an invalid number of arguments.",
  "protocol-client model/list: model catalog options are invalid.",
  "protocol-client project/deleteWorktree: deleteWorktree input.entryId must be a non-empty string.",
  "protocol-client project/getProjectBranchMenu: getProjectBranchMenu input.projectPath must be a non-empty path.",
  "protocol-client project/inspectProjectBranch: projectPath must be a non-empty path.",
  "protocol-client project/manageProjectBranch: projectPath must be a non-empty path.",
  "protocol-client project/mergeProjectBranch: mergeProjectBranch input.projectPath must be a non-empty path.",
  "protocol-client project/removeWorktree: capability removeWorktree received an invalid number of arguments.",
  "protocol-client project/selectProjectBranch: selectProjectBranch input.projectPath must be a non-empty path.",
  "protocol-client project/setProjectConnectorEnabled: capability setProjectConnectorEnabled received an invalid number of arguments.",
  "protocol-client skills/skillsStatus: projectPath must be a string.",
  "protocol-client thread/backgroundTerminals/release: capability releaseShellJob received an invalid number of arguments.",
  "protocol-client thread/cancelSide: capability cancelSide received an invalid number of arguments.",
  "protocol-client thread/contextStatus: context inspection requires inspect: true.",
  "protocol-client thread/mergeWorkspace: mergeWorkspace requires confirmed: true.",
  "protocol-client thread/reapplyTurnChanges: file must be a string.",
  "protocol-client thread/revertTurnChanges: file must be a string.",
  "protocol-client thread/selectBranch: selectBranch input.branch must be a non-empty string.",
  "protocol-client thread/setEffort: capability setEffort received an invalid number of arguments.",
  "protocol-client tools/toolsStatus: capability toolsStatus received an invalid number of arguments.",
  "tui thread/start: selection.contextPercent must be a 10-point percentage from 10 to 100.",
]);

test('clients-accepted: what the TUI and the phone send passes the desktop validators too', () => {
  const rows = fixture('clients-accepted.json');
  const refused = [];
  let checked = 0;
  for (const row of rows) {
    const ts = typeScriptVerdict(row.method, row.params);
    if (ts === null) continue;
    checked += 1;
    if (!ts.ok) refused.push(`${row.client} ${row.method}: ${ts.message}`);
  }
  assert.ok(checked > 300, `only ${checked} client rows reached a desktop validator`);
  assert.deepEqual(
    refused.filter((line) => !CLIENT_REFUSALS.has(line)),
    []
  );
  assert.deepEqual(
    [...CLIENT_REFUSALS].filter((line) => !refused.includes(line)),
    [],
    'a listed client refusal no longer happens: delete it'
  );
});

// ---- the coverage table: every validator a direct key's IPC handler called is answered by the core -------------------

const CRATES = new URL('../../../../native/core/crates/', import.meta.url);
const MAIN_DIRECTORY = fileURLToPath(new URL('./', import.meta.url));
const GROUPS = 'mixdog-app-protocol/src/boundary/validate/';
const CONFIG_SCHEMA = 'mixdog-core-config/src/config/schema.rs';
const SCM_INPUT = 'mixdog-scm/src/input.rs';

/**
 * Each validator the handlers of the renderer's direct API called, and the Rust check that answers for it: the file under
 * native/core/crates and a text the check carries (the test finds the text in the file, so a moved or deleted check fails).
 * A setting the desktop wrote through its own channel is written with `config/value/write`, whose schema table refuses
 * the value; a value that is a typed protocol param is answered by its decode.
 */
const COVERAGE = {
  optionalGithubLoginOptions: ['mixdog-scm/src/input_tests.rs', '"githubCliLoginOpenBrowser" => positional("github/login/openBrowser"'],
  optionalSessionId: [`${GROUPS}capability_settings.rs`, 'session id is invalid.'],
  projectDisplayName: [`${GROUPS}workspace_names.rs`, 'alias must be a string.'],
  requiredAbortOptions: [`${GROUPS}prompt.rs`, 'abort restorePrompt is invalid.'],
  requiredAgentMemoryEntry: ['mixdog-core-rooms/src/rooms/memory.rs', 'memory id is invalid.'],
  requiredBrowserPermissionPolicy: [CONFIG_SCHEMA, 'key("desktop.browserPermissions", Kind::BrowserPermissions'],
  requiredCommitHash: [SCM_INPUT, 'A commit hash is required.'],
  requiredConversationNotificationSetting: [CONFIG_SCHEMA, 'Kind::NotificationOverrides'],
  requiredDesktopCapabilityReadRequests: [`${GROUPS}capability.rs`, 'const CAPABILITIES'],
  requiredDesktopCapabilityRequest: [`${GROUPS}capability.rs`, 'const CAPABILITIES'],
  requiredDesktopSettingKey: [CONFIG_SCHEMA, 'key("desktop.computerInstalled"'],
  requiredDeviceAlias: ['mixdog-remote/src/access/settings.rs', 'pub fn set_device_alias'],
  requiredFileSearchLimit: [`${GROUPS}workspace_names.rs`, '"limit is invalid."'],
  requiredGitBranchName: [SCM_INPUT, 'git branch is invalid.'],
  requiredGitDiscardMode: [SCM_INPUT, 'git discard mode is invalid.'],
  requiredGitGlobalConfigKey: [SCM_INPUT, 'key must be user.name, user.email, or init.defaultBranch'],
  requiredGitIgnoreScope: [SCM_INPUT, 'Git ignore scope is invalid.'],
  requiredGitLogLimit: [SCM_INPUT, 'git history limit is invalid.'],
  requiredGitLogOffset: [SCM_INPUT, 'git history offset is invalid.'],
  requiredGitLogQuery: [SCM_INPUT, 'git history query is invalid.'],
  requiredGitOptionalMessage: [SCM_INPUT, 'git message is invalid.'],
  requiredGitPatch: [SCM_INPUT, 'git patch is invalid.'],
  requiredGitPath: [SCM_INPUT, 'git path is invalid.'],
  requiredGitPaths: [SCM_INPUT, 'git paths are invalid.'],
  requiredGitRequestContextInput: [SCM_INPUT, 'git request input is invalid.'],
  requiredGitResetMode: [SCM_INPUT, 'Git reset mode is invalid.'],
  requiredGitRevision: [SCM_INPUT, 'A git revision is required.'],
  requiredLspDocumentInput: [`${GROUPS}workspace_names.rs`, 'LSP document input is invalid.'],
  requiredLspRequestInput: [`${GROUPS}workspace_names.rs`, 'LSP request input is invalid.'],
  requiredModelCatalogOptions: [`${GROUPS}model.rs`, 'model catalog options are invalid.'],
  requiredModelSelection: [`${GROUPS}model.rs`, 'model selection is invalid.'],
  requiredNewTaskDraft: [`${GROUPS}prompt.rs`, 'new task draft is invalid.'],
  requiredNotificationDeviceId: [CONFIG_SCHEMA, 'Kind::NotificationDevices'],
  requiredNotificationPreferencesPatch: [CONFIG_SCHEMA, 'Kind::NotificationDevice =>'],
  requiredNotificationTarget: [CONFIG_SCHEMA, 'Kind::NotificationOverrides'],
  requiredNotificationVolume: [CONFIG_SCHEMA, 'Kind::IntRange(0, NOTIFICATION_VOLUME_MAX)'],
  requiredProjectRecoveryRequest: ['mixdog-workspace/src/recovery.rs', 'Invalid recovery ID.'],
  requiredPromptContent: [`${GROUPS}prompt.rs`, 'prompt is invalid.'],
  requiredRepositoryCwd: [SCM_INPUT, 'A project directory is required.'],
  requiredReviewDiffFiles: [SCM_INPUT, 'git review files are invalid.'],
  requiredReviewSource: [SCM_INPUT, 'Git review source is invalid.'],
  requiredSessionContentQuery: ['mixdog-services/src/memory/thread_search.rs', 'session search query is invalid.'],
  requiredSessionId: [`${GROUPS}capability_settings.rs`, 'session id is invalid.'],
  requiredSessionMessageCount: [`${GROUPS}workspace_names.rs`, 'session message count is invalid.'],
  requiredSessionRetentionSetting: [CONFIG_SCHEMA, 'Kind::IntChoice(SESSION_AUTO_ARCHIVE_DAY_CHOICES)'],
  requiredString: [`${GROUPS}workspace_names.rs`, 'fn required_string'],
  requiredSubmitOptions: [`${GROUPS}prompt.rs`, 'submit options are invalid.'],
  requiredTextFileContent: [`${GROUPS}workspace_names.rs`, 'fn text_file_content'],
  requiredTextFileEncoding: ['mixdog-workspace/src/fsops.rs', 'File encoding is invalid.'],
  requiredToolApprovalDecision: [`${GROUPS}model.rs`, 'decision is invalid.'],
  requiredTranscriptHistoryRequest: [`${GROUPS}workspace_names.rs`, 'transcript history request is invalid.'],
  requiredTranscriptItemLimit: [`${GROUPS}workspace_names.rs`, 'transcript item limit is invalid.'],
  requiredWorkspaceSearchOptions: [`${GROUPS}workspace_names.rs`, 'Workspace search options are invalid.'],
  requiredWorkspaceTextWrites: [`${GROUPS}workspace_names.rs`, 'Workspace edit files are invalid.'],
  sessionDisplayName: [`${GROUPS}workspace_names.rs`, 'title must be a string.'],
  validateGithubRequest: ['mixdog-scm/src/gh/contract.rs', 'A supported GitHub action is required.'],
};

const VALIDATOR_NAME = /^(required|optional|validate|normalize|sanitized|projectDisplayName|sessionDisplayName)/;

/** `DESKTOP_IPC` key -> the validators its handler calls by name, for every handler registered in main's ipc files. */
function validatorsOfHandlers() {
  const found = new Map();
  const files = fs
    .readdirSync(MAIN_DIRECTORY)
    .filter((name) => /^(ipc|vault|local-provider)[^.]*[.]ts$/.test(name) || name === 'ipc.ts');
  for (const name of files) {
    const path = `${MAIN_DIRECTORY}${name}`;
    const file = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true);
    const visit = (node) => {
      const channel = ts.isCallExpression(node) && node.arguments.length >= 2 ? node.arguments[0] : null;
      if (channel && ts.isPropertyAccessExpression(channel) && channel.expression.getText() === 'DESKTOP_IPC') {
        const calls = found.get(channel.name.text) ?? new Set();
        const walk = (inner) => {
          if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && VALIDATOR_NAME.test(inner.expression.text)) {
            calls.add(inner.expression.text);
          }
          ts.forEachChild(inner, walk);
        };
        node.arguments.slice(1).forEach(walk);
        found.set(channel.name.text, calls);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

test('coverage: every validator a direct key calls is answered by a rule of the core that still exists', () => {
  const handlers = validatorsOfHandlers();
  const unmapped = new Set();
  const used = new Set();
  let withValidators = 0;
  for (const key of Object.values(DIRECT_KEYS).flat()) {
    const validators = handlers.get(key);
    if (!validators?.size) continue;
    withValidators += 1;
    for (const name of validators) {
      used.add(name);
      if (!Object.hasOwn(COVERAGE, name)) unmapped.add(`${key}: ${name}`);
    }
  }
  assert.ok(withValidators > 60, `only ${withValidators} direct keys have a validating handler: the scan is broken`);
  assert.deepEqual([...unmapped], [], 'a validator with no rule in the core');
  assert.deepEqual(
    Object.keys(COVERAGE).filter((name) => !used.has(name)),
    [],
    'a covered validator no direct key calls any more: delete it'
  );
  for (const [name, [file, says]] of Object.entries(COVERAGE)) {
    const path = fileURLToPath(new URL(file, CRATES));
    assert.ok(fs.existsSync(path), `${name}: ${file} does not exist`);
    assert.ok(fs.readFileSync(path, 'utf8').includes(says), `${name}: ${file} no longer says ${JSON.stringify(says)}`);
  }
});
