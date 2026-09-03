// System prompt composition: BP1/BP2/BP3 layering and environment refresh.
import './_env.mjs';
import test from 'node:test';
import { composeSystemPrompt } from '../../src/runtime/agent/orchestrator/context/collect.mjs';
import { refreshSessionBp3Environment, resetSessionBp3Environment } from '../../src/runtime/agent/orchestrator/session/manager/prompt-utils.mjs';

test('role AGENT.md sections land in BP3 scoped role instructions', () => {
  const heavyPrompt = composeSystemPrompt({
    agent: 'heavy-worker',
    provider: 'anthropic-oauth',
    agentRules: '# Tool Use',
    skillManifest: '',
  });
  if (!heavyPrompt.sessionMarker.includes('## heavy-worker')) {
    throw new Error(`heavy-worker AGENT.md must be included in BP3 scoped role instructions: ${heavyPrompt.sessionMarker}`);
  }
  const workerPrompt = composeSystemPrompt({
    agent: 'worker',
    provider: 'anthropic-oauth',
    agentRules: '# Tool Use',
    skillManifest: '',
  });
  if (!workerPrompt.sessionMarker.includes('## worker')) {
    throw new Error(`worker AGENT.md must be included in BP3 scoped role instructions: ${workerPrompt.sessionMarker}`);
  }
});

test('BP layering keeps profile/skills in BP2 and ordered BP3 sections', () => {
  const layeredPrompt = composeSystemPrompt({
    skipRoleCatalog: true,
    agentRules: 'BP1_TOOL_POLICY',
    metaContext: 'BP2_PROFILE',
    skillManifest: 'BP2_SKILLS',
    deferredToolManifest: 'BP2_DEFERRED_MCP',
    workflowContext: 'BP3_WORKFLOW',
    roleRules: 'BP3_ROLE',
    userPrompt: 'BP3_SYSTEM',
    coreMemoryContext: 'BP3_MEMORY',
    languageContext: 'BP3_LANGUAGE',
    sessionStartContext: 'BP3_SESSION',
    projectInstructionsContext: 'BP3_PROJECT',
    environmentContext: 'BP3_ENVIRONMENT',
  });
  if (layeredPrompt.baseRules !== 'BP1_TOOL_POLICY') {
    throw new Error(`BP1 must contain only shared tool policy: ${layeredPrompt.baseRules}`);
  }
  if (!layeredPrompt.stableSystemContext.includes('BP2_PROFILE')
    || !layeredPrompt.stableSystemContext.includes('BP2_SKILLS')
    || !layeredPrompt.stableSystemContext.includes('BP2_DEFERRED_MCP')
    || /BP3_/.test(layeredPrompt.stableSystemContext)) {
    throw new Error(`BP2 must contain profile, skills, and deferred/MCP only: ${layeredPrompt.stableSystemContext}`);
  }
  const bp3Order = ['BP3_WORKFLOW', 'BP3_ROLE', 'BP3_SYSTEM', 'BP3_MEMORY', 'BP3_LANGUAGE', 'BP3_SESSION', 'BP3_PROJECT', 'BP3_ENVIRONMENT']
    .map((value) => layeredPrompt.sessionMarker.indexOf(value));
  if (bp3Order.some((index) => index < 0) || bp3Order.some((index, i) => i > 0 && index <= bp3Order[i - 1])) {
    throw new Error(`BP3 workflow/role and environment order is invalid: ${layeredPrompt.sessionMarker}`);
  }
  if (layeredPrompt.sessionMarkerCore.includes('BP3_SESSION')
    || layeredPrompt.sessionMarkerCore.includes('BP3_PROJECT')
    || layeredPrompt.sessionMarkerCore.includes('BP3_ENVIRONMENT')) {
    throw new Error(`BP3 core must exclude the refreshable session/project/environment suffix: ${layeredPrompt.sessionMarkerCore}`);
  }
  if (layeredPrompt.sessionEnvironment !== 'BP3_SESSION\n\n---\n\nBP3_PROJECT\n\n---\n\nBP3_ENVIRONMENT') {
    throw new Error(`session environment must carry exactly the refreshable suffix: ${layeredPrompt.sessionEnvironment}`);
  }
  if (/BP3_SESSION|BP3_PROJECT|BP3_ENVIRONMENT/.test(layeredPrompt.sessionEnvironment) === false
    || /BP3_WORKFLOW|BP3_ROLE|BP3_MEMORY/.test(layeredPrompt.sessionEnvironment)) {
    throw new Error(`session environment must exclude the stable BP3 core: ${layeredPrompt.sessionEnvironment}`);
  }
});

