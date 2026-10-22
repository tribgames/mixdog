// manager/agent-listing-notice.mjs
// The agents a coding Lead may delegate to, kept current without touching the
// request prefix (the workflow switch's pattern, workflow-switch-notice.mjs).
// What the conversation was told is read from the conversation itself, every
// turn: the "# Available Agents" list the system prompt carries (the one the
// session was built with: a rebuilt prompt keeps it, prompt-utils.mjs
// presentedAgentCatalogSlice), then each agent list reminder still in
// `session.messages`, in order (the user turn that carried one records its
// change as `meta.agentListing`). A turn whose message stays (answered or
// failed) counts; one rolled back or compacted away does not, so its change is
// told again. When the agents enabled at this turn's start (resolved by the
// session runtime, passed in with the turn) differ from that, the turn carries
// one reminder naming the agents added and removed.
import { agentListEntries, presentedAgentCatalogSlice } from './prompt-utils.mjs';

/** The agent list the system prompt carries: one complete generated slice of
 *  the BP3 block, [] when it carries none (or none valid). */
function promptAgentList(session) {
  return (session && agentListEntries(presentedAgentCatalogSlice(session) || '')) || [];
}

const ref = (entry) => ({ id: String(entry.id), name: String(entry.name) });

/** The agents the conversation was told about: the prompt's list, then every
 *  agent list reminder the conversation still holds, in order. */
export function announcedAgents(session) {
  const told = new Map(promptAgentList(session).map((entry) => [entry.id, ref(entry)]));
  for (const message of Array.isArray(session?.messages) ? session.messages : []) {
    const change = message?.role === 'user' ? message.meta?.agentListing : null;
    if (!change) continue;
    for (const entry of Array.isArray(change.removed) ? change.removed : []) told.delete(entry?.id);
    for (const entry of Array.isArray(change.added) ? change.added : []) {
      if (entry?.id) told.set(entry.id, ref(entry));
    }
  }
  return [...told.values()];
}

function agentListingContent(added, removed, current) {
  return [
    '<system-reminder>',
    '# Available Agents Changed',
    'This updates the Available Agents list in the system prompt and every earlier Available Agents Changed reminder.',
    ...(added.length
      ? ['New agents are now available to delegate to with `agent`:', ...added.map((entry) => entry.line)]
      : []),
    ...(removed.length
      ? [
          'These agents are no longer available; an `agent` call naming one is refused:',
          ...removed.map((entry) => `- ${entry.name} (${entry.id})`),
        ]
      : []),
    ...(current.length ? [] : ['No agents are enabled now: do the work yourself until one is enabled.']),
    '</system-reminder>',
  ].join('\n');
}

/**
 * The agent list reminder this user turn carries, or null when the
 * conversation already knows `current`, the agents enabled at this turn's
 * start (`agentListEntries` entries, from the session runtime's ask options;
 * absent for agent-mode threads and delegated workers: no reminder).
 * @returns {{ content: string, meta: { added: object[], removed: object[] } } | null}
 */
export function buildAgentListingNotice(session, current) {
  if (!Array.isArray(current)) return null;
  const announced = announcedAgents(session);
  const now = new Set(current.map((entry) => entry.id));
  const told = new Set(announced.map((entry) => entry.id));
  const added = current.filter((entry) => !told.has(entry.id));
  const removed = announced.filter((entry) => !now.has(entry.id));
  if (!added.length && !removed.length) return null;
  return {
    content: agentListingContent(added, removed, current),
    meta: { added: added.map(ref), removed: removed.map(ref) },
  };
}
