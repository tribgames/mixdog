import { createElement, Fragment, type ReactNode, useMemo, useRef } from 'react';
import { settledRowCount } from './use-conversation-follow-effects';
import { greetingSuggestions } from '../shared/greeting-suggestions';
import { stripAgentMessageEnvelope } from '../../../../src/runtime/shared/agent-message-envelope.mjs';
import { MIXY_AGENT_ID, agentIdOfHomeSession } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { roomIdOfSession } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import {
  agentChatPlace,
  agentReplyUnfinished,
  agentTypingLead,
  agentTypingShown,
  chatBotReplyOf,
  botSendsPlacement,
  carriedBotSends,
  chatBotSendsOf,
  chatRoutineOf,
  chatRoutineTriggerOf,
  isEndedTurnLastRow,
  isRoomTypingItem,
  roomPassIsQuiet,
  routineGroupOf,
  taskReportIsQuiet,
  turnEndToolItems,
} from './agent-chat-place';
import {
  AgentBotReplyBody,
  AgentBotSent,
  AgentChatRow,
  AgentRoutineBody,
  AgentRoutineCard,
  AgentRoutineTrigger,
  AgentTypingRow,
} from './agent-chat-row';
import { askUserCardKey, splitAskUser } from './ask-user-record';
import { BrowserPeekLine, SavedSignInLines, lastBrowserRoundOfTurn, savedSignInSites } from './browser-peek-line';
import { ConnectorChatCard, connectorCardIds } from './connector-card';
import { useRoomContacts } from './agent-room-parts';
import type { DesktopPromptContent, DesktopSubmitOptions } from '../shared/contract';
import type { ConversationProps } from './conversation-pane-props';
import { type TurnCardsSeat, transcriptRowNode } from './conversation-support';
import type { Snapshot, TranscriptItem } from './desktop-types';
import type { TranscriptRowModel } from './transcript-rows';
import { PreviewedTurnChangesCard, ToolVisualizeCards } from './transcript-visualize-card';
import { linkedLocalPaths } from './markdown-plugins';
import { runningTurnKeyOf } from './turn-preview-model';
import { visualizeCardCalls, visualizedTargets, visualizeTurnEndAt } from './visualize-card-model';
import { useConversationRetry } from './use-conversation-retry';

const NO_TOOL_ITEMS: TranscriptItem[] = [];

/** When the turn's rows were last recorded (ms): its previews' time. */
function turnEndedAt(rows: readonly TranscriptRowModel[], turnKey: string): number {
  let at = 0;
  for (const row of rows) {
    if (row.turnKey !== turnKey) continue;
    if (row._tag === 'ToolActivity') at = Math.max(at, visualizeTurnEndAt(row.items));
    else if ('item' in row && row.item) {
      at = Math.max(at, Number(row.item.completedAt ?? row.item.at ?? row.item.startedAt) || 0);
    }
  }
  return at;
}

/** The text of the turn's final reply part (what its previews look for). */
function turnReplyText(rows: readonly TranscriptRowModel[], turnKey: string): string {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row._tag === 'AssistantPart' && row.turnKey === turnKey && row.item.kind === 'assistant') {
      return String(row.item.text || '');
    }
  }
  return '';
}

const linkedCache = new Map<string, readonly string[]>();

function linkedIn(text: string): readonly string[] {
  let paths = linkedCache.get(text);
  if (!paths) {
    paths = linkedLocalPaths(text);
    linkedCache.set(text, paths);
    if (linkedCache.size > 200) linkedCache.delete(linkedCache.keys().next().value as string);
  }
  return paths;
}

/** What earlier turns of the conversation surfaced: the files their replies
 *  linked and the targets they opened in the panel. Read from the rows
 *  themselves, so it holds after a reload and on a paired device. */
