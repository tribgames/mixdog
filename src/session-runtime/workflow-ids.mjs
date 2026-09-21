// Workflow/agent identity: the fixed agent slots, id normalisation and the
// agent-definition cache shared by the pack loaders under workflow/.
import { clean } from './session-text.mjs';
import { DEFAULT_DISABLED_AGENT_IDS } from '../runtime/shared/agent-route-config.mjs';

export const AGENT_DELETED_MARKER = '.deleted';
export const FIXED_AGENT_SLOTS = Object.freeze([
  // Short one-liners on purpose: these render inside the 260px sidebar rail.
  { id: 'maintainer', label: 'Maintainer', description: 'Memory and upkeep', workflowSlot: 'memory' },
]);
export const AGENT_ROLE_IDS = new Set(FIXED_AGENT_SLOTS.map((agent) => agent.id));
// Slot-backed built-ins run through dedicated maintenance channels, so they are never
// Lead-delegation targets and stay out of the Available Agents catalog.
export const BUILTIN_SLOT_AGENT_IDS = new Set(
  FIXED_AGENT_SLOTS.filter((agent) => agent.workflowSlot).map((agent) => agent.id)
);
export const STARTER_AGENT_ORDER = new Map(DEFAULT_DISABLED_AGENT_IDS.map((id, index) => [id, index]));
export const DEFAULT_WORKFLOW_ID = 'default';

// Loaded AGENT.md definitions, keyed `${dir}\n${agentId}`.
export const agentDefinitionCache = new Map();
const AGENT_DEFINITION_CACHE_LIMIT = 64;
export function setAgentDefinitionCache(key, value) {
  if (!agentDefinitionCache.has(key) && agentDefinitionCache.size >= AGENT_DEFINITION_CACHE_LIMIT) {
    const oldestKey = agentDefinitionCache.keys().next().value;
    agentDefinitionCache.delete(oldestKey);
  }
  agentDefinitionCache.set(key, value);
}

// Editor writes must invalidate the definition cache or a saved AGENT.md
// stays stale for the session lifetime.
export function clearAgentDefinitionCache(agentId = '') {
  if (!agentId) {
    agentDefinitionCache.clear();
    return;
  }
  for (const key of [...agentDefinitionCache.keys()]) {
    if (key.endsWith(`\n${agentId}`)) agentDefinitionCache.delete(key);
  }
}

export function normalizeAgentId(value) {
  const id = clean(value)
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (id === 'maint' || id === 'maintenance' || id === 'memory') return 'maintainer';
  return AGENT_ROLE_IDS.has(id) ? id : '';
}

export function normalizeWorkflowId(value, fallback = '') {
  const id = clean(value)
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return /^[a-z0-9][a-z0-9_.-]*$/.test(id) ? id : fallback;
}
