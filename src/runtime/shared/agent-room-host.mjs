// Runtime → desktop request channel for group rooms. Rooms run only in the
// desktop service hosted in this daemon (apps/desktop agent-rooms.ts): it
// registers a host here, and the `session` tool's sends to a room, and the
// relay turns of a member's own reported work, go through it.
//
// Deliberately dependency-free, like session-sidebar-host.mjs: the desktop
// service bundle imports this file too, and both copies share one registry
// through a global symbol.

const HOSTS_KEY = Symbol.for('mixdog.agentRoomHosts.v1');

function hosts() {
  globalThis[HOSTS_KEY] ??= [];
  return globalThis[HOSTS_KEY];
}

/**
 * Register a desktop room host:
 * - `member(roomSessionId, { to, prompt })` → `{ agentId, name, sessionId, text }`:
 *   the addressed member (by `to`, an agent id or display name, else a leading
 *   `@name` in `prompt`), its member session, and the message without that
 *   mention; throws when none resolves.
 * - `ask(roomSessionId, { agentId, prompt, from, id?, hop?, onSettled? })` →
 *   true: a message from another session (`from: { sessionId, agentId? }`)
 *   posted as its row and answered by that member alone; `onSettled(detail)`
 *   gets the member's turn end as a session turn's (`{ status, result?,
 *   error? }`).
 * - `relay(memberSessionId, prompt, { id?, hop? })` → `{ settled }`: the
 *   member's turn in its room relaying `prompt` (its reported work); `settled`
 *   resolves the turn's end status ('done' when it finished).
 * - `stop(roomSessionId)` → boolean: the room's stop button: the speaking
 *   member's turn is cancelled, queued calls settle cancelled, and no one else
 *   gets a turn; true when an exchange was running.
 * `hop`: the send's or report's place in a bot-to-bot chain (bot-hops.mjs);
 * the member's turn carries it, so the sends it makes count on from there.
 * `follow(submissionId)` (both): the turn that answers is submitted under
 * another id than `id` (one turn for several calls, or a fresh turn for one
 * cut short); the host awaits it before submitting, so the caller's durable
 * record follows that turn across a restart.
 * @returns {() => void} Unregister.
 */
export function registerAgentRoomHost(host) {
  const entry = { host };
  hosts().push(entry);
  return () => {
    const list = hosts();
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
  };
}

/** The active (most recently registered) desktop room host; throws when no
 *  desktop app is attached, since nothing else runs a room. */
export function agentRoomHost() {
  const active = hosts().at(-1);
  if (!active) throw new Error('group rooms run in the desktop app, and no desktop app is attached to this runtime');
  return active.host;
}
