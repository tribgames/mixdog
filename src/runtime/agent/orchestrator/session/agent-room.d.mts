export type RoomRowKind = 'user' | 'speech' | 'pass' | 'cap' | 'stopped' | 'interrupted';
export interface RoomRow {
  id: string;
  kind: RoomRowKind;
  at?: number;
  speaker?: string;
  name?: string;
  /** The members the row addresses, in order (older rows: one id). */
  to?: string[] | string;
  toName?: string[] | string;
  failed?: boolean;
  /** A user-kind row another session sent: its session, the sending bot
   *  (none for the user's Lead) and the name it is shown under. */
  fromSession?: string;
  fromAgent?: string;
  fromName?: string;
  limit?: 'rounds' | 'messages';
  rounds?: number;
  messages?: number;
  tools?: Array<{ name: string; summary: string }>;
  /** A user row's files as stored references: what its recipients are handed. */
  parts?: RoomFilePart[];
  /** A user row's attachment records (`meta.transcript.attachments` shape). */
  attachments?: Array<{
    id: string;
    attachmentRef: string;
    kind: string;
    name: string;
    mimeType: string;
    size: number;
  }>;
  /** A user row's image chips, as a chat prompt's row carries them. */
  images?: Array<{ id: number | string | null; name: string; mimeType: string; bytes: number; attachmentRef?: string }>;
  /** Host → log only: a user row's files as the composer sent them, which the
   *  log's intake stores (agent-room-delivery.mjs) and replaces with the above. */
  upload?: { parts: unknown[]; pastedImages?: Record<string, unknown>; pastedTexts?: Record<string, unknown> };
  /** Host → log only: a speech row's member session and the start of the
   *  turn that spoke; the log's intake stores the files that turn produced
   *  (agent-room-delivery.mjs) as the row's `parts` / `attachments`. */
  artifactsFrom?: { sessionId: string; since: number };
  /** rowsSinceCursor only: the member's session was already handed this row
   *  (shown again as context, never as new). */
  seen?: boolean;
  text: string;
}
/** A stored file reference (attachments/store.mjs): an image, a file, or an
 *  attached / pasted text. */
export interface RoomFilePart {
  type: 'image' | 'file' | 'text';
  attachmentRef: string;
  textKind?: 'paste' | 'file';
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
}
export type RoomPromptPart = { type: 'text'; text: string } | RoomFilePart;
export interface RoomConfig {
  name: string;
  members: string[];
  maxRounds: number;
  maxMessages: number;
  shareTools: boolean;
}
export interface RoomMemberLabel {
  id: string;
  name: string;
}
export type RoomTurnResult = 'speech' | 'pass' | 'stopped' | 'superseded';
/** A turn's answer; a speech may name the one peer it addressed. */
export type RoomTurnAnswer = RoomTurnResult | { result: RoomTurnResult; mention?: string };
export interface RoomExchangeResult {
  outcome: 'done' | 'capped' | 'stopped' | 'superseded';
  limit?: 'rounds' | 'messages';
  rounds: number;
  /** Supervisor steps taken. */
  steps: number;
  messages: number;
  /** A user-addressed set cut by the message cap: the members still to answer. */
  remaining?: string[];
}
export const ROOM_MIN_MEMBERS: number;
export const ROOM_MAX_MEMBERS: number;
export const ROOM_LIMITS: Readonly<
  Record<'maxRounds' | 'maxMessages', Readonly<{ min: number; max: number; default: number }>>
