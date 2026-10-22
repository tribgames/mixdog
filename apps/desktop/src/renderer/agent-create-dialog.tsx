// The Agents pane's "+": a face (a mascot and colour, or an uploaded image)
// and a name on top, then the
// model and a one-line job, then 지침 설정 (PERSONA.md and AGENT.md, always
// shown; AGENT.md keeps its default body while left empty). Saves through the same agent-editor path as the Workflows panel.
// In 대표 에이전트 mode (no Mixy yet, mixy-first.tsx) it creates Mixy: the
// name "Mixy" and Mixy's pup (with the star) come prefilled and stay editable;
// it is saved to agents/lead/ and the Main route.
import { Star, X } from 'lucide-react';
import { type FormEvent, useId, useMemo, useState } from 'react';
import type { DesktopModelOption, DesktopModelSelection } from '../shared/contract';
import type { AgentAvatarState } from '../../../../src/runtime/shared/agent-avatar.mjs';
import { BOT_AGENT_KIND } from '../../../../src/runtime/shared/agent-route-config.mjs';
import {
  type AvatarImages,
  MascotAvatar,
  type MascotAvatarValue,
  NEW_AGENT_AVATAR,
  isSignatureDefault,
} from './agent-avatar';
import { type AvatarStateUpload, prepareAgentAvatarImage } from './agent-avatar-image';
import {
  AgentAvatarChooser,
  AgentAvatarSegments,
  AvatarDraftPreview,
  type AvatarStatesDraft,
  customAvatarPayload,
} from './agent-face-editor';
import { greetNewAgent } from './agent-greeting';
import { MIXY_AGENT_ID, MIXY_AVATAR, MIXY_DEFAULT_NAME, createMixy } from './mixy-first';
import { mixyGreetingFacts } from './setup-facts';
import { AgentInstructionEditors } from './agent-instruction-editors';
import { ErrorNotice, errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { ModelRouteEditor } from './ModelRouteEditor';
import { customProviderDisplayNames, filterConfiguredModels } from './model-catalog';
import { showDesktopToast } from './notifications';
import { normalizeModelOptions } from './provider-display';
import { SidebarDialogLayer } from './sidebar-dialog';
import { useSidebarReferences, WORKFLOW_REFERENCE_KEYS } from './sidebar-reference-cache';
import { useSidebarCapabilityRunner } from './use-sidebar-capability-runner';
import { agentBodyFromBrief } from './workflow-dialogs';
import type { RecordValue } from './desktop-types';

const NO_IMAGES: AvatarImages = {};

export function AgentCreateForm({
  models,
  providerNames,
  initialRoute = null,
  busy,
  error = '',
  prepareImage = prepareAgentAvatarImage,
  representative = false,
  onCancel,
  onSave,
}: {
  /** Turns a picked file into a state upload (tests stub it). */
  prepareImage?(file: File): Promise<AvatarStateUpload>;
  models: DesktopModelOption[];
  /** Setup-derived custom provider names (customProviderDisplayNames), keyed by provider id. */
  providerNames?: Record<string, string>;
  /** The composer's current model: the new agent starts on it. */
  initialRoute?: DesktopModelSelection | null;
  /** 대표 에이전트 mode: creates Mixy, starting from its name and face. */
  representative?: boolean;
  busy: boolean;
  error?: string;
  onCancel(): void;
  onSave(payload: RecordValue): void;
}) {
  const titleId = useId();
  const [avatar, setAvatar] = useState<MascotAvatarValue>(representative ? MIXY_AVATAR : NEW_AGENT_AVATAR);
  // The one literal "Mixy": the representative's default name.
  const [name, setName] = useState(representative ? MIXY_DEFAULT_NAME : '');
  const [route, setRoute] = useState<DesktopModelSelection>(() => initialRoute ?? { provider: '', model: '' });
  const [description, setDescription] = useState(() => (representative ? t('Primary assistant') : ''));
  const [body, setBody] = useState('');
  const [persona, setPersona] = useState('');
  // 마스코트 = a mascot; 내 이미지 = own images per motion state.
  const [avatarKind, setAvatarKind] = useState<'mascot' | 'image'>('mascot');
  const [draft, setDraft] = useState<AvatarStatesDraft>({});
  const [previewState, setPreviewState] = useState<AgentAvatarState>('idle');
  const custom = avatarKind === 'image';
  // A bot without a model could not take a turn (nothing is auto-picked): with
  // models to choose from, the dialog does not save without one.
  const modelChosen = Boolean(route.provider && route.model);
  const ready = Boolean(name.trim() && (!custom || draft.idle) && (modelChosen || models.length === 0));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || busy) return;
    if (representative) {
      // Mixy keeps the runtime's own instructions unless 일하는 방식 is written,
      // and its own look unless images are given.
      onSave({
        name: name.trim(),
        ...(custom ? { avatar: customAvatarPayload(draft) } : {}),
        ...(!custom && !isSignatureDefault(avatar) ? { avatar } : {}),
        description: description.trim(),
        ...(modelChosen ? { route } : {}),
        ...(persona.trim() ? { persona: persona.trim() } : {}),
        ...(body.trim() ? { body: body.trim() } : {}),
      });
      return;
    }
    onSave({
      name: name.trim(),
      description: description.trim(),
      avatar: custom ? customAvatarPayload(draft) : avatar,
      ...(modelChosen ? { route } : {}),
      ...(persona.trim() ? { persona: persona.trim() } : {}),
      body: body.trim() || agentBodyFromBrief(name, description),
    });
  };
  return (
    <SidebarDialogLayer onClose={onCancel}>
      <section
        className="schedules-dialog agent-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <h2 id={titleId}>{representative ? t('Create representative bot') : t('New bot')}</h2>
          <div className="schedules-dialog-header-actions">
            <button type="button" aria-label={t('Close')} onClick={onCancel}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>
        <form onSubmit={submit}>
          <div className="agent-create-body">
            <div className="agent-create-hero">
              <span className="mixy-create-face">
                {custom && draft.idle ? (
                  <AvatarDraftPreview
                    draft={draft}
                    images={NO_IMAGES}
                    state={previewState}
                    className="agent-create-preview"
                  />
                ) : (
                  <MascotAvatar avatar={avatar} className="agent-create-preview" />
                )}
                {representative && (
                  <span className="agent-contact-badge" title={t('Representative bot')}>
                    <Star size={12} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                  </span>
                )}
              </span>
              <input
                className="agent-create-name"
                name="agent-name"
                value={name}
                placeholder={t('Enter a name')}
                aria-label={t('Bot name')}
                // biome-ignore lint/a11y/noAutofocus: the name is the one required field of a new agent
                autoFocus
                maxLength={64}
                disabled={busy}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              <AgentAvatarSegments custom={custom} disabled={busy} onKind={setAvatarKind} />
            </div>
            <AgentAvatarChooser
              custom={custom}
              avatar={avatar}
              signature={representative ? MIXY_AVATAR : undefined}
              disabled={busy}
              prepare={prepareImage}
              draft={draft}
              previewState={previewState}
              onPreviewState={setPreviewState}
              onAvatar={setAvatar}
              onDraft={setDraft}
              onKind={setAvatarKind}
            />
            <section className="agent-create-section">
              <div className="agent-create-field">
                <span>{t('Model')}</span>
                <ModelRouteEditor
                  ariaLabel={t('Model')}
                  models={models}
                  providerNames={providerNames}
                  value={route}
                  disabled={busy}
                  composerParity
                  onChange={setRoute}
                />
              </div>
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
            </section>
            <section className="agent-create-section">
              <span className="agent-avatar-row-label">{t('Instruction settings')}</span>
              <AgentInstructionEditors
                persona={persona}
                body={body}
                disabled={busy}
                onPersona={setPersona}
                onBody={setBody}
              />
            </section>
          </div>
          <footer>
            {error && <ErrorNotice error={error} />}
            <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
              {t('Cancel')}
            </button>
            <button type="submit" disabled={busy || !ready}>
              {t('Create')}
            </button>
          </footer>
        </form>
      </section>
    </SidebarDialogLayer>
  );
}

