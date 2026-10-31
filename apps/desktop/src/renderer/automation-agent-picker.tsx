// The bot a schedule or webhook belongs to: Mixy (the default) or one of the
// user's bots, each with its face. Every fire is a turn in that bot's own chat
// (session-runtime/routine-home-turn.mjs), where it replies with the result.
// Routines are bot-based: with no bot at all (no representative bot yet) none
// can be made (RoutineNeedsBot), and a routine whose bot is gone is paused.
import { Fragment, type ReactNode, useMemo } from 'react';
import { agentAvatar } from '../../../../src/runtime/shared/agent-avatar.mjs';
import { MIXY_AGENT_ID } from '../shared/agent-contacts';
import { agentContacts } from './agent-contacts-model';
import { RoomMemberFace, type RoomMemberLabel } from './agent-room-parts';
import type { RecordValue } from './desktop-types';
import { t } from './i18n';
import { OPEN_AGENTS_VIEW_EVENT, requestMixyDialog, useMixyStatus } from './mixy-identity';
import { OpenSelect } from './OpenSelect';
import { useSidebarReferences } from './sidebar-reference-cache';
import { DEFAULT_AGENT_IDS, agentRosterOf } from './workflows-agent-rows';
import './mixy-first.css';

const AGENT_KEYS = ['agents'] as const;
const NO_GROUPS = new Map();

type AgentsApi = Parameters<typeof useSidebarReferences>[0];

/** The bots a routine can belong to — Mixy once created, then each user bot —
 *  with name and face; an unknown id labels as itself. `ready` is false until
 *  Mixy's status is known. */
export function useAutomationAgents(api: AgentsApi, active: boolean) {
  const { values } = useSidebarReferences(api, AGENT_KEYS, active, false);
  const mixyCreated = useMixyStatus(api, active).created;
  return useMemo(() => {
    const members: RoomMemberLabel[] = agentContacts(values.agents, [], NO_GROUPS)
      .filter((contact) => contact.agentId !== MIXY_AGENT_ID || mixyCreated !== false)
      .map((contact) => ({ id: contact.agentId, name: contact.name, avatar: contact.avatar }));
    const label = (id: string): RoomMemberLabel =>
      members.find((member) => member.id === id) ?? { id, name: id, avatar: agentAvatar(id, null) };
    return { members, label, ready: mixyCreated !== null };
  }, [values.agents, mixyCreated]);
}

/** The delegatable workflow sub-agents (Worker, …) a routine can name as its
 *  executor: the Workflows page's agents, never a bot, a shared service or a
 *  switched-off agent. `label` names an id, an unknown one as itself. */
export function useExecutorAgents(api: AgentsApi, active: boolean) {
  const { values } = useSidebarReferences(api, AGENT_KEYS, active, false);
  return useMemo(() => {
    const off = new Set(values.agents.filter((row) => row.disabled === true).map((row) => String(row.id || '')));
    const choices = agentRosterOf(values.agents)
      .filter((agent) => !agent.contact && !DEFAULT_AGENT_IDS.has(agent.id) && !off.has(agent.id))
      .map((agent) => ({ id: agent.id, name: agent.label }));
    const label = (id: string) => choices.find((choice) => choice.id === id)?.name ?? id;
    return { choices, label };
  }, [values.agents]);
}

/** The executor a saved row names; '' when the bot handles it itself. */
export function executorAgentOf(row: RecordValue | undefined): string {
  return typeof row?.executorAgentId === 'string' ? row.executorAgentId : '';
}

/** The save field of the executor pick: null clears it. */
export function executorRunFields(executor: string): RecordValue {
  return { executorAgentId: executor || null };
}

const NO_EXECUTOR = '__none__';

/** The optional sub-agent that does the routine's work first, the bot only
 *  relaying its result; none (the default) leaves the work to the bot. */
export function ExecutorAgentPicker({
  api,
  value,
  disabled,
  ariaLabel,
  onChange,
}: {
  api: AgentsApi;
  /** The sub-agent id; '' for none. */
  value: string;
  disabled: boolean;
  ariaLabel: string;
  onChange(executor: string): void;
}) {
  const executors = useExecutorAgents(api, true);
  // An executor the catalog no longer offers (switched off, deleted) stays the shown choice.
  const choices =
    value && !executors.choices.some((choice) => choice.id === value)
      ? [...executors.choices, { id: value, name: executors.label(value) }]
      : executors.choices;
  return (
    <OpenSelect
      className="automation-executor-picker"
      ariaLabel={ariaLabel}
      value={value || NO_EXECUTOR}
      disabled={disabled}
      options={[
        { value: NO_EXECUTOR, label: t('The bot itself') },
        ...choices.map((choice) => ({ value: choice.id, label: choice.name })),
      ]}
      onChange={(next) => onChange(next === NO_EXECUTOR ? '' : next)}
    />
  );
}

