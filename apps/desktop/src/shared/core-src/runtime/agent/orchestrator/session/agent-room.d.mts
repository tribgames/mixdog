export interface RoomMemberLabel {
  id: string;
  name: string;
}
export const ROOM_MIN_MEMBERS: number;
export const ROOM_MAX_MEMBERS: number;
export const ROOM_LIMITS: Readonly<
  Record<'maxRounds' | 'maxMessages', Readonly<{ min: number; max: number; default: number }>>
>;
export function roomSessionId(roomId: unknown): string;
export function roomIdOfSession(sessionId: unknown): string;
export function roomMemberSessionId(roomId: unknown, agentId: unknown): string;
export function roomMemberOfSession(sessionId: unknown): { roomId: string; agentId: string } | null;
export function parseRoomAsk(
  text: unknown,
  members?: readonly RoomMemberLabel[]
): { to: string[]; text: string; error?: 'member' | 'message' };