function surfacedBeforeTurn(rows: readonly TranscriptRowModel[], turnKey: string): string[] {
  const first = rows.findIndex((row) => row.turnKey === turnKey);
  const surfaced = new Set<string>();
  for (const row of first < 0 ? rows : rows.slice(0, first)) {
    if (row._tag === 'AssistantPart' && row.item.kind === 'assistant') {
      for (const path of linkedIn(String(row.item.text || ''))) surfaced.add(path);
    } else if (row._tag === 'ToolActivity') {
      for (const target of visualizedTargets(row.items)) surfaced.add(target);
    }
  }
  return [...surfaced];
}

/** Who is typing in a room: the member the host's trailing typing row names.
 *  The host drops that row while its supervisor decides, a moment BEFORE the
 *  member's words reach the view, so the bubble is held until a row lands
 *  after it (the words, or a pass): dropping it at once let the followed
 *  thread fall by the bubble and rise by the words ~70ms later. */
function useRoomTyping(inRoom: boolean, settledItems: TranscriptItem[], disclosureScope: string) {
  const typingSeen = useRef<{ scope: string; id: string; count: number; speaker: string; name: string } | null>(null);
  return useMemo(() => {
    if (!inRoom) return null;
    const count = settledRowCount(settledItems);
    const last = settledItems.at(-1);
    const id = isRoomTypingItem(last) ? String(last?.id ?? '') : '';
    const seen = typingSeen.current;
    if (id && (seen?.id !== id || seen.scope !== disclosureScope)) {
      typingSeen.current = {
        scope: disclosureScope,
        id,
        count,
        speaker: String(last?.room?.speaker || ''),
        name: String(last?.room?.name || ''),
      };
    }
    const held = typingSeen.current;
    return held && held.scope === disclosureScope && held.count === count && held.speaker ? held : null;
  }, [inRoom, settledItems, disclosureScope]);
}

/** The turn's visualize cards, and the targets they show (what its changed-files
 *  card then leaves out). */
function turnCards(
  rows: readonly TranscriptRowModel[],
  index: number,
  row: TranscriptRowModel,
  {
    settledItems,
    settledTurnKeys,
    disclosureScope,
    cardProps,
  }: {
    settledItems: TranscriptItem[];
    settledTurnKeys: string[];
    disclosureScope: string;
    cardProps: { compact: boolean; frame: (children: ReactNode) => ReactNode } | null;
  }
): { cards: ReactNode; visualized: string[] | undefined } {
  // The turn's changed-files card (on its reply or error row) lists no file
  // its visualize cards showed; Undo moves onto them when none is left.
  const turnChanges = rows.find(
    (other) =>
      other.turnKey === row.turnKey && (other._tag === 'AssistantPart' || other._tag === 'Error') && other.turnChanges
  );
  const changesRef =
    turnChanges && (turnChanges._tag === 'AssistantPart' || turnChanges._tag === 'Error')
      ? turnChanges.turnChanges
      : undefined;
  const turnToolItems = () =>
    rows.flatMap((other) => (other._tag === 'ToolActivity' && other.turnKey === row.turnKey ? other.items : []));
  const visualized = changesRef ? visualizedTargets(turnToolItems()) : undefined;
  // A turn that changed files gets the card too, tool rounds or not: its
  // previews (the changed files the panel can show) fill it at its end.
  const tools = turnEndToolItems(rows, index) ?? (changesRef && isEndedTurnLastRow(rows, index) ? NO_TOOL_ITEMS : null);
  const turnEnd =
    tools && changesRef
      ? {
          replyText: turnReplyText(rows, row.turnKey),
          surfacedBefore: surfacedBeforeTurn(rows, row.turnKey),
          endTurnKey: runningTurnKeyOf(settledItems, settledTurnKeys, row.turnKey),
          endedAt: turnEndedAt(rows, row.turnKey),
        }
      : null;
  const cards =
    tools && (changesRef || visualizeCardCalls(tools).length)
      ? createElement(ToolVisualizeCards, {
          items: tools,
          sessionId: disclosureScope,
          ...cardProps,
          turnChanges: changesRef,
          ...turnEnd,
        })
      : null;
  return { cards, visualized };
}