/** The bot a saved row belongs to (a row without an owner: Mixy); a new row's
 *  is `fallback`, the first bot available. */
export function automationAgentOf(row: RecordValue | undefined, fallback: string = MIXY_AGENT_ID): string {
  if (!row) return fallback;
  return String(row.owner || MIXY_AGENT_ID);
}

/** The save fields of the pick. */
export function automationRunFields(agent: string): RecordValue {
  return { owner: agent };
}

/** Why a routine is paused for its bot (channel-admin `ownerProblem`); '' when it runs. */
function routineOwnerProblemText(row: RecordValue): string {
  if (row.ownerProblem === 'no-mixy') return t('Create the representative bot first.');
  if (row.ownerProblem === 'owner-deleted') return t('This bot was deleted.');
  return '';
}

/** A paused routine's reason: its bot is missing, it switched itself off
 *  after failures, or it was paused; '' while it runs. */
export function routinePausedText(row: RecordValue, pausedAfter: number | null): string {
  const missing = routineOwnerProblemText(row);
  if (missing) return missing;
  if (pausedAfter !== null) return t('Paused after {{n}} failures in a row', { n: pausedAfter });
  return row.enabled === false ? t('Paused') : '';
}

/** The side lists' single-select sort chips (routine-sideview-model.ts). */
export function RoutineSortChips<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange(next: T): void;
}) {
  return (
    <div className="routine-sort-chips" role="tablist" aria-label={t('Sort routines')}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The side list's groups: a header (a bot's face and name, or a title) with
 *  its count over each group's rows; a flat list has no header. */
export function RoutineSideGroups({
  groups,
  title,
  bot,
  children,
}: {
  groups: ReadonlyArray<{ key: string; bot?: string; rows: RecordValue[] }>;
  title(group: { key: string; bot?: string }): string;
  bot(id: string): RoomMemberLabel;
  children(row: RecordValue): ReactNode;
}) {
  return (
    <div className="routine-side-groups">
      {groups.map((group) => (
        <Fragment key={group.key || 'all'}>
          {group.key && (
            <div className="routine-side-head">
              {group.bot && <RoomMemberFace member={bot(group.bot)} className="automation-agent-face" />}
              <span>{group.bot ? bot(group.bot).name : title(group)}</span>
              <span className="routine-side-count">{group.rows.length}</span>
            </div>
          )}
          <div className="routine-side-list">{group.rows.map((row) => children(row))}</div>
        </Fragment>
      ))}
    </div>
  );
}

/** In place of a routine list or editor while no bot exists: routines are
 *  bot-based, so the representative bot comes first. */
export function RoutineNeedsBot() {
  return (
    <div className="utility-dock-empty routine-needs-bot">
      <p>{t('Create the representative bot first.')}</p>
      <button
        type="button"
        className="mixy-empty-create"
        onClick={() => {
          window.dispatchEvent(new CustomEvent(OPEN_AGENTS_VIEW_EVENT));
          requestMixyDialog();
        }}
      >
        {t('Create representative bot')}
      </button>
    </div>
  );
}

export function AutomationAgentPicker({
  api,
  value,
  disabled,
  ariaLabel,
  onChange,
}: {
  /** The panel's host: the agent catalog comes from the same one. */
  api: AgentsApi;
  /** The bot id. */
  value: string;
  disabled: boolean;
  ariaLabel: string;
  onChange(agent: string): void;
}) {
  const agents = useAutomationAgents(api, true);
  // A bot the catalog no longer lists stays the shown choice.
  const members =
    value && !agents.members.some((member) => member.id === value)
      ? [...agents.members, agents.label(value)]
      : agents.members;
  const face = (member: RoomMemberLabel) => <RoomMemberFace member={member} className="automation-agent-face" />;
  const options = members.map((member) => ({ value: member.id, label: member.name, leading: face(member) }));
  const selected = members.find((member) => member.id === value);
  return (
    <OpenSelect
      className="automation-agent-picker"
      ariaLabel={ariaLabel}
      tooltip={t("The bot that runs this. Its result posts in that bot's chat.")}
      value={value}
      disabled={disabled}
      options={options}
      leading={selected ? face(selected) : undefined}
      onChange={onChange}
    />
  );
}
