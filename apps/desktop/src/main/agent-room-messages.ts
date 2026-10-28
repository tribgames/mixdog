// Group rooms, messages into a room (agent-rooms.ts): a user's message from
// any composer, a message another session addresses to one member, and a
// member relaying its own reported work. Each is posted as a row and handed
// to the scheduler.
import {
  type RoomRow,
  parseRoomAsk,
  roomIdOfSession,
  roomMemberNamed,
  roomMemberOfSession,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { AgentRoomHost } from '../../../../src/runtime/shared/agent-room-host.mjs';
import type { DesktopPromptContent, DesktopSubmitOptions } from '../shared/contract';
import { roomMemberSwitchedOffError } from '../shared/room-error-codes';
import type { createRoomLog } from './agent-room-log';
import type { createRoomRecords } from './agent-room-records';
import type { IntakeRequest, RoomScheduler } from './agent-room-scheduler';
import type { MemberLabel, RoomCall } from './agent-room-turn';
import type { AgentRoomDeps } from './agent-rooms';

type RoomRecords = ReturnType<typeof createRoomRecords>;

const SUBMISSION_IDS = 64;

function promptText(prompt: DesktopPromptContent): string {
  if (typeof prompt === 'string') return prompt.trim();
  return prompt
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** The files a user message carries up with its row: image and file parts,
 *  and the pasted / attached texts its tokens name; null when it has none. */
function roomUpload(
  prompt: DesktopPromptContent,
  pasted: Pick<DesktopSubmitOptions, 'pastedImages' | 'pastedTexts'>
): NonNullable<RoomRow['upload']> | null {
  const parts = typeof prompt === 'string' ? [] : prompt.filter((part) => part.type !== 'text');
  const pastedImages = Object.keys(pasted.pastedImages ?? {}).length ? pasted.pastedImages : undefined;
  const pastedTexts = Object.keys(pasted.pastedTexts ?? {}).length ? pasted.pastedTexts : undefined;
  const hasUpload = parts.length || pastedImages || pastedTexts;
  return hasUpload ? { parts, ...(pastedImages && { pastedImages }), ...(pastedTexts && { pastedTexts }) } : null;
}

/** What room messages read from the host. */
export interface RoomMessagesHost {
  deps: Pick<AgentRoomDeps, 'republishCatalog'>;
  ready(): Promise<void>;
  roomOf: RoomRecords['roomOf'];
  memberLabels: RoomRecords['memberLabels'];
  names: RoomRecords['names'];
  persist: RoomRecords['persist'];
  post: ReturnType<typeof createRoomLog>['post'];
  memberSession(roomId: string, member: { id: string; route: unknown }): Promise<string>;
  scheduler: Pick<RoomScheduler, 'intake' | 'route' | 'relayWhenIdle'>;
  now(): number;
  newId(): string;
}

async function acceptSend(
  host: RoomMessagesHost,
  request: IntakeRequest,
  sessionId: string,
  prompt: DesktopPromptContent,
  submissionId: string,
  pasted: Pick<DesktopSubmitOptions, 'pastedImages' | 'pastedTexts'>
): Promise<boolean> {
  const { deps, ready, roomOf, memberLabels, persist, post, scheduler, now, newId } = host;
  await ready();
  const roomId = roomIdOfSession(sessionId);
  const room = roomOf(roomId);
  // A retried submission (phone after a lost reply) that was durably
  // accepted before — this process or an earlier one — is acknowledged once.
  if (submissionId && room.submissions?.includes(submissionId)) return true;
  const labels = await memberLabels(room);
  // Names resolve against every member first, so a switched-off "Bench lead"
  // is never mistaken for "Bench"; a switched-off target is then refused.
  const parsed = parseRoomAsk(promptText(prompt), [...labels.values()]);
  if (parsed.error === 'member') throw new Error('No member of this room has that name.');
  const off = parsed.to.find((id) => labels.get(id)?.disabled);
  if (off) throw roomMemberSwitchedOffError(labels.get(off)?.name ?? off);
  // The files go up with the row: the log's intake stores them as a chat
  // prompt's are (agent-room-delivery.mjs), and the members the message
  // reaches get them on their next turn.
  const upload = roomUpload(prompt, pasted);
  if (!parsed.text && !upload) throw new Error('Write a message to send.');
  const row: RoomRow = {
    // The submission id is the row's id, so the sender's pending bubble
    // (released by id) gives way to this row instead of standing under it.
    id: /^[A-Za-z0-9_-]{1,100}$/.test(submissionId) ? submissionId : `user_${newId()}`,
    kind: 'user',
    at: now(),
    text: parsed.text,
    ...(parsed.to.length ? { to: parsed.to, toName: parsed.to.map((id) => labels.get(id)?.name ?? id) } : {}),
    ...(upload ? { upload } : {}),
  };
  await post(roomId, [row]);
  Object.assign(room, { lastSpeaker: 'user', lastAt: row.at });
  // Recorded only once the row is in the log, and saved with the room
  // before the submission is acknowledged.
  if (submissionId) room.submissions = [...(room.submissions ?? []), submissionId].slice(-SUBMISSION_IDS);
  // Taken up as soon as the row is in the log, before the save yields: a
  // member's older answer cannot land meanwhile, and a second message never
  // starts an exchange of its own beside this one.
  // `/ask` names its recipients; a message without it addresses the whole room.
  if (!request.stopped) scheduler.route(roomId, { to: parsed.to, everyone: !parsed.to.length, waiting: true });
  request.release();
  await persist();
  deps.republishCatalog();
  return true;
}

/** The member a message from another session addresses (room host
 *  `member`, agent-room-host.mjs): `to` (an agent id or display name), else
 *  a leading `@name` in `prompt`; its member session exists afterwards. */
async function addressee(
  host: RoomMessagesHost,
  sessionId: string,
  { to, prompt }: { to?: unknown; prompt?: unknown }
): Promise<{ agentId: string; name: string; sessionId: string; text: string }> {
  const { ready, roomOf, memberLabels } = host;
  await ready();
  const roomId = roomIdOfSession(sessionId);
  const room = roomOf(roomId);
  const labels = await memberLabels(room);
  const members = [...labels.values()];
  const named = typeof to === 'string' ? to.trim() : '';
  const asked = typeof prompt === 'string' ? prompt.trim() : '';
  // `to`, else a leading `@name`, resolved against `list`.
  const resolveIn = (list: MemberLabel[]) => {
    let id = roomMemberNamed(named, list);
    let body = asked;
    if (!named && asked.startsWith('@')) {
      const parsed = parseRoomAsk(`/ask ${asked.slice(1)}`, list);
      if (parsed.to.length === 1 && parsed.text) [id, body] = [parsed.to[0], parsed.text];
    }
    return { id, body };
  };
  const { id: agentId, body: text } = resolveIn(members);
  const roster = members.map((member) => `${member.name} (${member.id})`).join(', ');
  if (agentId && labels.get(agentId)?.disabled) {
    throw new Error(`"${labels.get(agentId)?.name ?? agentId}" in room "${room.name}" is switched off.`);
  }
  if (!agentId) {
    throw new Error(
      named
        ? `"${named}" is not a member of room "${room.name}"; its members are ${roster}.`
        : `A message to room "${room.name}" must name the member it is for (to: agent id or name); its members are ${roster}.`
    );
  }
  const member = labels.get(agentId) as MemberLabel;
  return { agentId, name: member.name, sessionId: await host.memberSession(roomId, member), text };
}

/** A message from another session (`from`) into the room, for member
 *  `agentId` alone: posted as a user-kind row naming its real sender, then
 *  routed like a user message to that member, and no other member follows
 *  up. `id` / `onSettled`: the member's turn's submission id and end. */
async function acceptAsk(
  host: RoomMessagesHost,
  request: IntakeRequest,
  sessionId: string,
  { agentId, prompt, from, id = '', hop = 0, onSettled, follow }: Parameters<AgentRoomHost['ask']>[1]
): Promise<boolean> {
  const { deps, ready, roomOf, memberLabels, names, persist, post, scheduler, now, newId } = host;
  await ready();
  const roomId = roomIdOfSession(sessionId);
  const room = roomOf(roomId);
  if (!room.members.includes(agentId)) throw new Error(`"${agentId}" is not a member of room "${room.name}".`);
  const labels = await memberLabels(room);
  if (labels.get(agentId)?.disabled) throw new Error(`"${labels.get(agentId)?.name ?? agentId}" is switched off.`);
  const content = prompt as DesktopPromptContent;
  const upload = roomUpload(content, {});
  const text = promptText(content);
  if (!text && !upload) throw new Error('Write a message to send.');
  const fromAgent = from.agentId || '';
  const fromName = fromAgent ? (names.get(fromAgent) ?? fromAgent) : 'Lead';
  const row: RoomRow = {
    id: `ask_${newId()}`,
    kind: 'user',
    at: now(),
    text,
    to: [agentId],
    toName: [labels.get(agentId)?.name ?? agentId],
    fromSession: from.sessionId,
    ...(fromAgent ? { fromAgent } : {}),
    fromName,
    ...(upload ? { upload } : {}),
  };
  await post(roomId, [row]);
  room.lastAt = row.at;
  const call: RoomCall = {
    agentId,
    askedBy: fromName,
    ...(id ? { id } : {}),
    ...(hop > 0 ? { hop } : {}),
    ...(onSettled ? { onSettled } : {}),
    ...(follow ? { follow } : {}),
  };
  if (request.stopped) onSettled?.({ status: 'cancelled' });
  else scheduler.route(roomId, { to: [agentId], everyone: false, waiting: true, only: true, calls: [call] });
  request.release();
  await persist();
  deps.republishCatalog();
  return true;
}

/** Member session `sessionId` relays its own reported work (`prompt`, the
 *  agent-home-delivery wake prompt) in one turn in its room, once the room
 *  is idle; `settled` resolves that turn's end status ('done' when it
 *  finished). */
async function relay(
  host: RoomMessagesHost,
  sessionId: string,
  prompt: string,
  { id = '', hop = 0, follow }: NonNullable<Parameters<AgentRoomHost['relay']>[2]> = {}
) {
  const { ready, roomOf, scheduler } = host;
  await ready();
  const member = roomMemberOfSession(sessionId);
  if (!member) throw new TypeError('Not a group-room member session.');
  const room = roomOf(member.roomId);
  if (!room.members.includes(member.agentId)) throw new Error('That agent is no longer a member of the room.');
  let settle: (status: string) => void = () => undefined;
  const settled = new Promise<string>((resolve) => {
    settle = resolve;
  });
  const call: RoomCall = {
    agentId: member.agentId,
    relay: prompt,
    ...(id ? { id } : {}),
    ...(hop > 0 ? { hop } : {}),
    ...(follow ? { follow } : {}),
    onSettled: (detail) => settle(detail.status),
  };
  // A relay never cuts a member off: while the room talks it waits in the
  // room's queue, which the exchange's end drains.
  scheduler.relayWhenIdle(member.roomId, call);
  return { settled };
}

export function createRoomMessages(host: RoomMessagesHost) {
  const { scheduler } = host;
  return {
    /** A message the user sent into the room (any surface's composer), with the
     *  files it carries: image and file parts, and the pasted / attached texts
     *  its tokens name (`pasted`, the submit options' side tables). */
    send: (
      sessionId: string,
      prompt: DesktopPromptContent,
      submissionId = '',
      pasted: Pick<DesktopSubmitOptions, 'pastedImages' | 'pastedTexts'> = {}
    ): Promise<boolean> =>
      scheduler.intake(roomIdOfSession(sessionId), (request) =>
        acceptSend(host, request, sessionId, prompt, submissionId, pasted)
      ),
    addressee: (sessionId: string, options: { to?: unknown; prompt?: unknown }) => addressee(host, sessionId, options),
    ask: (sessionId: string, options: Parameters<AgentRoomHost['ask']>[1]): Promise<boolean> =>
      scheduler.intake(roomIdOfSession(sessionId), (request) => acceptAsk(host, request, sessionId, options)),
    relay: (sessionId: string, prompt: string, options?: NonNullable<Parameters<AgentRoomHost['relay']>[2]>) =>
      relay(host, sessionId, prompt, options),
  };
}
