// The agent panel's 프로필 tab: the agent's face, name and 하는 일 on top, then
// the same controls the new-agent dialog uses — face, name, model, 하는 일,
// 성격 (PERSONA.md) and 일하는 방식 (AGENT.md) — saved through
// saveAgentDefinition, with 저장 / 취소 shown only once something changed.
// 켜기/끄기 and 삭제 live in the dock header's ⋯ menu (dock-panel-actions).
//
// Mixy (the Lead): its name and face are agents/lead/agent.json `name` and
// `avatar` (saveLeadIdentity; the star badge stays); its model is the Main route the
// Lead runs on (also applied to its thread), its persona agents/lead/PERSONA.md
// and its 일하는 방식 agents/lead/AGENT.md.
import { ChevronRight, Power, RotateCcw, Star, Trash2 } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MIXY_AGENT_ID, agentIdOfHomeSession } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import {
  type AgentAvatarValue,
  agentAvatar,
  AGENT_AVATAR_STATES,
  type AgentAvatarState,
  MIXY_AVATAR,
  defaultAgentAvatar,
  mascotLook,
} from '../../../../src/runtime/shared/agent-avatar.mjs';
import type { DesktopApi, DesktopModelOption, DesktopModelSelection } from '../shared/contract';
import {
  AgentAvatar,
  MascotAvatar,
  type MascotAvatarValue,
  isSignatureDefault,
  useAgentAvatarImages,
} from './agent-avatar';
import type { AvatarStateUpload } from './agent-avatar-image';
import {
  AgentAvatarChooser,
  AgentAvatarSegments,
  type AvatarStatesDraft,
  AvatarDraftPreview,
  customAvatarDraft,
  customAvatarPayload,
} from './agent-face-editor';
import { useDeletedBotSession } from './agent-chat-mode';
import { AgentInstructionEditors } from './agent-instruction-editors';
import { ConnectorSwitchList, prefetchConnectorSwitches } from './connector-switches';
import { AlwaysAllowedList, prefetchAlwaysAllowed } from './agent-always-allowed';
import { HeartbeatSwitch } from './agent-heartbeat-switch';
import { createKeyedReadCache } from './keyed-read-cache';
import { type AgentActionsApi, deleteAgent, resetConversation, setAgentOn } from './agent-profile-actions';
import { subscribeAgentRouteChange } from './agent-chat-route';
import { usePublishDockPanelActions } from './dock-panel-actions';
import type { DockAction } from './pane-dock-chrome';
import { EMPTY_SNAPSHOT, type RecordValue } from './desktop-types';
import { draftModelSelectionFromSnapshot } from './draft-pane-prefs-store';
import { ErrorNotice, errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { InitialSurface } from './InitialSurface';
import { RouteChainEditor, routeChainComplete } from './RouteChainEditor';
import { customProviderDisplayNames, filterConfiguredModels } from './model-catalog';
import { normalizeModelOptions } from './provider-display';
import { record } from './record-utils';
import { defaultSessionLaneStore } from './session-lane-store';
import {
  invalidateSidebarReferenceForMutation,
  loadSidebarReferences,
  useSidebarReferences,
} from './sidebar-reference-cache';
import { agentBodyFromBrief } from './workflow-dialogs';
import { MIXY_DEFAULT_NAME, publishMixyStatus } from './mixy-identity';

export type AgentProfileApi = AgentActionsApi & Partial<Pick<DesktopApi, 'invokeCapability' | 'setModelRoute'>>;

const MODEL_REFERENCE_KEYS = ['quickProviderModels', 'providerSetup'] as const;
const EMPTY_ROUTE: DesktopModelSelection = { provider: '', model: '' };

/** The loaded profile the form starts from and compares against. */
export interface AgentProfile {
  name: string;
  description: string;
  avatar: AgentAvatarValue;
  route: DesktopModelSelection;
  persona: string;
  body: string;
  disabled: boolean;
  /** The stored files' revision; a save sends it back (agents only). */
  revision: string;
}

/** A save refused because the stored agent changed since it was loaded. */
export function isAgentDefinitionConflict(reason: unknown): boolean {
  const code = (reason as { code?: unknown } | null)?.code;
  return code === 'AGENT_DEFINITION_CONFLICT' || /AGENT_DEFINITION_CONFLICT/.test(errorMessageText(reason));
}

/** The editor-relevant fields of a stored route, with its fallback models. */
function routeSelection(value: unknown, leaf = false): DesktopModelSelection {
  const route = record(Array.isArray(value) ? value[0] : value);
  const provider = String(route.provider || '');
  const model = String(route.model || '');
  if (!provider || !model) return EMPTY_ROUTE;
  const fallbacks = !leaf && Array.isArray(route.fallbacks) ? route.fallbacks : [];
  return {
    ...(fallbacks.length ? { fallbacks: fallbacks.map((entry) => routeSelection(entry, true)) } : {}),
    provider,
    model,
    ...(typeof route.effort === 'string' && route.effort ? { effort: route.effort } : {}),
    ...(typeof route.fast === 'boolean' ? { fast: route.fast } : {}),
    ...(route.autoEffort === false ? { autoEffort: false } : {}),
    ...(typeof route.contextPercent === 'number' ? { contextPercent: route.contextPercent } : {}),
    ...(typeof route.contextTokens === 'number' ? { contextTokens: route.contextTokens } : {}),
    ...(route.modelParameters && typeof route.modelParameters === 'object'
      ? { modelParameters: route.modelParameters as Record<string, string> }
      : {}),
  };
}

const sameRoute = (left: DesktopModelSelection, right: DesktopModelSelection) =>
  JSON.stringify(routeSelection(left)) === JSON.stringify(routeSelection(right));

/** The profile per home thread (keyed-read-cache): opening the panel paints
 *  the last loaded one in the first frame and revalidates behind it, sharing
 *  the warm-up's read still in flight. */
const profileCache = createKeyedReadCache<AgentProfile>();

/** Loads `sessionId`'s profile, its connector switches and always-allowed
 *  rows, and the shared model/routine data into the caches before the panel
 *  opens (the bot tab turning active calls this), so the panel paints complete
 *  in its first frame. */
export async function prefetchAgentProfile(api: AgentProfileApi | undefined, sessionId: string): Promise<void> {
  const agentId = agentIdOfHomeSession(sessionId);
  if (!agentId || !api?.invokeCapability) return;
  await Promise.all([
    profileCache.load(sessionId, () => loadProfile(api, agentId, sessionId)).catch(() => undefined),
    loadSidebarReferences(api, [...MODEL_REFERENCE_KEYS, 'channelSetup']),
    prefetchConnectorSwitches(api, 'agent', agentId).catch(() => undefined),
    prefetchAlwaysAllowed(api, agentId).catch(() => undefined),
  ]);
}

async function loadProfile(api: AgentProfileApi | undefined, agentId: string, sessionId: string) {
  if (agentId === MIXY_AGENT_ID) {
    const [persona, body, status] = await Promise.all([
      api?.invokeCapability?.<string>({ capability: 'getLeadPersona', args: [] }),
      api?.invokeCapability?.<string>({ capability: 'getLeadAgentBody', args: [] }),
      api?.invokeCapability?.<RecordValue>({ capability: 'getLeadStatus', args: [] }),
    ]);
    const lead = record(status?.value);
    return {
      name: String(lead.name || '') || MIXY_DEFAULT_NAME,
      description: t('Primary assistant'),
      avatar: agentAvatar(MIXY_AGENT_ID, lead.avatar ?? null),
      // What the Lead actually runs on: its thread's own route, with the
      // fallback models of Mixy's own route (bots/mixy).
      route: {
        ...(draftModelSelectionFromSnapshot(defaultSessionLaneStore.get(sessionId) ?? EMPTY_SNAPSHOT) ?? EMPTY_ROUTE),
        ...(routeSelection(lead.route).fallbacks ? { fallbacks: routeSelection(lead.route).fallbacks } : {}),
      },
      persona: String(persona?.value || ''),
      // agents/lead/AGENT.md: Mixy's 일하는 방식; empty means none.
      body: String(body?.value || ''),
      disabled: false,
      revision: '',
    } satisfies AgentProfile;
  }
  const result = await api?.invokeCapability?.<RecordValue>({ capability: 'getAgentDefinition', args: [agentId] });
  const value = record(result?.value);
  return {
    name: String(value.name || agentId),
    description: String(value.description || ''),
    avatar: agentAvatar(agentId, value.avatar),
    route: routeSelection(value.route),
    persona: String(value.persona || ''),
    body: String(value.body || ''),
    disabled: value.disabled === true,
    revision: String(value.revision || ''),
  } satisfies AgentProfile;
}

export function AgentProfileForm({
  agentId,
  profile,
  models,
  providerNames,
  busy,
  error,
  conflict = false,
  prepareImage,
  onReload,
  onSave,
}: {
  agentId: string;
  profile: AgentProfile;
  models: DesktopModelOption[];
  /** Custom provider names from the provider setup, as the composer picker shows them. */
  providerNames?: Record<string, string>;
  busy: boolean;
  error: string;
  /** The last save was refused: the stored agent changed elsewhere. */
  conflict?: boolean;
  /** Turns a picked file into a state upload (tests stub it). */
  prepareImage?(file: File): Promise<AvatarStateUpload>;
  /** Discard these edits and load the stored profile again. */
  onReload?(): void;
  /** `changes` carries only what differs from `profile`. */
  onSave(changes: RecordValue): void;
}) {
  const mixy = agentId === MIXY_AGENT_ID;
  const loadedMascot = profile.avatar.kind === 'mascot' ? profile.avatar : defaultAgentAvatar(agentId);
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description);
  const [route, setRoute] = useState(profile.route);
  const [persona, setPersona] = useState(profile.persona);
  const [body, setBody] = useState(profile.body);
  const loadedKind = profile.avatar.kind === 'mascot' ? 'mascot' : 'image';
  // 외형 is folded until opened; the pick stays in state either way.
  const [lookOpen, setLookOpen] = useState(false);
  const [avatarKind, setAvatarKind] = useState<'mascot' | 'image'>(loadedKind);
  const [mascot, setMascot] = useState<MascotAvatarValue>(loadedMascot);
  const saved = useMemo(() => customAvatarDraft(profile.avatar), [profile.avatar]);
  const [draft, setDraft] = useState<AvatarStatesDraft>(saved);
  const [previewState, setPreviewState] = useState<AgentAvatarState>('idle');
  const images = useAgentAvatarImages(agentId, profile.avatar);
  const custom = avatarKind === 'image';
  const draftChanged = AGENT_AVATAR_STATES.some((state) => draft[state] !== saved[state]);
  let avatarChanged = profile.avatar.kind !== 'mascot';
  if (custom) avatarChanged = !avatarChanged || draftChanged;
  else if (!avatarChanged) {
    avatarChanged = mascotLook(mascot) !== mascotLook(loadedMascot) || mascot.color !== loadedMascot.color;
  }
  // Mixy's own look (기본 Mixy 모습) is its default: saved as no avatar.
  let avatarChange: RecordValue | null = isSignatureDefault(mascot) ? null : { ...mascot };
  if (custom) avatarChange = customAvatarPayload(draft);
  const changes: RecordValue = {
    ...(name.trim() !== profile.name ? { name: name.trim() } : {}),
    ...(!mixy && description.trim() !== profile.description ? { description: description.trim() } : {}),
    ...(avatarChanged ? { avatar: avatarChange } : {}),
    ...(!sameRoute(route, profile.route) && routeChainComplete(route as unknown as RecordValue) ? { route } : {}),
    ...(persona.trim() !== profile.persona.trim() ? { persona: persona.trim() } : {}),
    ...(body.trim() !== profile.body.trim() ? { body: body.trim() } : {}),
  };
  const dirty = Object.keys(changes).length > 0;
  // 내 이미지 needs its idle image.
  const ready = dirty && Boolean(name.trim()) && !(custom && !draft.idle);
  const reset = () => {
    setName(profile.name);
    setDescription(profile.description);
    setRoute(profile.route);
    setPersona(profile.persona);
    setBody(profile.body);
    setAvatarKind(loadedKind);
    setMascot(loadedMascot);
    setDraft(saved);
    setPreviewState('idle');
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (ready && !busy) onSave(changes);
  };
  let preview = <AgentAvatar agentId={agentId} avatar={profile.avatar} className="agent-profile-avatar" />;
  if (custom && draft.idle) {
    preview = (
      <AvatarDraftPreview draft={draft} images={images} state={previewState} className="agent-profile-avatar" />
    );
  } else if (!custom) preview = <MascotAvatar avatar={mascot} className="agent-profile-avatar" />;
  return (
    <form className="agent-profile-form" onSubmit={submit}>
      <div className="agent-profile-hero">
        <span className="agent-profile-face">
          {preview}
          {mixy && (
            <span className="agent-contact-badge" title={t('Representative bot')}>
              <Star size={10} fill="currentColor" strokeWidth={0} aria-hidden="true" />
            </span>
          )}
        </span>
        <b className="agent-profile-name">{profile.name}</b>
        {profile.description && <p className="agent-profile-description">{profile.description}</p>}
      </div>
      <section className="agent-create-section">
        <button
          type="button"
          className="agent-create-advanced"
          aria-expanded={lookOpen}
          onClick={() => setLookOpen((open) => !open)}
        >
          <span>{t('Appearance')}</span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
        {lookOpen && (
          <div className="agent-profile-face-editor">
            <AgentAvatarSegments custom={custom} disabled={busy} onKind={setAvatarKind} />
            <AgentAvatarChooser
              custom={custom}
              avatar={mascot}
              signature={mixy ? MIXY_AVATAR : undefined}
              disabled={busy}
              prepare={prepareImage}
              draft={draft}
              saved={saved}
              images={images}
              previewState={previewState}
              onPreviewState={setPreviewState}
              onAvatar={setMascot}
              onDraft={setDraft}
              onKind={setAvatarKind}
            />
          </div>
        )}
      </section>
      <section className="agent-create-section">
        <label className="agent-create-field">
          <span>{t('Name')}</span>
          <input
            name="agent-name"
            value={name}
            maxLength={64}
            disabled={busy}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <div className="agent-create-field">
          {/* The same model + fallback chain editor the agent and Lead dialogs use. */}
          <RouteChainEditor
            label={t('Model')}
            models={models}
            providerNames={providerNames}
            route={route as unknown as RecordValue}
            disabled={busy}
            composerParity
            onChange={(next) => setRoute(next as unknown as DesktopModelSelection)}
          />
        </div>
        {!mixy && (
          <label className="agent-create-field">
            <span>{t('What it does')}</span>
            <input
              name="agent-description"
              value={description}
              placeholder={t('e.g. Sum up new issues and PRs every morning')}
              maxLength={160}
              disabled={busy}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </label>
        )}
      </section>
      <section className="agent-create-section">
        <AgentInstructionEditors
          persona={persona}
          body={body}
          disabled={busy}
          mixy={mixy}
          onPersona={setPersona}
          onBody={setBody}
        />
      </section>
      {conflict && (
        <p className="agent-profile-conflict" role="alert">
          {t('Changed elsewhere')} ·{' '}
          <button type="button" disabled={busy} onClick={onReload}>
            {t('Load again')}
          </button>
        </p>
      )}
      {dirty && (
        <footer className="agent-profile-footer">
          {error && <ErrorNotice error={error} />}
          {/* The agent's threads rebuild their prompt for their next turn. */}
          <span className="agent-profile-footer-note">{t('Applies from the next message.')}</span>
          <button type="button" className="secondary" disabled={busy} onClick={reset}>
            {t('Cancel')}
          </button>
          <button type="submit" disabled={busy || !ready}>
            {t('Apply')}
          </button>
        </footer>
      )}
    </form>
  );
}