/** What a tool round leaves in a chat when no question needs the user: its
 *  connect card, the "sent to" lines, a browser peek or saved sign-in lines.
 *  `undefined`: the round shows through the ordinary row (a question). */
function toolRoundAside(
  items: readonly TranscriptItem[],
  rows: readonly TranscriptRowModel[],
  index: number,
  {
    connectorCards,
    sentLines,
    asideRow,
    cardKey,
    disclosureScope,
  }: {
    connectorCards: ReactNode;
    sentLines: ReactNode;
    asideRow: (children: ReactNode) => ReactNode;
    /** The call holding the live card (askUserCardKey); undefined: no card. */
    cardKey: string | undefined;
    disclosureScope: string;
  }
): ReactNode | undefined {
  const { asked, waiting } = splitAskUser(items, cardKey !== undefined, cardKey);
  if (asked.length || waiting) return undefined;
  const withSent = (node: ReactNode): ReactNode => (sentLines ? createElement(Fragment, null, sentLines, node) : node);
  if (connectorCards) return withSent(asideRow(connectorCards));
  const peek = lastBrowserRoundOfTurn(rows, index);
  const signedIn = savedSignInSites(items).length > 0;
  if (!peek && !signedIn) return sentLines;
  return withSent(
    asideRow(
      createElement(
        Fragment,
        null,
        signedIn ? createElement(SavedSignInLines, { items }) : null,
        peek ? createElement(BrowserPeekLine, { sessionId: disclosureScope }) : null
      )
    )
  );
}

/** The row as a chat bubble draws it: no completion footer, no changed-files
 *  card (it moves below the bubble), and a greeting without its suggestions comment. */
function chatShownRow(row: TranscriptRowModel, item: TranscriptItem | undefined): TranscriptRowModel {
  if (row._tag === 'AssistantPart') {
    const greeting = item ? greetingSuggestions(item.text) : null;
    return {
      ...row,
      ...(greeting?.marked ? { item: { ...row.item, text: greeting.text } } : {}),
      turnChanges: undefined,
      completion: undefined,
    };
  }
  if (row._tag === 'Error') return { ...row, turnChanges: undefined };
  return row;
}

/** The working band of a chat: a typing bubble under its face, or nothing. */
function thinkingBand(
  rows: readonly TranscriptRowModel[],
  index: number,
  {
    inRoom,
    roomTyping,
    questionCard,
    label,
    homeAgent,
  }: {
    inRoom: boolean;
    roomTyping: ReturnType<typeof useRoomTyping>;
    questionCard: ReactNode;
    label: ReturnType<typeof useRoomContacts>['label'];
    homeAgent: string;
  }
): ReactNode {
  if (inRoom) {
    // A room's band is a member's typing bubble, under its face and name,
    // only while one types (roomTyping); otherwise it takes no room.
    if (!roomTyping || questionCard) return null;
    const member = label(roomTyping.speaker);
    return createElement(AgentTypingRow, {
      member: roomTyping.name ? { ...member, name: roomTyping.name } : member,
      lead: true,
    });
  }
  // A turn waiting on the user's answer is not typing; nothing to show (the
  // reply right above is whole) gives no row content, so the list gives the
  // band no room (TranscriptList.tsx).
  if (questionCard || !agentTypingShown(rows, index)) return null;
  return createElement(AgentTypingRow, { member: label(homeAgent), lead: agentTypingLead(rows, index, '') });
}