export function AgentCreateDialog({
  onClose,
  onCreated,
  initialRoute = null,
  representative = false,
}: {
  onClose(): void;
  /** The new agent's home thread, opened with its greeting turn running. */
  onCreated?(sessionId: string, name: string): void;
  initialRoute?: DesktopModelSelection | null;
  /** 대표 에이전트 mode (mixy-first.tsx): creates Mixy. */
  representative?: boolean;
}) {
  const api = window.mixdogDesktop;
  const { values, completeMutation } = useSidebarReferences(api, WORKFLOW_REFERENCE_KEYS, true);
  const models = useMemo(
    () => filterConfiguredModels(normalizeModelOptions(values.quickProviderModels), values.providerSetup),
    [values.quickProviderModels, values.providerSetup]
  );
  const providerNames = useMemo(() => customProviderDisplayNames(values.providerSetup), [values.providerSetup]);
  const { pending, error, setError, run }= useSidebarCapabilityRunner({
    api,
    completeMutation,
    toastScope: 'workflow',
  });
  const save = async (payload: RecordValue) => {
    const name = String(payload.name || '');
    const description = String(payload.description || '');
    let id = '';
    if (representative) {
      if (!(await createMixy(run, payload))) return;
      id = MIXY_AGENT_ID;
    } else {
      // A bot for good: the marker is written once, at creation (isContactAgentId).
      const saved = await run('saveAgentDefinition', [{ ...payload, kind: BOT_AGENT_KIND }]);
      if (saved === undefined) return;
      id = String((saved as RecordValue | null)?.id || '');
    }
    onClose();
    // The new agent greets the user in its home thread.
    if (!id || !api) return;
    try {
      // The representative's greeting is the welcome guide: it gets the setup facts.
      const facts = representative ? await mixyGreetingFacts(api) : undefined;
      // Without a model the greeting turn would only fail: the thread opens
      // quiet and the user chooses a model in it.
      const sessionId = await greetNewAgent(api, {
        id,
        name,
        description,
        mixy: representative,
        facts,
        greet: Boolean(payload.route),
      });
      if (sessionId) onCreated?.(sessionId, name);
    } catch (reason) {
      showDesktopToast(errorMessageText(reason), 'error');
    }
  };
  return (
    <AgentCreateForm
      models={models}
      providerNames={providerNames}
      initialRoute={initialRoute}
      representative={representative}
      busy={Boolean(pending)}
      error={error}
      onCancel={() => {
        setError('');
        onClose();
      }}
      onSave={(payload) => void save(payload)}
    />
  );
}
