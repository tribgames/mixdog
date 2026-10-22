// manager/session-prompt-composition.mjs
// The system prompt a new session starts with: the BP1/BP2/BP3 rule blocks,
// the volatile environment block that closes them, and the seed messages that
// carry all four to the provider with their cache tiers.
import { buildSkillManifest, composeSystemPrompt } from '../../context/collect.mjs';
import { configuredInstructionFilesMode, loadInstructionFilesContext } from '../../context/instruction-files.mjs';
import { agentModeIdentityLine } from '../../context/role-instructions.mjs';
import { AGENT_MODE, sessionModeOf } from '../agent-mode.mjs';
import { MIXY_AGENT_ID } from '../agent-home.mjs';
import {
  _buildBaseRules,
  _buildAgentRules,
  _buildAgentModeRules,
  _buildLeadRules,
  _buildLeadMetaContext,
  _buildLeadLanguageContext,
} from './rules-cache.mjs';
import {
  describeCwdStartupEntries,
  describeGitStartupState,
  describeShellToolsStartupState,
} from '../../tools/builtin/runtime-capabilities.mjs';
import { captureOriginalUserCwd } from '../../../../shared/user-cwd.mjs';
import { delegationDisabled } from './session-tool-surface.mjs';
import { contextAckMessage } from '../compact/user-message-kind.mjs';