>;
export const ROOM_INSTRUCTION_LIMIT: number;
export const ROOM_ROW_SOURCE: string;
export function roomSessionId(roomId: unknown): string;
export function roomIdOfSession(sessionId: unknown): string;
export function roomMemberSessionId(roomId: unknown, agentId: unknown): string;
export function roomMemberOfSession(sessionId: unknown): { roomId: string; agentId: string } | null;
export function isRoomThreadSessionId(sessionId: unknown): boolean;
export function normalizeRoomConfig(value?: Partial<RoomConfig> & Record<string, unknown>): RoomConfig;
export function parseRoomAsk(
  text: unknown,
  members?: readonly RoomMemberLabel[]
): { to: string[]; text: string; error?: 'member' | 'message' };
export function roomMemberNamed(value: unknown, members?: readonly RoomMemberLabel[]): string;
export function roomMentionOf(text: unknown, members?: readonly RoomMemberLabel[], selfId?: string): string;
export function roomRowTargets(row?: Partial<RoomRow>): RoomMemberLabel[];
export function isPassReply(text: unknown): boolean;
export function withoutPassMarker(text: unknown): string;
export function roomUserWaiting(rows?: readonly Partial<RoomRow>[]): boolean;
export function roomMessageBudget(memberCount: number, maxMessages: number, random?: () => number): number;
/** One turn as runRoomExchange hands it to `speak`. */
export interface RoomTurn {
  /** The members the user addressed, on their own turns; [] otherwise. */
  addressed: string[];
  /** The supervisor's note on what is wanted ('' for none). */
  instruction: string;
  /** The peer whose @mention this turn follows ('' for none). */
  mentionedBy: string;
  /** The supervisor's newest reading of the talk ('work' until it names one). */
  scene: RoomScene;
}
/** Casual small talk or work, as a supervisor step judges the room. */
export type RoomScene = 'casual' | 'work';
/** What one supervisor step is told. */
export interface RoomStep {
  mustPick: boolean;
  turns: Array<{ id: string; result: RoomTurnResult }>;
  last: string;
  mention: string;
  remaining: { messages: number; steps: number };
}
export function runRoomExchange(options: {
  members: readonly string[];
  to?: readonly string[] | string;
  maxRounds: number;
  maxMessages: number;
  speak(agentId: string, turn: RoomTurn): Promise<RoomTurnAnswer>;
  decide(
    step: RoomStep
  ): Promise<
    | { action: 'speak'; agentId: string; instruction?: string; scene?: RoomScene }
    | { action: 'finish'; scene?: RoomScene }
    | { action: 'unmanaged' }
    | null
  >;
  stopped?(): boolean;
  superseded?(): boolean;
  /** The user's newest message has no answer yet (default true): until a
   *  member speaks, a step must pick. */
  waiting?: boolean;
  /** The called members (`to`) answer and nobody else follows. */
  only?: boolean;
}): Promise<RoomExchangeResult>;
export function roomDataLabel(value: unknown): string;
export function roomDataLines(text: unknown): string[];
export function rowsSinceCursor(
  rows: readonly RoomRow[],
  cursor: string | undefined,
  agentId: string,
  /** The id of the newest row the member's session was handed. */
  seenId?: string
): RoomRow[];
export function roomTurnPrompt(options: {
  roomName: string;
  self: RoomMemberLabel;
  members: readonly RoomMemberLabel[];
  rows: readonly RoomRow[];
  shareTools?: boolean;
  /** The members the user asked (true: this member alone). */
  addressed?: boolean | readonly string[];
  /** The peer whose @mention gave this member its turn. */
  mentionedBy?: string;
  /** The supervisor's note on what is wanted from this member. */
  instruction?: string;
  /** How to talk: casual group chat, or work (the default). */
  scene?: RoomScene;
  /** The user's newest message still has no answer (default: it is the newest row). */
  waiting?: boolean;
  /** The sender of the message this member was asked from another session. */
  askedBy?: string;
  /** The member's own reported work it relays to the room this turn. */
  relay?: string;
}): string | RoomPromptPart[];
export function normalizeRoomRow(row?: Partial<RoomRow> & Record<string, unknown>): RoomRow;
export function roomRowMessage(row: Partial<RoomRow>): {
  role: 'user' | 'assistant';
  content: string;
  meta: {
    source: string;
    room: Omit<RoomRow, 'id' | 'at' | 'text' | 'attachments'>;
    transcript: { at: number; messageId: string; attachments?: RoomRow['attachments'] };
  };
};
export function isRoomRowMessage(message: unknown): boolean;
export function roomRowItem(message: unknown, id?: unknown): Record<string, unknown>;
export function roomRowsOfItems(items: unknown): RoomRow[];
export function roomRowSender(room: unknown): { fromAgent?: string; sender?: 'lead' };
