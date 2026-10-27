import { createElement, Fragment, type ReactNode, useContext, useMemo, useRef } from 'react';
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
  chatRoutineOf,
  chatRoutineTriggerOf,
  handoffLinesAt,
  isEndedTurnLastRow,
  isRoomTypingItem,
  roomPassIsQuiet,
  roomQuestionSeatsAt,
  routineGroupOf,
  routineReplyIsQuiet,
  taskReportHidden,
  turnEndToolItems,
} from './agent-chat-place';
import {
  AgentBotFolded,
  AgentChatRow,
  AgentRoutineBody,
  AgentRoutineCard,
  AgentRoutineTrigger,
  AgentTypingRow,
} from './agent-chat-row';
import { AgentHandoffBlock, HandoffQuestionsContext, RoomHandoffQuestions } from './agent-task-line';
import { useSessionAttentionIndex } from './session-attention-index';
import { askUserCardKey, splitAskUser } from './ask-user-record';
import {
  BrowserPeekLine,
  SavedSignInLines,
  browserOpenedPage,
  lastBrowserRoundOfTurn,
  savedSignInSites,
} from './browser-peek-line';
import { TerminalPeekLines } from './terminal-peek-line';
import { ChildSurfacePeekLines, childSurfacePeeksAt, useChildSurfacePeeks } from './child-surface-peeks';
import { desktopToolActivityTerminalRuns } from './transcript-tool-core';
import { ConnectorChatCard, connectorCardIds } from './connector-card';
import { useRoomContacts } from './agent-room-parts';
import type { DesktopPromptContent, DesktopSubmitOptions } from '../shared/contract';
import type { ConversationProps } from './conversation-pane-props';
import { type TurnCardsSeat, transcriptRowNode } from './conversation-support';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { type TranscriptRowModel, toolActivityStillOpen } from './transcript-rows';
import { ToolVisualizeCards } from './transcript-visualize-card';
import { turnIndexOf } from './conversation-turn-index';
import { runningTurnKeyOf } from './turn-preview-model';
import { visualizeCardCalls } from './visualize-card-model';
import { useConversationRetry } from './use-conversation-retry';