test('legacy BP3 environment refresh rewrites only the tier3 block', () => {
  const refreshableSession = {
    owner: 'cli',
    model: 'tool-contracts-model',
    effort: 'high',
    fast: true,
    workflow: { name: 'Solo' },
    bp3CoreContext: 'BP3_CORE',
    bp3EnvironmentContext: 'BP3_EXISTING_ENVIRONMENT',
    messages: [
      { role: 'system', content: 'BP1' },
      { role: 'system', content: 'BP2' },
      { role: 'system', content: 'BP3_CORE\n\n---\n\nBP3_EXISTING_ENVIRONMENT', cacheTier: 'tier3' },
    ],
  };
  const legacyBp3BeforeRefresh = refreshableSession.messages[2];
  if (!refreshSessionBp3Environment(refreshableSession, 'C:\\BP3_CURRENT_CWD')) {
    throw new Error('BP3 first-turn environment refresh must update the tier3 system block');
  }
  const refreshedBp3 = refreshableSession.messages[2].content;
  if (!/Cwd: C:\\BP3_CURRENT_CWD/.test(refreshedBp3)
    || refreshedBp3.indexOf('# Session') > refreshedBp3.indexOf('BP3_EXISTING_ENVIRONMENT')
    || refreshableSession.messages[2] === legacyBp3BeforeRefresh
    || refreshableSession.sessionStartMetaInjected !== true) {
    throw new Error(`BP3 first-turn environment refresh is invalid: ${refreshedBp3}`);
  }
  const legacyBp3BeforeReset = refreshableSession.messages[2];
  resetSessionBp3Environment(refreshableSession);
  if (refreshableSession.messages[2].content !== 'BP3_CORE\n\n---\n\nBP3_EXISTING_ENVIRONMENT'
    || refreshableSession.messages[2] === legacyBp3BeforeReset
    || refreshableSession.sessionStartMetaInjected !== false) {
    throw new Error(`BP3 clear reset must restore the refreshable suffix: ${refreshableSession.messages[2].content}`);
  }
});

test('split BP3 layout refreshes the env block and never the core block', () => {
  // Split layout (bp3EnvSplit): environment refresh targets the cacheTier:'env'
  // block and must NEVER rewrite the tier3 core block.
  const splitSession = {
    owner: 'cli',
    model: 'tool-contracts-model',
    effort: 'high',
    fast: true,
    workflow: { name: 'Solo' },
    bp3EnvSplit: true,
    bp3CoreContext: 'BP3_CORE',
    bp3EnvironmentContext: 'BP3_EXISTING_ENVIRONMENT',
    messages: [
      { role: 'system', content: 'BP1' },
      { role: 'system', content: 'BP2' },
      { role: 'system', content: 'BP3_CORE', cacheTier: 'tier3' },
      { role: 'system', content: 'BP3_EXISTING_ENVIRONMENT', cacheTier: 'env' },
    ],
  };
  const splitEnvBeforeRefresh = splitSession.messages[3];
  if (!refreshSessionBp3Environment(splitSession, 'C:\\BP3_CURRENT_CWD')) {
    throw new Error('split-session environment refresh must update the env system block');
  }
  if (splitSession.messages[2].content !== 'BP3_CORE') {
    throw new Error(`split-session refresh must never rewrite the tier3 core block: ${splitSession.messages[2].content}`);
  }
  const refreshedEnv = splitSession.messages[3].content;
  if (!/Cwd: C:\\BP3_CURRENT_CWD/.test(refreshedEnv)
    || refreshedEnv.indexOf('# Session') > refreshedEnv.indexOf('BP3_EXISTING_ENVIRONMENT')
    || splitSession.messages[3] === splitEnvBeforeRefresh
    || splitSession.sessionStartMetaInjected !== true) {
    throw new Error(`split-session environment refresh is invalid: ${refreshedEnv}`);
  }
  const splitEnvBeforeReset = splitSession.messages[3];
  resetSessionBp3Environment(splitSession);
  if (splitSession.messages[3].content !== 'BP3_EXISTING_ENVIRONMENT'
    || splitSession.messages[2].content !== 'BP3_CORE'
    || splitSession.messages[3] === splitEnvBeforeReset
    || splitSession.sessionStartMetaInjected !== false) {
    throw new Error(`split-session reset must restore only the env block: ${splitSession.messages[3].content}`);
  }
});
