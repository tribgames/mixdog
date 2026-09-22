// manager/session-prompt-composition.mjs
// The system prompt a new session starts with: the BP1/BP2/BP3 rule blocks,
// the volatile environment block that closes them, and the seed messages that
// carry all four to the provider with their cache tiers.
import { buildSkillManifest, composeSystemPrompt } from '../../context/collect.mjs';
import {
  _buildBaseRules,
  _buildAgentRules,
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
  return [
    cwdContextLine,
    `- Shell: ${process.platform === 'win32' ? 'PowerShell' : 'Bash'}. Use ${process.platform === 'win32' ? 'PowerShell' : 'Bash'} syntax unless the user specifies otherwise.`,
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

// BP1/BP2/BP3 rule blocks plus the volatile environment, composed into the
// four system blocks; environmentTailContext is the persisted env tail.
export function composeSessionSystem(opts, { profile, providerName, modelName, surface }) {
  const { ownerIsAgent, resolvedAgent, skills } = surface;
  const skipAgentRules = opts.skipAgentRules === true;
  const injectedRules = skipAgentRules
    ? ''
    : _buildBaseRules({
        omitTools: surface.ruleOmitTools,
        allowTools: surface.schemaAllowedTools,
        provider: providerName,
        model: modelName,
      });
  const delegationFree = delegationDisabled(opts, ownerIsAgent);
  let roleRules = '';
  if (!skipAgentRules) {
    roleRules = ownerIsAgent
      ? _buildAgentRules(surface.agentRulesProfile)
      : _buildLeadRules({ includeLeadBrief: !delegationFree });
  }
  const leadOnly = !skipAgentRules && !ownerIsAgent;
  const metaContext = leadOnly ? _buildLeadMetaContext() : '';
  // Lead-only response language; closes the environment block so no English
  // system text (session/shell/git lines) follows it.
  const languageContext = leadOnly ? _buildLeadLanguageContext() : '';
  const shellEnvironmentContext = buildShellEnvironmentContext(opts, ownerIsAgent, surface.toolsForRouting);
  // Persisted env tail: refreshSessionBp3Environment rebuilds the env block
  // as [session, project, bp3EnvironmentContext], so the language block must
  // already sit at the end of this string to stay last after a refresh.
  const environmentTailContext = [shellEnvironmentContext, languageContext].filter(Boolean).join('\n\n---\n\n');
  const composed = composeSystemPrompt({
    userPrompt: opts.systemPrompt,
    agentRules: injectedRules || undefined,
    roleRules: roleRules || undefined,
    metaContext: metaContext || undefined,
    languageContext: languageContext || undefined,
    skipRoleCatalog: !ownerIsAgent,
    profile: profile || undefined,
    agent: resolvedAgent,
    workflowContext: opts.workflowContext || null,
    coreMemoryContext: opts.coreMemoryContext || null,
    skillManifest: buildSkillManifest(skills),
    environmentContext: shellEnvironmentContext,
    provider: providerName || null,
  });
  return { ...composed, environmentTailContext };
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
    messages.push({ role: 'assistant', content: '.' });
  }
  return messages;
}