const NO_TOOL_ITEMS: TranscriptItem[] = [];
const NO_MEMBERS: string[] = [];

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
): { cards: ReactNode; visualized: readonly string[] | undefined } {
  // The turn's changed-files card (on its reply or error row) lists no file
  // its visualize cards showed; Undo moves onto them when none is left.
  const turn = turnIndexOf(rows).get(row.turnKey);
  const changesRef = turn?.changes;
  const visualized = turn && changesRef ? turn.visualized() : undefined;
  // A turn that changed files gets the card too, tool rounds or not: its
  // previews (the changed files the panel can show) fill it at its end.
  const tools = turnEndToolItems(rows, index) ?? (changesRef && isEndedTurnLastRow(rows, index) ? NO_TOOL_ITEMS : null);
  const turnEnd =
    tools && turn && changesRef
      ? {
          replyText: turn.replyText,
          surfacedBefore: turn.surfacedBefore,
          endTurnKey: runningTurnKeyOf(settledItems, settledTurnKeys, row.turnKey),
          endedAt: turn.endedAt,
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

/** The hand-off lines `rows[index]` paints (agent-chat-place.ts
 *  handoffLinesAt), as one block; null when it paints none. */
function handoffBlock(rows: readonly TranscriptRowModel[], index: number): ReactNode {
  const handoffs = handoffLinesAt(rows, index);
  return handoffs.length ? createElement(AgentHandoffBlock, { handoffs }) : null;
}

/** What a tool round leaves in a chat when no question needs the user: its
 *  connect card, its hand-off lines (a turn with no reply), a browser peek,
 *  saved sign-in lines or terminal-run cards. `undefined`: the round shows through the ordinary row
 *  (a question). */
function toolRoundAside(
  items: readonly TranscriptItem[],
  rows: readonly TranscriptRowModel[],
  index: number,
  {
    connectorCards,
    handoffLines,
    asideRow,
    cardKey,
    disclosureScope,
  }: {
    connectorCards: ReactNode;
    handoffLines: ReactNode;
    asideRow: (children: ReactNode) => ReactNode;
    /** The call holding the live card (askUserCardKey); undefined: no card. */
    cardKey: string | undefined;
    disclosureScope: string;
  }
): ReactNode | undefined {
  const { asked, waiting } = splitAskUser(items, cardKey !== undefined, cardKey);
  if (asked.length || waiting) return undefined;
  const withLines = (node: ReactNode): ReactNode =>
    handoffLines ? createElement(Fragment, null, handoffLines, node) : node;
  const terminalRuns = desktopToolActivityTerminalRuns(items).length > 0;
  if (connectorCards) {
    // A round that connected an account and ran a command keeps both.
    return withLines(
      asideRow(
        terminalRuns
          ? createElement(
              Fragment,
              null,
              connectorCards,
              createElement(TerminalPeekLines, { items, sessionId: disclosureScope })
            )
          : connectorCards
      )
    );
  }
  const peek = lastBrowserRoundOfTurn(rows, index) ? browserOpenedPage(items) : null;
  const signedIn = savedSignInSites(items).length > 0;
  if (!peek && !signedIn && !terminalRuns) return handoffLines;
  return withLines(
    asideRow(
      createElement(
        Fragment,
        null,
        signedIn ? createElement(SavedSignInLines, { items }) : null,
        peek ? createElement(BrowserPeekLine, { sessionId: disclosureScope, page: peek }) : null,
        terminalRuns ? createElement(TerminalPeekLines, { items, sessionId: disclosureScope }) : null
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

/** The working band of a chat: a typing bubble under its face, or nothing;
 *  the turn's hand-off lines (`block`) under it, so they stay put when the
 *  reply replaces the bubble. */
function thinkingBand(
  rows: readonly TranscriptRowModel[],
  index: number,
  {
    inRoom,
    roomTyping,
    questionCard,
    label,
    homeAgent,
    block,
    asideRow,
  }: {
    inRoom: boolean;
    roomTyping: ReturnType<typeof useRoomTyping>;
    questionCard: ReactNode;
    label: ReturnType<typeof useRoomContacts>['label'];
    homeAgent: string;
    block: ReactNode;
    asideRow: (children: ReactNode) => ReactNode;
  }
): ReactNode {
  const alone = block ? asideRow(block) : null;
  if (inRoom) {
    // A room's band is a member's typing bubble, under its face and name,
    // only while one types (roomTyping); otherwise it takes no room.
    if (!roomTyping || questionCard) return alone;
    const member = label(roomTyping.speaker);
    return createElement(AgentTypingRow, {
      member: roomTyping.name ? { ...member, name: roomTyping.name } : member,
      lead: true,
      after: block,
    });
  }
  // A turn waiting on the user's answer is not typing; nothing to show (the
  // reply right above is whole) gives no row content, so the list gives the
  // band no room (TranscriptList.tsx).
  if (questionCard || !agentTypingShown(rows, index)) return alone;
  return createElement(AgentTypingRow, {
    member: label(homeAgent),
    lead: agentTypingLead(rows, index, ''),
    after: block,
  });
}

/** The content of a chat bubble:a routine card, another bot's words, or the row itself. */
function chatRowBody({
  routine,
  runs,
  botMessage,
  item,
  agentPlaced,
  disclosureScope,
  plain,
}: {
  routine: boolean;
  runs: TranscriptItem[];
  botMessage: TranscriptItem | undefined;
  item: TranscriptItem | undefined;
  agentPlaced: boolean;
  disclosureScope: string;
  plain: () => ReactNode;
}): ReactNode {
  if (routine) return createElement(AgentRoutineCard, { runs, sessionId: disclosureScope });
  if (botMessage) return createElement(AgentBotFolded, { text: stripAgentMessageEnvelope(botMessage.text) });
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
  // Sessions waiting for the user now: a wait report shows only for them.
  const waiting = useSessionAttentionIndex().needsUser;
  // The one call the live card sits at; every placement decision shares it.
  const cardKey = questionCard
    ? askUserCardKey(settledItems, String(snapshot.toolApproval?.toolCallId ?? ''))
    : undefined;
  const homeAgent = agentIdOfHomeSession(disclosureScope) || MIXY_AGENT_ID;
  // A room's members type through its own typing rows.
  const inRoom = Boolean(roomIdOfSession(disclosureScope));
  const roomTyping = useRoomTyping(inRoom, settledItems, disclosureScope);
  // A room's members whose handed-off sessions ask the user something now.
  const handoffQuestions = useContext(HandoffQuestionsContext);
  const asking = useMemo(
    () =>
      inRoom && handoffQuestions
        ? [...new Set(handoffQuestions.questions.map((question) => String(question.roomMember || '')))].filter(Boolean)
        : NO_MEMBERS,
    [inRoom, handoffQuestions]
  );
  // The lines child sessions' surfaces (a sub-agent's, a task session's, a
  // room member's browser or terminal) leave in this owner conversation.
  const childPeeks = useChildSurfacePeeks(disclosureScope);
  // A line outside any run, in the bubble column (tool-round records, cards).
  const asideRow = (children: ReactNode): ReactNode =>
    createElement(AgentChatRow, { place: null, member: null }, children);
  const rowNode = (row: TranscriptRowModel, seat?: TurnCardsSeat, toolsRunning = false): ReactNode =>
    transcriptRowNode(row, {
      turnCards: seat,
      toolsRunning,
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
    const carded = cards && !seat.placed ? createElement(Fragment, null, node, cards) : node;
    // A room member's handed-off questions, under its newest words.
    const seated = roomQuestionSeatsAt(rows, index, asking);
    const shown = seated.length
      ? createElement(
          Fragment,
          null,
          carded,
          asideRow(seated.map((speaker) => createElement(RoomHandoffQuestions, { key: speaker, speaker })))
        )
      : carded;
    // A child's line follows the row recorded last before its reveal.
    const peeks = childSurfacePeeksAt(rows, index, childPeeks);
    if (!peeks.length) return shown;
    const lines = createElement(ChildSurfacePeekLines, { sessionId: disclosureScope, peeks });
    return createElement(Fragment, null, shown, agentMode ? asideRow(lines) : lines);
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
      // A task report a hand-off line already shows paints nothing; the
      // turn's hand-off lines sit under its reply (or its working row while
      // it runs), as in a chat.
      if (taskReportHidden(rows, index, waiting)) return null;
      const node = rowNode(row, seat, toolActivityStillOpen(rows, index, Boolean(snapshot.busy)));
      const block = handoffBlock(rows, index);
      return connectorCards || block ? createElement(Fragment, null, node, block, connectorCards) : node;
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
      waiting,
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
    waiting,
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
    waiting: ReadonlySet<string>;
  }
): ReactNode {
  // The turn's hand-off lines, at the row that carries them (handoffLinesAt).
  const block = handoffBlock(rows, index);
  // No working status in a chat: while the agent works, a typing bubble
  // under its face (an approval it waits on docks above the composer).
  if (row._tag === 'Thinking') {
    return thinkingBand(rows, index, { inRoom, roomTyping, questionCard, label, homeAgent, block, asideRow });
  }
  const item = row._tag === 'AssistantPart' ? row.item : undefined;
  // The typing bubble below stands for it until the message is complete,
  // then it appears whole.
  // A part that carries the turn's hand-off lines shows the typing bubble
  // itself, the lines under it (the band shows none, agentTypingShown): the
  // reply then lands in this same row, the lines unmoved.
  if (row._tag === 'AssistantPart' && agentReplyUnfinished(row.live, row.item)) {
    if (!block) return null;
    return createElement(AgentTypingRow, {
      member: label(homeAgent),
      lead: agentTypingLead(rows, index, ''),
      after: block,
    });
  }
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
  if (roomPassIsQuiet(item) || taskReportHidden(rows, index, waiting) || routineReplyIsQuiet(item)) return null;
  // Tool rounds stay out (the typing bubble covers them); only a question
  // that needs the user shows, and a turn that drove the browser leaves one
  // "브라우저 · 보기" line (browser-peek-line.tsx). A round of a turn with no
  // reply keeps its own hand-off lines, above whatever else it shows.
  const handoffLines = row._tag === 'ToolActivity' && block ? asideRow(block) : null;
  const withLines = (node: ReactNode): ReactNode =>
    handoffLines ? createElement(Fragment, null, handoffLines, node) : node;
  if (row._tag === 'ToolActivity') {
    const aside = toolRoundAside(row.items, rows, index, {
      connectorCards,
      handoffLines,
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
  const cardPlace =
    group && place ? { ...place, first: agentChatPlace(rows, group[0], cardKey)?.first ?? place.first } : place;
  // Another bot's message into this chat is that bot's bubble (place.bot),
  // never the user's; its answer to this chat's send is its report card.
  const botMessage = row._tag === 'UserMessage' && place?.bot ? row.item : undefined;
  const body = chatRowBody({
    routine: Boolean(routine),
    runs,
    botMessage,
    item,
    agentPlaced: place?.side === 'agent',
    disclosureScope,
    plain: () => rowNode(shown),
  });
  // The turn's last reply carries its hand-off lines, under the bubble and its time.
  const after = row._tag === 'ToolActivity' ? undefined : block;
  const bubble = createElement(AgentChatRow, { place: cardPlace, member: named, card: Boolean(routine), after }, body);
  // The turn's end seats its visualize cards under its reply (or the error
  // that ended it). A bot chat shows no changed-files card: the conversation
  // is about the result, not the diff (user: 봇 세션에서 변경은 안 나와도 된다).
  const changes = row._tag === 'AssistantPart' || row._tag === 'Error' ? row.turnChanges : undefined;
  // A turn status row ("Response complete", compaction) shows nothing.
  if (place?.side === 'hidden' && !changes) return null;
  if (changes) seat.placed = true;
  const line = changes ? createElement(Fragment, null, bubble, seat.cards) : bubble;
  // A round that held an answered question: its connect card goes under the
  // question summary (a card-only round returned it above).
  return withLines(connectorCards ? createElement(Fragment, null, line, asideRow(connectorCards)) : line);
}
