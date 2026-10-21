import { useState } from 'react';
import type React from 'react';
import type { AgentContact } from './agent-contacts-model';
import { moveBot } from './bot-order-store';
import { acceptPaneDrag, cancelPaneDragPreview, currentPaneDrag } from './pane-drag-session';
import { usePersistedListOrder } from './use-persisted-list-order';
import './bot-reorder.css';

/** Marks a list whose bot rows reorder by drag. The pane workspace leaves
 *  session drags over such a list to it (no split preview, no drop into the
 *  pane); a drag released anywhere else still opens the session in a pane. */
export const BOT_ORDER_ZONE = 'bot-order';

type DropMark = { id: string; edge: 'before' | 'after' };

/** The drop-line drag machinery of one reorderable list, shared by the bot
 *  lists and the section-order dialog: `ids` in list order, rows marked by
 *  `attr`, `draggedId` naming the id the drag in flight carries (null = not
 *  ours: refused), `move` applying a drop. */
function listReorder(
  mark: DropMark | null,
  setMark: React.Dispatch<React.SetStateAction<DropMark | null>>,
  spec: {
    ids: readonly string[];
    attr: string;
    draggedId(): string | null;
    move(fromId: string, toId: string): boolean;
  }
) {
  const { ids, attr } = spec;
  const targetOf = (event: React.DragEvent<HTMLElement>): string | null => {
    const id = (event.target as Element | null)?.closest?.(`[${attr}]`)?.getAttribute(attr) ?? null;
    return id !== null && ids.includes(id) ? id : null;
  };
  const markFor = (from: string, to: string): DropMark | null =>
    from === to ? null : { id: to, edge: ids.indexOf(from) < ids.indexOf(to) ? 'after' : 'before' };
  return {
    listProps: {
      'data-pane-drag-zone': BOT_ORDER_ZONE,
      onDragEnter(event: React.DragEvent<HTMLElement>) {
        if (currentPaneDrag()?.kind !== 'session') return;
        event.preventDefault();
      },
      onDragOver(event: React.DragEvent<HTMLElement>) {
        if (currentPaneDrag()?.kind !== 'session') return;
        event.preventDefault();
        event.stopPropagation();
        cancelPaneDragPreview();
        const from = spec.draggedId();
        const to = targetOf(event);
        const next = from && to ? markFor(from, to) : null;
        if (event.dataTransfer) event.dataTransfer.dropEffect = next ? 'move' : 'none';
        setMark((current) => (current?.id === next?.id && current?.edge === next?.edge ? current : next));
      },
      onDragLeave(event: React.DragEvent<HTMLElement>) {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMark(null);
      },
      onDrop(event: React.DragEvent<HTMLElement>) {
        if (currentPaneDrag()?.kind !== 'session') return;
        event.preventDefault();
        event.stopPropagation();
        const from = spec.draggedId();
        const to = targetOf(event);
        setMark(null);
        acceptPaneDrag(); // settled here, whatever the outcome: never also a pane drop
        if (from && to) spec.move(from, to);
      },
    },
    /** Row attribute: where a drop would land. */
    dropMark: (id: string) => (mark?.id === id ? mark.edge : undefined),
    /** Move `id` one place (-1 up, +1 down); false when it cannot. */
    step(id: string, delta: -1 | 1): boolean {
      const index = ids.indexOf(id);
      const neighbour = ids[index + delta];
      return index >= 0 && neighbour !== undefined && spec.move(id, neighbour);
    },
  };
}

/** -1 / +1 for Alt+ArrowUp / Alt+ArrowDown (the event is claimed), else 0. */
export function altArrowDelta(event: React.KeyboardEvent<HTMLElement>): -1 | 0 | 1 {
  if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return 0;
  event.preventDefault();
  return event.key === 'ArrowUp' ? -1 : 1;
}

/** Drag-and-drop and Alt+Arrow reordering of one bot list. Bots only: Mixy
 *  (pinned first) neither moves nor is passed, and any other session dragged
 *  over the list — a workflow agent, a sub-agent — is refused, as is a bot
 *  released on anything but another bot's row. Rows stay session drag sources
 *  (useSessionDragSource), so dragging a row out of the list still opens it. */