export function AgentProfilePane({
  sessionId,
  active,
  api = window.mixdogDesktop,
  confirm,
  models: givenModels,
  leafId,
  shown = true,
}: {
  sessionId: string;
  active: boolean;
  /** False while the panel's other tab is in front: the data stays loaded
   *  and the form mounted, only the dock header actions are withheld. */
  shown?: boolean;
  /** The pane whose dock header carries this panel's ⋯ actions. */
  leafId?: string;
  api?: AgentProfileApi;
  confirm?(message: string): boolean;
  /** The model catalog; read from the shared reference cache when absent. */
  models?: DesktopModelOption[];
}) {
  const agentId = agentIdOfHomeSession(sessionId);
  const mixy = agentId === MIXY_AGENT_ID;
  const { values } = useSidebarReferences(api, MODEL_REFERENCE_KEYS, active && !givenModels);
  const cachedModels = useMemo(
    () => filterConfiguredModels(normalizeModelOptions(values.quickProviderModels), values.providerSetup),
    [values.quickProviderModels, values.providerSetup]
  );
  const models = givenModels ?? cachedModels;
  const providerNames = useMemo(() => customProviderDisplayNames(values.providerSetup), [values.providerSetup]);
  // `profile` with the count of loads that produced it: the form restarts
  // from each newly loaded profile, never from a stale one mid-reload.
  const [loaded, setLoaded] = useState<{ profile: AgentProfile; count: number } | null>(() => {
    const cached = profileCache.peek(sessionId);
    return cached ? { profile: cached, count: 1 } : null;
  });
  const profile = loaded?.profile ?? null;
  const [reloads, setReloads] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A save refused because the agent changed elsewhere: the edits stay.
  const [conflict, setConflict] = useState(false);
  const [deletedHere, setDeleted] = useState(false);
  // Deleted here, or anywhere else (the host marks its chat): never a load error.
  const deleted = useDeletedBotSession(sessionId) || deletedHere;
  const restartForm = useRef(false);
  const reload = useCallback(() => {
    restartForm.current = true;
    setConflict(false);
    setError('');
    setReloads((value) => value + 1);
  }, []);
  // The chat's model chip changed this agent's route: show it here too.
  useEffect(
    () =>
      subscribeAgentRouteChange((changed) => {
        if (changed === agentId) reload();
      }),
    [agentId, reload]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloads` re-reads after a save or an action
  useEffect(() => {
    // Loads on mount even while the panel is closed, so opening it is warm.
    if (!agentId || deleted) return undefined;
    let live = true;
    // An activation shares a read in flight (the bot tab's warm-up); an
    // asked-for reload (after a save or an action) reads anew after it.
    const reader = () => loadProfile(api, agentId, sessionId);
    (restartForm.current ? profileCache.refresh(sessionId, reader) : profileCache.load(sessionId, reader))
      .then((next) => {
        // An unchanged silent revalidation keeps the form (and any edits in
        // it); an asked-for reload (reload()) always restarts it.
        const restart = restartForm.current;
        restartForm.current = false;
        if (live)
          setLoaded((current) =>
            !restart && current && JSON.stringify(current.profile) === JSON.stringify(next)
              ? current
              : { profile: next, count: (current?.count ?? 0) + 1 }
          );
      })
      .catch((reason) => {
        if (live) setError(errorMessageText(reason));
      });
    return () => {
      live = false;
    };
  }, [active, agentId, api, sessionId, reloads, deleted]);
  const save = async (changes: RecordValue) => {
    if (!profile) return;
    setBusy(true);
    setError('');
    try {
      if (mixy) {
        const route = changes.route as DesktopModelSelection | undefined;
        if (route) {
          // Mixy's own route (never the Lead's), then this thread from its next turn.
          await api?.invokeCapability?.({ capability: 'setAgentRoute', args: [MIXY_AGENT_ID, route] });
          await api?.setModelRoute?.(route, sessionId);
        }
        if (typeof changes.persona === 'string')
          await api?.invokeCapability?.({ capability: 'saveLeadPersona', args: [changes.persona] });
        if (typeof changes.body === 'string')
          await api?.invokeCapability?.({ capability: 'saveLeadAgentBody', args: [changes.body] });
        if ('name' in changes || 'avatar' in changes) {
          const identity = await api?.invokeCapability?.({
            capability: 'saveLeadIdentity',
            args: [
              {
                ...('name' in changes ? { name: changes.name } : {}),
                ...('avatar' in changes ? { avatar: changes.avatar } : {}),
              },
            ],
          });
          // Every surface naming or drawing Mixy follows (mixy-identity.ts).
          publishMixyStatus(identity?.value);
        }
      } else {
        const name = String(changes.name ?? profile.name);
        const description = String(changes.description ?? profile.description);
        const { route, body, ...rest } = changes;
        await api?.invokeCapability?.({
          capability: 'saveAgentDefinition',
          args: [
            {
              id: agentId,
              // Refused if the agent changed elsewhere since this load.
              expectedRevision: profile.revision,
              name,
              description,
              ...rest,
              // A model change on an agent that is off keeps it off.
              ...(route
                ? { route: { ...(route as RecordValue), ...(profile.disabled ? { disabled: true } : {}) } }
                : {}),
              body: String(body ?? profile.body).trim() || agentBodyFromBrief(name, description),
            },
          ],
        });
        invalidateSidebarReferenceForMutation('saveAgentDefinition');
        // This thread from its next turn, as for Mixy: the chat's model chip shows it.
        if (route) await api?.setModelRoute?.(route as DesktopModelSelection, sessionId);
      }
      reload();
    } catch (reason) {
      if (isAgentDefinitionConflict(reason)) setConflict(true);
      else setError(errorMessageText(reason));
    } finally {
      setBusy(false);
    }
  };
  // 대화 초기화, 끄기/켜기, then 삭제 — in the dock header's ⋯ menu; Mixy has
  // only 대화 초기화.
  const hasProfile = profile !== null;
  const profileName = profile?.name ?? '';
  const profileDisabled = profile?.disabled ?? false;
  const headerActions = useMemo<DockAction[]>(() => {
    if (!hasProfile || deleted) return [];
    const deps = { api, confirm };
    const run = async (action: () => Promise<boolean>) => {
      setBusy(true);
      try {
        if (await action()) reload();
      } finally {
        setBusy(false);
      }
    };
    // 대화 초기화: this chat starts over on the current rules; Mixy has it too.
    const resetChat: DockAction = {
      id: 'agent-reset',
      label: t('Reset conversation'),
      icon: RotateCcw,
      disabled: busy || !api?.resetAgentHome,
      onSelect: () =>
        void run(async () => {
          await resetConversation(deps, {
            scope: `agent:reset:${agentId}`,
            running: Boolean(defaultSessionLaneStore.get(sessionId)?.busy),
            reset: async () => api?.resetAgentHome?.(agentId),
          });
          return false;
        }),
    };
    if (mixy) return [resetChat];
    return [
      resetChat,
      {
        id: 'agent-toggle',
        label: profileDisabled ? t('Turn on') : t('Turn off'),
        icon: Power,
        disabled: busy,
        onSelect: () => void run(() => setAgentOn(deps, agentId, profileDisabled)),
      },
      {
        id: 'agent-delete',
        label: t('Delete'),
        icon: Trash2,
        danger: true,
        separatorBefore: true,
        disabled: busy,
        onSelect: () =>
          void run(async () => {
            if (await deleteAgent(deps, agentId, profileName)) setDeleted(true);
            return false;
          }),
      },
    ];
  }, [hasProfile, mixy, deleted, api, confirm, agentId, sessionId, profileName, profileDisabled, busy, reload]);
  usePublishDockPanelActions(leafId, active && shown, headerActions);
  if (!agentId) return null;
  if (deleted) return <p className="utility-dock-empty">{t('This bot was deleted.')}</p>;
  if (!profile) return error ? <ErrorNotice error={error} /> : <InitialSurface />;
  return (
    <div className="agent-profile">
      <AgentProfileForm
        // Each newly loaded profile (after a save, or a reload) restarts the form.
        key={loaded?.count}
        agentId={agentId}
        profile={profile}
        models={models}
        providerNames={providerNames}
        busy={busy}
        error={error}
        conflict={conflict}
        onReload={reload}
        onSave={(changes) => void save(changes)}
      />
      {agentId === MIXY_AGENT_ID && <HeartbeatSwitch api={api} active={active} />}
      <section className="agent-create-section agent-profile-connectors">
        <h3>{t('Connectors')}</h3>
        <ConnectorSwitchList api={api} kind="agent" target={agentId} active={active} />
      </section>
      <AlwaysAllowedList api={api} agentId={agentId} active={active} />
    </div>
  );
}
