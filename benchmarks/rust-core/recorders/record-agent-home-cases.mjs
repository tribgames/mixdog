#!/usr/bin/env node
// Recording of session/agent-home.test.mjs (b6f10295a): the agent's home thread key (session/agent-home.mjs agentHomeSessionId,
// agentIdOfHomeSession, isAgentHomeSessionId), the session id pattern, the role prompt fields of a home thread
// (manager/session-prompt-composition.mjs sessionRolePromptFields) and the scratch decision (lifecycle/shared.mjs isScratchSession).
//
//   node benchmarks/rust-core/recorders/record-agent-home-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';

const set = openSet('agent-home-cases', import.meta.url);
const { MIXY_AGENT_ID, agentHomeSessionId, agentIdOfHomeSession, isAgentHomeSessionId } = await set.load('src/runtime/agent/orchestrator/session/agent-home.mjs');
const { SESSION_ID_PATTERN } = await set.load('src/runtime/agent/orchestrator/runtime-core/session-id.mjs');
const { isScratchSession } = await set.load('src/session-runtime/lifecycle/shared.mjs');
const { sessionRolePromptFields } = await set.load('src/runtime/agent/orchestrator/session/manager/session-prompt-composition.mjs');
const nul = (v) => (v === null ? { null: true } : v);

await set.run('the home key is a fixed, reversible session id per agent', () => ({
  mixyAgentId: MIXY_AGENT_ID, sessionIdPattern: SESSION_ID_PATTERN.source, sessionIdPatternFlags: SESSION_ID_PATTERN.flags,
  agents: ['github-watcher', 'a.b', 'reviewer2', MIXY_AGENT_ID].map((agentId) => { const sessionId = agentHomeSessionId(agentId); return { agentId, sessionId, again: agentHomeSessionId(agentId), matchesPattern: SESSION_ID_PATTERN.test(sessionId), agentIdOfHomeSession: agentIdOfHomeSession(sessionId), isHome: isAgentHomeSessionId(sessionId) }; }),
  distinct: { 'a.b': agentHomeSessionId('a.b'), 'a-b': agentHomeSessionId('a-b') }, lead: agentHomeSessionId('lead'),
}));
await set.run('non-agent ids and ordinary sessions are not home threads', () => ({
  agentIds: ['', 'Upper', '-lead', 'has space', 'a_b', null].map((agentId) => ({ agentId: nul(agentId), sessionId: agentHomeSessionId(agentId) })),
  sessionIds: ['sess_desktop_x', 'sess_home_', 'sess_home_Up', 'sess_home__x', 'sess_daemon_1'].map((sessionId) => ({ sessionId, isHome: isAgentHomeSessionId(sessionId), agentId: nul(agentIdOfHomeSession(sessionId)) })),
}));
await set.run("a home thread's prompt carries its agent's role; a Lead's does not", () => {
  const options = { ownerIsAgent: false, toolFreeRole: false, delegationFree: false };
  return { options, fields: ['github-watcher', 'lead', null].map((agent) => ({ agent: nul(agent), skipAgentRules: true, result: sessionRolePromptFields({ agent, skipAgentRules: true }, options) })) };
});
await set.run('a blank home thread is never scratch, so no close tombstones its fixed id', () => ({
  blankDesktop: { session: { id: 'sess_desktop_blank', messages: [] }, scratch: isScratchSession({ id: 'sess_desktop_blank', messages: [] }) },
  blankHome: { session: { id: agentHomeSessionId('github-watcher'), messages: [] }, scratch: isScratchSession({ id: agentHomeSessionId('github-watcher'), messages: [] }) },
}));

await set.finish({
  entry: { runs: 'session/agent-home.mjs, runtime-core/session-id.mjs SESSION_ID_PATTERN, manager/session-prompt-composition.mjs sessionRolePromptFields, session-runtime/lifecycle/shared.mjs isScratchSession', notRun: 'no session is created: pure functions on the recorded inputs' },
  replay: { entry: 'mixdog-core-agents home_agent: compare agentHomeSessionId / agentIdOfHomeSession / isAgentHomeSessionId for each recorded input; the session id pattern; the role prompt fields and the scratch decision in mixdog-core-session', normalised: {} },
});
process.exit(0);