export function useBotReorder() {
  const [mark, setMark] = useState<DropMark | null>(null);
  return {
    /** Bind to the contacts a list shows (in order, Mixy included). */
    bind(contacts: readonly AgentContact[]) {
      const bots = contacts.filter((contact) => !contact.mixy);
      const shownIds = bots.map((contact) => contact.agentId);
      /** The bot being dragged, from the session drag in flight; null for any other session. */
      const draggedBot = (): string | null => {
        const drag = currentPaneDrag();
        if (drag?.kind !== 'session') return null;
        if (drag.botId) return bots.find((contact) => contact.agentId === drag.botId)?.agentId ?? null;
        const sessionId = drag.selection.kind === 'session' ? drag.selection.id : '';
        return bots.find((contact) => contact.session?.id === sessionId && sessionId !== '')?.agentId ?? null;
      };
      const list = listReorder(mark, setMark, {
        ids: shownIds,
        attr: 'data-agent-contact',
        draggedId: draggedBot,
        move: (from, to) => moveBot(shownIds, from, to),
      });
      return {
        listProps: list.listProps,
        rowProps: (contact: AgentContact) => ({ 'data-bot-drop': list.dropMark(contact.agentId) }),
        /** Alt+ArrowUp / Alt+ArrowDown on a bot row moves it one place. */
        onKeyDown(contact: AgentContact, event: React.KeyboardEvent<HTMLElement>) {
          const delta = altArrowDelta(event);
          if (!delta || !list.step(contact.agentId, delta)) return;
          // The row is re-seated by the new order; keep the keyboard on it.
          const row = event.currentTarget.closest('[data-agent-contact]');
          window.setTimeout(() => row?.querySelector<HTMLElement>('button')?.focus(), 0);
        },
      };
    },
  };
}

/** The Bots page's bot list reorders exactly like the Sessions sidebar's rows
 *  and folders: the shared usePersistedListOrder (drop line via
 *  `data-drop-position`, edge auto-scroll), committing into the shared bot
 *  order. Rows stay session drag sources (useSessionDragSource), so a row
 *  dragged out of the list still opens in a pane; `listProps` keeps the pane
 *  workspace from previewing a split over the list and refuses any drag that is
 *  not a row of this list. Mixy (pinned first) neither moves nor is passed. */
export function usePaneBotReorder(contacts: readonly AgentContact[]) {
  const shownIds = contacts.filter((contact) => !contact.mixy).map((contact) => contact.agentId);
  const order = usePersistedListOrder('mixdog:bots-page-bot-order', shownIds, {
    onCommit(next, sourceId) {
      const target = shownIds[next.indexOf(sourceId)];
      if (target) moveBot(shownIds, sourceId, target);
    },
  });
  return {
    listProps: {
      'data-pane-drag-zone': BOT_ORDER_ZONE,
      onDragEnter(event: React.DragEvent<HTMLElement>) {
        if (currentPaneDrag()?.kind === 'session') event.preventDefault();
      },
      onDragOver(event: React.DragEvent<HTMLElement>) {
        if (currentPaneDrag()?.kind !== 'session') return;
        const accepted = event.defaultPrevented; // a row of this list took it
        event.preventDefault();
        event.stopPropagation();
        cancelPaneDragPreview();
        if (event.dataTransfer && !accepted) event.dataTransfer.dropEffect = 'none';
      },
      onDrop(event: React.DragEvent<HTMLElement>) {
        if (currentPaneDrag()?.kind !== 'session') return;
        event.preventDefault();
        event.stopPropagation();
        acceptPaneDrag(); // settled here, whatever the outcome: never also a pane drop
      },
    },
    /** The row's drop target and drag-state marks (the drag itself starts on the row's button). */
    rowProps(contact: AgentContact) {
      if (contact.mixy) return {};
      const { draggable: _grip, ...props } = order.getReorderProps(contact.agentId);
      return props;
    },
    /** Alt+ArrowUp / Alt+ArrowDown on a bot row moves it one place. */
    onKeyDown(contact: AgentContact, event: React.KeyboardEvent<HTMLElement>) {
      const delta = altArrowDelta(event);
      const neighbour = shownIds[shownIds.indexOf(contact.agentId) + delta];
      if (!delta || !neighbour || !moveBot(shownIds, contact.agentId, neighbour)) return;
      // The row is re-seated by the new order; keep the keyboard on it.
      const row = event.currentTarget.closest('[data-agent-contact]');
      window.setTimeout(() => row?.querySelector<HTMLElement>('button')?.focus(), 0);
    },
  };
}