/** The content of a chat bubble:a routine card, another bot's words, or the row itself. */
function chatRowBody({
  routine,
  runs,
  botMessage,
  botReply,
  item,
  agentPlaced,
  disclosureScope,
  plain,
}: {
  routine: boolean;
  runs: TranscriptItem[];
  botMessage: TranscriptItem | undefined;
  botReply: ReturnType<typeof chatBotReplyOf>;
  item: TranscriptItem | undefined;
  agentPlaced: boolean;
  disclosureScope: string;
  plain: () => ReactNode;
}): ReactNode {
  if (routine) return createElement(AgentRoutineCard, { runs, sessionId: disclosureScope });
  if (botMessage) {
    return createElement(AgentRoutineBody, {
      item: { ...botMessage, text: stripAgentMessageEnvelope(botMessage.text) },
    });
  }
  if (botReply && item) {
    return createElement(AgentBotReplyBody, { item: { ...item, text: botReply.text }, sessionId: botReply.sessionId });
  }
  if (item && agentPlaced && item.kind === 'notice' && !item.room) return createElement(AgentRoutineBody, { item });
  return plain();
}

/** Renders one transcript row with the pane's retry and disclosure scope. */
export function useConversationRowRenderer({
  snapshot,
  disclosureScope,
  readOnly,
  transitioning,
  renderAssistantRow,
  onOpenSettings,
  settledItems,
  settledTurnKeys,
  optimisticActivityStartedAt,
  submit,
  questionCard,
  agentMode = false,
}: {
  /** Agent mode frames each row as a chat line (agent-chat-row.tsx). */
  agentMode?: boolean;
  snapshot: Snapshot;
  disclosureScope: string;
  readOnly: boolean;
  transitioning: boolean;
  renderAssistantRow: ConversationProps['renderAssistantRow'];
  onOpenSettings: ConversationProps['onOpenSettings'];
  settledItems: TranscriptItem[];
  settledTurnKeys: string[];
  optimisticActivityStartedAt: number;
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;
  /** The pending ask_user card; it renders in place of its tool call. */
  questionCard: ReactNode;
}) {
  const { retryTurn } = useConversationRetry(settledItems, settledTurnKeys, submit);
  const latestCompletion = useMemo(() => {
    for (let index = settledItems.length - 1; index >= 0; index -= 1) {
      if (settledItems[index]?.kind === 'turndone') return settledItems[index];
    }
    return undefined;
  }, [settledItems]);
  const retryDisabled = Boolean(snapshot.busy) || transitioning;
  const { label } = useRoomContacts(agentMode);
  // The one call the live card sits at; every placement decision shares it.
  const cardKey = questionCard
    ? askUserCardKey(settledItems, String(snapshot.toolApproval?.toolCallId ?? ''))
    : undefined;
  const homeAgent = agentIdOfHomeSession(disclosureScope) || MIXY_AGENT_ID;
  // A room's members type through its own typing rows.
  const inRoom = Boolean(roomIdOfSession(disclosureScope));
  const roomTyping = useRoomTyping(inRoom, settledItems, disclosureScope);
  // A line outside any run, in the bubble column (tool-round records, cards).
  const asideRow = (children: ReactNode): ReactNode =>
    createElement(AgentChatRow, { place: null, member: null }, children);
  const rowNode = (row: TranscriptRowModel, seat?: TurnCardsSeat): ReactNode =>
    transcriptRowNode(row, {
      turnCards: seat,
      quietTools: agentMode,
      disclosureScope,
      optimisticActivityStartedAt,
      readOnly,
      renderAssistantRow,
      retryDisabled,
      settledItems,
      settledTurnKeys,
      latestCompletion,
      snapshot,
      onRetryTurn: retryTurn,
      onOpenSettings,
      questionCard,
    });
  // Agent mode: a turn's visualize opens leave one card, a tile per tab, under
  // its last row, once the turn ends (transcript-visualize-card.tsx), above the turn's
  // changed-files line when the row has one.
  const renderTranscriptRow = (
    row: TranscriptRowModel,
    index = 0,
    rows: readonly TranscriptRowModel[] = [row]
  ): ReactNode => {
    const { cards, visualized } = turnCards(rows, index, row, {
      settledItems,
      settledTurnKeys,
      disclosureScope,
      cardProps: agentMode ? { compact: true, frame: asideRow } : null,
    });
    const seat = { cards, placed: false, visualized };
    const node = renderRow(row, index, rows, seat);
    return cards && !seat.placed ? createElement(Fragment, null, node, cards) : node;
  };
  const renderRow = (
    row: TranscriptRowModel,
    index: number,
    rows: readonly TranscriptRowModel[],
    /** The turn's visualize cards: placed above its changed-files line. */
    seat: TurnCardsSeat
  ): ReactNode => {
    // A `setup connect_connector` call leaves its connect card under the round.
    const connectorIds = row._tag === 'ToolActivity' && !readOnly ? connectorCardIds(row.items) : [];
    const connectorCards = connectorIds.length
      ? connectorIds.map((id) => createElement(ConnectorChatCard, { key: id, id }))
      : null;
    if (!agentMode) {
      const node = rowNode(row, seat);
      return connectorCards ? createElement(Fragment, null, node, connectorCards) : node;
    }
    return agentChatRow(row, index, rows, seat, {
      rowNode,
      asideRow,
      label,
      homeAgent,
      inRoom,
      roomTyping,
      questionCard,
      cardKey,
      disclosureScope,
      connectorCards,
    });
  };
  return { renderTranscriptRow };
}

