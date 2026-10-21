// The sub-agents under a bot or Lead row on the bot page: the parent row's face as a toggle, and the pool's own tree rows (AgentActivityTree) beneath it.
import type React from 'react';
import { type AgentActivityNode, flattenAgentActivityNodes } from './agent-activity-model';
import { agentGroupIndicator } from './agent-chat-summary';
import { t } from './i18n';
import './agent-subtree.css';

/** What hangs under `ownerId`: its own node's children, or the top nodes when
 *  the owner has no pool row of its own. */
export function subAgentNodes(ownerId: string, nodes: readonly AgentActivityNode[] | undefined): AgentActivityNode[] {
  if (!nodes?.length) return [];
  const root = flattenAgentActivityNodes(nodes).find((node) => node.sessionId === ownerId);
  return root ? [...root.children] : nodes.filter((node) => node.sessionId !== ownerId);
}

/** Owners whose sub-agents wait on the user: their rows open by themselves. */
export function subAgentsNeedAttention(ownerId: string, nodes: readonly AgentActivityNode[] | undefined): boolean {
  return subAgentNodes(ownerId, nodes).length > 0 && agentGroupIndicator(ownerId, nodes ?? [])?.kind === 'attention';
}

/** Row attribute every sub-agent owner row carries (bot, Lead). */
export function subtreeRowAttr(hasSubAgents: boolean): { 'data-has-subtree'?: 'true' } {
  return hasSubAgents ? { 'data-has-subtree': 'true' } : {};
}

/** The menu item every sub-agent owner row's context menu starts with. */
export function subtreeMenuItem(
  expanded: boolean,
  onToggle: (expanded: boolean) => void
): { id: string; label: string; onSelect(): void } {
  return {
    id: 'toggle-sub-agents',
    label: expanded ? t('Hide sub-agents') : t('Show sub-agents'),
    onSelect: () => onToggle(!expanded),
  };
}

/** The face of a row with sub-agents as a button: an invisible overlay on the
 *  avatar, beside (not inside) the row's own button, so a click on the face
 *  toggles the list and the rest of the row still opens the chat. */
export function SubtreeToggle({
  expanded,
  name,
  onToggle,
  dragProps,
  clickSuppressed,
}: {
  expanded: boolean;
  name: string;
  onToggle(expanded: boolean): void;
  /** The row's drag source: the face grabs the row like the rest of it does. */
  dragProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  clickSuppressed?(): boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      className="agent-subtree-toggle"
      {...dragProps}
      aria-expanded={expanded}
      aria-label={
        expanded ? t('Collapse sub-agents of {{name}}', { name }) : t('Expand sub-agents of {{name}}', { name })
      }
      onClick={(event) => {
        event.stopPropagation();
        if (clickSuppressed?.()) return;
        onToggle(!expanded);
      }}
    />
  );
}
