import { Plus, Search } from 'lucide-react';
import { AgentGroupsMenu } from './agent-group-visibility';
import { AgentPaneAddMenu } from './AgentRoomsSection';
import type { PaneToggleId, RetainChoice } from './bot-order-store';
import { t } from './i18n';

/** The agent page's header actions, with the Sessions header's action classes;
 *  "+" is rightmost, as on every page: search, ⋯, +. */
export function AgentPaneHeaderActions({
  searching,
  mixyEmpty,
  onToggleSearch,
  hiddenGroups,
  onToggleGroup,
  retain,
  onRetain,
  onCreateMixy,
  onNewAgent,
  onOpenSession,
}: {
  hiddenGroups: ReadonlySet<PaneToggleId>;
  onToggleGroup(id: PaneToggleId, hidden: boolean): void;
  retain: RetainChoice;
  onRetain(choice: RetainChoice): void;
  searching: boolean;
  /** No representative bot yet: "+" creates it. */
  mixyEmpty: boolean;
  onToggleSearch(): void;
  onCreateMixy(): void;
  onNewAgent(): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string, replaceKey?: string): void;
}) {
  return (
    <>
      <button
        type="button"
        className="session-panel-action"
        aria-label={t('Search')}
        data-tooltip={t('Search')}
        aria-pressed={searching}
        onClick={onToggleSearch}
      >
        <Search size={16} aria-hidden="true" />
      </button>
      <AgentGroupsMenu hiddenGroups={hiddenGroups} onToggleGroup={onToggleGroup} retain={retain} onRetain={onRetain} />
      {/* "+": new agent, or new group room (AgentRoomsSection); before Mixy
          exists, always the 대표 에이전트 dialog. */}
      {mixyEmpty ? (
        <button
          type="button"
          className="session-panel-action"
          aria-label={t('Create representative bot')}
          data-tooltip={t('Create representative bot')}
          onClick={onCreateMixy}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      ) : (
        <AgentPaneAddMenu onOpenSession={onOpenSession} onNewAgent={onNewAgent} />
      )}
    </>
  );
}