// Preserve the exact pre-layout environment payload: Lead carried the
// shell preference in Profile Preferences, while any routing surface with
// shell carried the startup capability line in BP1.
// opts.cwd is the session's explicit Project root. Raw callers that omit
// it still get a location line via captureOriginalUserCwd(), which
// resolves explicit session signals first and never leaks the daemon's
// install root (user-cwd.mjs safe fallback chain).
function buildShellEnvironmentContext(opts, ownerIsAgent, toolsForRouting) {
  const sessionCwdLine = opts.cwd || captureOriginalUserCwd();
  const wantsGitStartupLine = toolsForRouting.some((tool) => tool?.name === 'git');
  let cwdContextLine = '';
  if (sessionCwdLine) {
    cwdContextLine = ownerIsAgent
      ? `- Cwd: ${sessionCwdLine} — the active Project root; relative paths and shell commands resolve here.`
      : '- Relative paths and shell commands resolve in the active Project shown by Session Cwd.';
  }
  const startupScope = sessionCwdLine ? { cwd: sessionCwdLine } : {};
  const shellName = process.platform === 'win32' ? 'PowerShell' : 'Bash';
  return [
    cwdContextLine,
    `- Shell: ${shellName}. Use ${shellName} syntax unless the user specifies otherwise.`,
    // Which common tools the shell can run, measured where commands run
    // (login shell on POSIX, this process's PATH on Windows); see
    // runtime-capabilities.mjs. Recorded runs spent a round per session
    // guessing python vs python3 or calling `file` that was not there.
    // Rendered as a startup observation; an unknown answer renders nothing.
    describeShellToolsStartupState(),
    // Whether the cwd is inside a repository is a property of this
    // directory, true at startup and observable without spawning anything,
    // and the git tool cannot infer it. Without it a session spends a call
    // discovering `exited 128`, and repeats it per candidate path.
    wantsGitStartupLine ? describeGitStartupState(startupScope) : '',
    // Same startup-observation contract: the cwd's immediate entries are a
    // property of the directory, readable without spawning, and replace
    // the orientation `list`/`glob` that otherwise opens most sessions.
    sessionCwdLine ? describeCwdStartupEntries({ cwd: sessionCwdLine }) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Workspace-scoped prompt facts for an existing session re-rooted at `cwd`
 * (a Lead workspace change or a worker following its Lead): the shell/git/
 * listing environment and the instruction files of the new root, derived
 * exactly as at creation. `undefined` means "keep what the session has": a
 * tool-free role carries neither, a profile skipping instruction files keeps
 * none.
 * @returns {{ environmentContext: string|undefined, instructionFilesContext: string|undefined }}
 */
export function buildWorkspacePromptContext(session, cwd) {
  const ownerIsAgent = session?.owner === 'agent';
  const toolFreeRole =
    ownerIsAgent && Array.isArray(session?.schemaAllowedTools) && session.schemaAllowedTools.length === 0;
  if (toolFreeRole) return { environmentContext: undefined, instructionFilesContext: undefined };
  const tools = [
    ...(Array.isArray(session?.tools) ? session.tools : []),
    ...(Array.isArray(session?.deferredToolCatalog) ? session.deferredToolCatalog : []),
  ];
  return {
    environmentContext: buildShellEnvironmentContext({ cwd }, ownerIsAgent, tools),
    // Agent mode never carries project instruction files.
    instructionFilesContext:
      session?.skipInstructionFiles === true || sessionModeOf(session) === AGENT_MODE
        ? undefined
        : loadInstructionFilesContext({ mode: configuredInstructionFilesMode(), cwd }),
  };
}

// BP1/BP2/BP3 rule blocks plus the volatile environment, composed into the
// four system blocks; environmentTailContext is the persisted env tail.
// A Lead's BP3 rule slices, ordered for prefix sharing (composeSystemPrompt):
// LEAD.md's common lines first; then the mode block (coding: LEAD.md's two
// passages; agent mode: their conversational variants and AGENT_MODE.md);
// then Mixy's MIXY.md; last the per-session tail — identity.
// Agent mode is a Lead created as an agent (agent-mode.mjs).
export function sessionRolePromptFields(identity, { ownerIsAgent, toolFreeRole, delegationFree, sessionMode }) {
  const skipRules = identity.skipAgentRules || toolFreeRole;
  const lead = !ownerIsAgent && !skipRules;
  const agentMode = lead && sessionMode === AGENT_MODE;
  const mixy = (identity.agent || MIXY_AGENT_ID) === MIXY_AGENT_ID;
  let roleRules = '';
  if (!skipRules) {
    roleRules = ownerIsAgent
      ? _buildAgentRules(identity.agentRulesProfile)
      : _buildLeadRules({ includeLeadBrief: !delegationFree });
  }
  const identityLine = agentMode
    ? agentModeIdentityLine(identity.agent || MIXY_AGENT_ID)
    : lead
      ? _buildLeadRules({ includeLeadBrief: !delegationFree, part: 'identity' })
      : '';
  return {
    roleRules,
    ...(lead
      ? {
          leadModeRules: _buildLeadRules({ includeLeadBrief: !delegationFree, part: agentMode ? 'agent' : 'coding' }),
          identityContext: identityLine ? `# Identity\n\n${identityLine}` : '',
        }
      : {}),
    ...(agentMode
      ? {
          agentModeRules: _buildAgentModeRules({ part: 'conduct' }),
          ...(mixy ? { mixyRules: _buildAgentModeRules({ part: 'mixy' }) } : {}),
        }
      : {}),
    userPrompt: identity.systemPrompt,
    // A coding Lead carries no role section; an agent's home thread (a user
    // session running as that agent) carries its own AGENT.md role, and Mixy
    // in agent mode its optional agents/lead/AGENT.md.
    skipRoleCatalog: !ownerIsAgent && (!identity.agent || identity.agent === 'lead') && !(agentMode && mixy),
    // Mixy's persona (bots/mixy/PERSONA.md) is Mixy's alone: keyed on Mixy's
    // own agent-mode thread, never on the `lead` role a coding Lead shares.
    skipPersona: !ownerIsAgent && (!identity.agent || identity.agent === 'lead') && !(agentMode && mixy),
    agent: identity.agent,
    profile: { skip: identity.profileSkip },
  };
}

export function composeSessionSystem(opts, { profile, providerName, modelName, surface, sessionMode }) {
  const agentMode = sessionMode === AGENT_MODE;
  const { ownerIsAgent, resolvedAgent, skills } = surface;
  // A tool-free hidden role (a one-shot classifier or title writer) carries
  // only its own role rules: the shared tool policy and the worker conduct
  // rules describe work it is offered no tool for.
  const toolFreeRole = ownerIsAgent && surface.schemaAllowedTools?.length === 0;
  const skipAgentRules = opts.skipAgentRules === true || toolFreeRole;
  const injectedRules = skipAgentRules
    ? ''
    : _buildBaseRules({
        omitTools: surface.ruleOmitTools,
        allowTools: surface.schemaAllowedTools,
        provider: providerName,
        model: modelName,
      });
  const delegationFree = delegationDisabled({ ...opts, sessionMode }, ownerIsAgent);
  const promptIdentity = {
    systemPrompt: opts.systemPrompt || '',
    skipAgentRules: opts.skipAgentRules === true,
    profileSkip: { ...profile?.skip },
    agent: resolvedAgent,
    agentRulesProfile: surface.agentRulesProfile,
  };
  const roleFields = sessionRolePromptFields(promptIdentity, {
    ownerIsAgent,
    toolFreeRole,
    delegationFree,
    sessionMode,
  });
  const leadOnly = !skipAgentRules && !ownerIsAgent;
  const metaContext = leadOnly ? _buildLeadMetaContext({ includeOutputStyle: !agentMode }) : '';
  // Lead-only response language; closes the environment block so no English
  // system text (session/shell/git lines) follows it.
  const languageContext = leadOnly ? _buildLeadLanguageContext() : '';
  // Cwd, shell and repository facts only serve tool calls; a tool-free role
  // gets none, which also keeps its prompt identical across projects.
  const shellEnvironmentContext = toolFreeRole
    ? ''
    : buildShellEnvironmentContext(opts, ownerIsAgent, surface.toolsForRouting);
  // Persisted env tail: refreshSessionBp3Environment rebuilds the env block
  // as [session, bp3EnvironmentContext], so the language block must
  // already sit at the end of this string to stay last after a refresh.
  const environmentTailContext = [shellEnvironmentContext, languageContext].filter(Boolean).join('\n\n---\n\n');
  // User instruction files (AGENTS.md / CLAUDE.md, global then the project
  // root's); a tool-free role, a profile skipping `claudemd` and agent mode
  // get none.
  const instructionFilesContext =
    toolFreeRole || profile?.skip?.claudemd || agentMode
      ? ''
      : loadInstructionFilesContext({ mode: configuredInstructionFilesMode(), cwd: opts.cwd });
  const composed = composeSystemPrompt({
    ...roleFields,
    agentRules: injectedRules || undefined,
    metaContext: metaContext || undefined,
    languageContext: languageContext || undefined,
    workflowContext: opts.workflowContext || null,
    // The workflow's orchestration and agent-catalog slices (workflow/context.mjs leadPromptParts).
    ...(ownerIsAgent ? {} : opts.leadWorkflowParts),
    coreMemoryContext: opts.coreMemoryContext || null,
    instructionFilesContext: instructionFilesContext || null,
    skillManifest: buildSkillManifest(skills),
    environmentContext: shellEnvironmentContext,
    provider: providerName || null,
  });
  return { ...composed, environmentTailContext, promptIdentity };
}

// 4-BP layout (see composeSystemPrompt docs):
//   system block #1 = baseRules — BP1 (1h) shared tool policy
//   system block #2 = stableSystemContext — BP2 (1h) profile + skills +
//     deferred/MCP catalog
//   system block #3 = sessionMarkerCore — BP3 (1h) workflow/role + memory
//   system block #4 = sessionEnvironment — UNMARKED volatile session/
//     project environment (cacheTier:'env') closed by the response
//     language; covered by the messages-tail BP so an environment change
//     (e.g. a different Cwd) can never invalidate the BP3 core write.
//   later normal messages        = BP4/tail (task, role data, tool history)
// Anthropic multi-block system pins each marked block with cache_control
// (BP3 is the 3rd system block, tagged cacheTier:'tier3'; the env block
// stays unmarked). OpenAI/xAI get stable provider cache keys/session
// prefixes. Gemini manages explicit cachedContents inside its provider.
export function seedSessionMessages({ baseRules, stableSystemContext, sessionMarkerCore, sessionEnvironment }, files) {
  const messages = [];
  if (baseRules) {
    messages.push({ role: 'system', content: baseRules });
  }
  if (stableSystemContext) {
    messages.push({ role: 'system', content: stableSystemContext });
  }
  if (sessionMarkerCore) {
    // cacheTier:'tier3' tells the Anthropic providers to pin THIS system
    // block with the tier3 1h cache_control (BP3) — distinct from the
    // BP1/BP2 system TTL. Harmless on non-Anthropic providers (they ignore
    // the field and serialize content as a normal system instruction).
    messages.push({ role: 'system', content: sessionMarkerCore, cacheTier: 'tier3' });
  }
  if (sessionEnvironment) {
    // cacheTier:'env' → Anthropic providers leave this block UNMARKED so
    // the volatile environment rides the messages-tail breakpoint instead
    // of invalidating the stable BP3 core prefix.
    messages.push({ role: 'system', content: sessionEnvironment, cacheTier: 'env' });
  }
  if (files?.length) {
    const fileContext = files.map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');
    messages.push({ role: 'user', content: `Reference files:\n\n${fileContext}` });
    messages.push(contextAckMessage());
  }
  return messages;
}
