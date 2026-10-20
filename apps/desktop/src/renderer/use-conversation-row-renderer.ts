import { createElement, Fragment, type ReactNode, useMemo } from 'react';
import { greetingSuggestions } from '../shared/greeting-suggestions';
import { MIXY_AGENT_ID, agentIdOfHomeSession } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { roomIdOfSession } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import {
  agentChatPlace,
  agentReplyUnfinished,
  agentTypingLead,
  agentTypingShown,
  chatRoutineOf,
  chatRoutineTriggerOf,
  routineGroupOf,
  turnEndToolItems,
} from './agent-chat-place';
import {
  AgentChatRow,
  AgentRoutineBody,
  AgentRoutineCard,
  AgentRoutineTrigger,
  AgentTypingRow,
} from './agent-chat-row';
import { splitAskUser } from './ask-user-record';
import { BrowserPeekLine, SavedSignInLines, lastBrowserRoundOfTurn, savedSignInSites } from './browser-peek-line';
import { ConnectorChatCard, connectorCardIds } from './connector-card';
import { useRoomContacts } from './agent-room-parts';
import type { DesktopPromptContent, DesktopSubmitOptions } from '../shared/contract';
import type { ConversationProps } from './conversation-pane-props';
import { type TurnCardsSeat, transcriptRowNode } from './conversation-support';
import type { Snapshot, TranscriptItem } from './desktop-types';
import type { TranscriptRowModel } from './transcript-rows';
import { ToolVisualizeCards } from './transcript-visualize-card';
import { TurnChangesCard } from './TurnChangesCard';
import { visualizeCardCalls, visualizedTargets } from './visualize-card-model';
import { useConversationRetry } from './use-conversation-retry';

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
  approvalCard,
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
  /** The pending approval card (and its chip or toast); it renders where the turn waits. */
  approvalCard: ReactNode;
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
  const homeAgent = agentIdOfHomeSession(disclosureScope) || MIXY_AGENT_ID;
  // A room's members type through its own typing rows.
  const inRoom = Boolean(roomIdOfSession(disclosureScope));
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
      approvalCard,
    });
  // Agent mode: a turn's visualize opens leave one card, a tile per tab, under
  // its last row, once the turn ends (transcript-visualize-card.tsx), above the turn's
  // changed-files line when the row has one.
  const renderTranscriptRow = (
    row: TranscriptRowModel,
    index = 0,
    rows: readonly TranscriptRowModel[] = [row]
  ): ReactNode => {
    const tools = turnEndToolItems(rows, index);
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
    const visualized = changesRef
      ? visualizedTargets(
          rows.flatMap((other) => (other._tag === 'ToolActivity' && other.turnKey === row.turnKey ? other.items : []))
        )
      : undefined;
    const cards =
      tools && visualizeCardCalls(tools).length
        ? createElement(
            ToolVisualizeCards,
            agentMode
              ? { items: tools, sessionId: disclosureScope, compact: true, frame: asideRow, turnChanges: changesRef }
              : { items: tools, sessionId: disclosureScope, turnChanges: changesRef }
          )
        : null;
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
    // No working status in a chat: while the agent works, a typing bubble
    // under its face; the approval card it waits on stays in the column.
    if (row._tag === 'Thinking') {
      // A turn waiting on the user's answer is not typing.
      const typing = !inRoom && !questionCard && !approvalCard && agentTypingShown(rows, index);
      // Nothing to show (the reply right above is whole): no row content, so
      // the list gives the band no room (TranscriptList.tsx).
      if (!typing && !approvalCard) return null;
      return createElement(AgentTypingRow, {
        member: typing ? label(homeAgent) : null,
        lead: agentTypingLead(rows, index, ''),
        approvalCard,
      });
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
        lead: agentTypingLead(rows, index, speaker),
        approvalCard: null,
      });
    }
    // Tool rounds stay out (the typing bubble covers them); only a question
    // that needs the user shows, and a turn that drove the browser leaves one
    // "브라우저 · 보기" line (browser-peek-line.tsx).
    if (row._tag === 'ToolActivity') {
      const { asked, waiting } = splitAskUser(row.items, Boolean(questionCard));
      if (!asked.length && !waiting) {
        if (connectorCards) return asideRow(connectorCards);
        const peek = lastBrowserRoundOfTurn(rows, index);
        const signedIn = savedSignInSites(row.items).length > 0;
        if (!peek && !signedIn) return null;
        return asideRow(
          createElement(
            Fragment,
            null,
            signedIn ? createElement(SavedSignInLines, { items: row.items }) : null,
            peek ? createElement(BrowserPeekLine, { sessionId: disclosureScope }) : null
          )
        );
      }
    }
    // A routine fire's turn opens with its marker row (agent-chat-row.tsx).
    if (row._tag === 'UserMessage' && chatRoutineTriggerOf(row.item)) {
      return asideRow(createElement(AgentRoutineTrigger, { item: row.item, sessionId: disclosureScope }));
    }
    const place = agentChatPlace(rows, index);
    const speaker = place?.side === 'agent' ? place.speaker || homeAgent : '';
    const member = speaker ? label(speaker) : null;
    const named = member && item?.room?.name ? { ...member, name: item.room.name } : member;
    // Agent mode has no coding chrome: the completion footer stays out, and the
    // changed-files card moves out of the bubble into the column below it.
    // A greeting's suggestions comment (greeting-suggestions.ts) leaves its text.
    const greeting = item ? greetingSuggestions(item.text) : null;
    const shown =
      row._tag === 'AssistantPart'
        ? {
            ...row,
            ...(greeting?.marked ? { item: { ...row.item, text: greeting.text } } : {}),
            turnChanges: undefined,
            completion: undefined,
          }
        : row._tag === 'Error'
          ? { ...row, turnChanges: undefined }
          : row;
    // A routine result is one card per run of that routine, painted at its
    // latest result (the earlier rows fold into it); an old result row
    // without its marker reads as the agent's own words.
    const routine = chatRoutineOf(item);
    const group = routine ? routineGroupOf(rows, index) : null;
    if (group && group.at(-1) !== index) return null;
    const runs = group?.map((at) => (rows[at] as { item: TranscriptItem }).item) ?? [];
    const cardPlace =
      group && place ? { ...place, first: agentChatPlace(rows, group[0])?.first ?? place.first } : place;
    const body = routine
      ? createElement(AgentRoutineCard, { runs, sessionId: disclosureScope })
      : item && place?.side === 'agent' && item.kind === 'notice' && !item.room
        ? createElement(AgentRoutineBody, { item })
        : rowNode(shown);
    const bubble = createElement(AgentChatRow, { place: cardPlace, member: named, card: Boolean(routine) }, body);
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
          createElement(TurnChangesCard, { turnChanges: changes, frame: asideRow, visualized: seat.visualized })
        )
      : bubble;
    return line;
  };
  return { renderTranscriptRow };
}
