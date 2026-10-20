import type { RoomRow, RoomScene, RoomTurnResult } from './agent-room.mjs';

export interface RoomSupervisorMember {
  id: string;
  name: string;
  /** One line about the member, when it has one. */
  description?: string;
}
/** One supervisor step's decision, with its reading of the talk. */
export type RoomDecision =
  | { action: 'speak'; agentId: string; scene: RoomScene; instruction?: string }
  | { action: 'finish'; scene: RoomScene };
/** What a supervisor step reads (all of it data, never instructions). */
export interface RoomSupervisorInput {
  roomName: string;
  members: RoomSupervisorMember[];
  rows: RoomRow[];
  /** This exchange's turns so far, in order. */
  turns: Array<{ id: string; result: RoomTurnResult }>;
  /** The user waits and no member has answered yet: the step must pick a member. */
  mustPick: boolean;
  /** The member that took the last turn ('' for none). */
  last: string;
  remaining: { messages: number; steps: number };
}
export function roomSupervisorRows(rows: unknown): RoomRow[];
export function roomSupervisorPrompt(input?: Partial<RoomSupervisorInput>): { system: string; user: string };
export function parseRoomDecision(
  reply: unknown,
  members?: readonly { id: string; name?: string }[]
): RoomDecision | null;
