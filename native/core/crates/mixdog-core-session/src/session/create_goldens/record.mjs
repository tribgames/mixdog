// Records the create-time record fields of a user's Lead from the Node implementation into lead.json,
// which `session_options.rs` and `mixdog-core` `surface_host` compare the Rust port against.
//
//   node record.mjs <path-to-mixdog-node-checkout>   (a checkout with node_modules)
//
// `sessionOptions` (session-create/session-options.mjs) with no session profile gives the options of a
// Lead, `sessionOriginFields` and `buildSessionRecord` (session/manager/session-record.mjs) the record,
// `_ensureLifecycleFields` the save defaults, `agentProfileRevision` / `leadRosterRevision` the two stamps
// `createSession` adds. Machine and clock values are replaced: the pid by <pid>, times by <ts>.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'create-goldens-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';

const ROOT = process.argv[2];
if (!ROOT) throw new Error('usage: node record.mjs <path-to-mixdog-node-checkout>');
const load = (path) => import(pathToFileURL(join(ROOT, path)).href);

const { sessionOptions } = await load('src/session-runtime/session-create/session-options.mjs');
const { buildSessionRecord, sessionOriginFields } = await load('src/runtime/agent/orchestrator/session/manager/session-record.mjs');
const { _ensureLifecycleFields } = await load('src/runtime/agent/orchestrator/session/store/serialize.mjs');
const { resolveSessionToolSurface } = await load('src/runtime/agent/orchestrator/session/manager/session-tool-surface.mjs');
const { composeSessionSystem } = await load('src/runtime/agent/orchestrator/session/manager/session-prompt-composition.mjs');
const { agentProfileRevision, leadRosterRevision } = await load('src/runtime/agent/orchestrator/context/role-instructions.mjs');

// Two Lead catalogs: the recorded harness one is a coding Lead's agent catalog; contact catalog is agent mode's.
const parts = { agentCatalogContext: '# Available Agents\n\n- Worker (worker): Default implementation agent.', contactCatalogContext: '' };
const rt = {
  config: {},
  reservedSessionId: 'sess_fixture',
  route: { provider: 'custom-harness', model: 'harness-model' },
  mode: 'full',
  toolProfile: undefined,
  currentCwd: '/work',
  mcpScopeId: 'scope',
  sessionProfile: null,
  approvalMode: null,
  disallowDelegation: false,
  desktopSession: undefined,
};
const deps = {
  rt,
  cfgMod: { getPluginData: () => '/data' },
  activeWorkflowContext: () => ({
    summary: { id: 'default', name: 'Default', description: 'Handle tasks as requested.', source: 'built-in', delegatesAgents: true },
    leadPromptParts: () => parts,
    packContext: '',
    orchestrationMode: 'balanced',
  }),
  featureDisallowedTools: () => [],
};
const opts = { ...sessionOptions(deps, ''), sessionMode: 'coding' };
// The tool surface and the system prompt are the product's own, not stand-ins.
const surface = resolveSessionToolSurface({ ...opts, cwd: '/work', skipSkills: true }, { profile: null, toolPreset: 'full', modelName: 'harness-model' });
const prompt = composeSessionSystem(
  { owner: opts.owner, systemPrompt: '', workflow: { delegatesAgents: true }, workflowContext: '', orchestrationMode: 'balanced' },
  { profile: { skip: {} }, providerName: 'custom-harness', modelName: 'harness-model', surface: { ownerIsAgent: false, resolvedAgent: 'lead', skills: [], toolsForRouting: [], ruleOmitTools: [], schemaAllowedTools: null } }
);
const record = buildSessionRecord({
  opts,
  route: { providerName: 'custom-harness', modelName: 'harness-model', toolPreset: 'full', effort: null, fast: false, autoEffort: true, modelParameters: {}, contextPercent: null, contextTokens: null, id: 'sess_fixture' },
  presetObj: null,
  surface,
  prompt,
  messages: [],
  contextMeta: { contextWindow: 128000, rawContextWindow: 128000, effectiveContextWindowPercent: 100, autoCompactTokenLimit: null, compactBoundaryTokens: 128000 },
  origin: sessionOriginFields(opts, { profile: null, presetObj: null, providerCacheOpts: null, surface }),
});
_ensureLifecycleFields(record);
record.agentProfileRevision = agentProfileRevision(opts.agent, { mixy: false });
record.agentRosterRevision = leadRosterRevision(opts.leadWorkflowParts);

// The fields that are not the route's, the prompt's or the tool surface's (see the Rust `write_lead_record`).
const KEYS = [
  'agent', 'owner', 'lane', 'sourceName', 'sourceType', 'clientHostPid', 'mcpPid', 'scopeKey', 'desktopSession', 'taskType', 'agentTag',
  'permission', 'toolPermission', 'permissionMode', 'schemaAllowedTools', 'parentSessionId', 'ownerSessionId', 'visibility', 'profileId',
  'skipInstructionFiles', 'providerCacheOptsOverride', 'wireRoute', 'lastHeartbeatAt', 'lastUsedAt', 'totalInputTokens', 'totalOutputTokens',
  'totalToolCalls', 'tokensCumulative', 'generation', 'closed', 'agentProfileRevision', 'agentRosterRevision',
];
record.providerCacheOptsOverride = false; // createSession: Boolean(resolved.providerCacheOpts), none for a Lead
const volatile = { clientHostPid: '<pid>', mcpPid: '<pid>', lastUsedAt: '<ts>' };
const lead = Object.fromEntries(KEYS.map((key) => [key, key in volatile ? volatile[key] : record[key] ?? null]));
const out = { parts, record: lead };
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lead.json'), `${JSON.stringify(out, null, 2)}\n`);