/** A row of an agent's chat: bubbles, typing rows and the cards a turn leaves
 *  beside them. */
function agentChatRow(
  row: TranscriptRowModel,
  index: number,
  rows: readonly TranscriptRowModel[],
  seat: TurnCardsSeat,
  {
    rowNode,
    asideRow,
    label,
    homeAgent,
    inRoom,
    roomTyping,
    questionCard,
    cardKey,
    disclosureScope,
    connectorCards,
  }: {
    rowNode: (row: TranscriptRowModel) => ReactNode;
    asideRow: (children: ReactNode) => ReactNode;
    label: ReturnType<typeof useRoomContacts>['label'];
    homeAgent: string;
    inRoom: boolean;
    roomTyping: ReturnType<typeof useRoomTyping>;
    questionCard: ReactNode;
    cardKey: string | undefined;
    disclosureScope: string;
    connectorCards: ReactNode;
  }
): ReactNode {
  // No working status in a chat: while the agent works, a typing bubble
  // under its face (an approval it waits on docks above the composer).
  if (row._tag === 'Thinking') {
    return thinkingBand(rows, index, { inRoom, roomTyping, questionCard, label, homeAgent });
  }
  const item = row._tag === 'AssistantPart' ? row.item : undefined;
  // The typing bubble below stands for it until the message is complete,
  // then it appears whole.
  if (row._tag === 'AssistantPart' && agentReplyUnfinished(row.live, row.item)) return null;
  if (item?.kind === 'notice' && item.room?.kind === 'typing') {
    const speaker = item.room.speaker || '';
    const member = label(speaker);
    return createElement(AgentTypingRow, {
      member: item.room.name ? { ...member, name: item.room.name } : member,
      lead: agentTypingLead(rows, index, speaker, cardKey),
    });
  }
  // A quiet pass paints nothing: no empty bubble row (its gap shook the
  // thread as members passed), so the list gives it no room (TranscriptList.tsx).
  if (roomPassIsQuiet(item) || taskReportIsQuiet(item?.routine)) return null;
  // Tool rounds stay out (the typing bubble covers them); only a question
  // that needs the user shows, and a turn that drove the browser leaves one
  // "브라우저 · 보기" line (browser-peek-line.tsx).
  // A send to another bot's chat leaves one "sent to" line per message
  // (derived from the stored call), above whatever else the round shows.
  // Under the turn's reply bubble when it has one (carriedBotSends).
  const sends =
    row._tag === 'ToolActivity' && botSendsPlacement(rows, index) === 'aside' ? chatBotSendsOf(row.items) : [];
  const sentLines = sends.length
    ? createElement(
        Fragment,
        null,
        ...sends.map((send) =>
          asideRow(createElement(AgentBotSent, { key: send.id, send, member: label(send.agentId) }))
        )
      )
    : null;
  const withSent = (node: ReactNode): ReactNode => (sentLines ? createElement(Fragment, null, sentLines, node) : node);
  if (row._tag === 'ToolActivity') {
    const aside = toolRoundAside(row.items, rows, index, {
      connectorCards,
      sentLines,
      asideRow,
      cardKey,
      disclosureScope,
    });
    if (aside !== undefined) return aside;
  }
  // A routine fire's turn opens with its marker row (agent-chat-row.tsx).
  if (row._tag === 'UserMessage' && chatRoutineTriggerOf(row.item)) {
    return asideRow(createElement(AgentRoutineTrigger, { item: row.item, sessionId: disclosureScope }));
  }
  const place = agentChatPlace(rows, index, cardKey);
  const speaker = place?.side === 'agent' ? place.speaker || homeAgent : '';
  const member = speaker ? label(speaker) : null;
  const named = member && item?.room?.name ? { ...member, name: item.room.name } : member;
  // Agent mode has no coding chrome: the completion footer stays out, and the
  // changed-files card moves out of the bubble into the column below it.
  // A greeting's suggestions comment (greeting-suggestions.ts) leaves its text.
  const shown = chatShownRow(row, item);
  // A routine result is one card per run of that routine, painted at its
  // latest result (the earlier rows fold into it); an old result row
  // without its marker reads as the agent's own words.
  const routine = chatRoutineOf(item);
  const group = routine ? routineGroupOf(rows, index, cardKey) : null;
  if (group && group.at(-1) !== index) return null;
  const runs = group?.map((at) => (rows[at] as { item: TranscriptItem }).item) ?? [];
  const cardPlace = group && place ? { ...place, first: agentChatPlace(rows, group[0], cardKey)?.first ?? place.first } : place;
  // Another bot's message into this chat, or its answer to this chat's own
  // send, is that bot's bubble (place.bot), never the user's.
  const botMessage = row._tag === 'UserMessage' && place?.bot ? row.item : undefined;
  const botReply = chatBotReplyOf(item);
  const body = chatRowBody({
    routine: Boolean(routine),
    runs,
    botMessage,
    botReply,
    item,
    agentPlaced: place?.side === 'agent',
    disclosureScope,
    plain: () => rowNode(shown),
  });
  const carried = carriedBotSends(rows, index);
  const after = carried.length
    ? createElement(
        Fragment,
        null,
        ...carried.map((send) => createElement(AgentBotSent, { key: send.id, send, member: label(send.agentId) }))
      )
    : undefined;
  const bubble = createElement(AgentChatRow, { place: cardPlace, member: named, card: Boolean(routine), after }, body);
  // The turn's changed files: coding mode's own card under its reply (or the
  // error that ended it), in the bubble column, below the turn's visualize cards.
  const changes = row._tag === 'AssistantPart' || row._tag === 'Error' ? row.turnChanges : undefined;
  // A turn status row ("Response complete", compaction) shows nothing.
  if (place?.side === 'hidden' && !changes) return null;
  if (changes) seat.placed = true;
  const line = changes
    ? createElement(
        Fragment,
        null,
        bubble,
        seat.cards,
        createElement(PreviewedTurnChangesCard, {
          turnChanges: changes,
          frame: asideRow,
          visualized: seat.visualized,
        })
      )
    : bubble;
  // A round that held an answered question: its connect card goes under the
  // question summary (a card-only round returned it above).
  return withSent(connectorCards ? createElement(Fragment, null, line, asideRow(connectorCards)) : line);
}
