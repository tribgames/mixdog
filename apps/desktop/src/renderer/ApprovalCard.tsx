import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  MIXY_AGENT_ID,
  agentHomeSessionId,
} from '../shared/core-src/runtime/agent/orchestrator/session/agent-home.mjs';
import type { DesktopBrowserLoginStatus, ToolApprovalDecision } from '../shared/contract';
import { SECRET_SAVE_SUFFIX, SECRET_USERNAME_SUFFIX } from '../shared/secret-slots';
import { agentHomeTitle } from './agent-contacts-model';
import { browserPageRequestsAvailable, requestBrowserImport, revealBrowserPane } from './browser-page-request';
import { showBrowserPage } from './browser-page-view';
import { isMobileRemoteSurface } from './mobile-surface';
import { openRemoteScreen, remoteScreenAvailable } from './remote-screen-request';
import { holdBrowserTakeover } from './browser-takeover-input';
import { MarkdownSessionContext } from './MarkdownLink';
import type { Approval, TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';
import { useDesktopStatus } from './settings/use-desktop-status';
import {
  type ApprovalButton,
  ApprovalPreviewRow,
  ApprovalPrompt,
  clock,
  noteApprovalDecision,
} from './approval-prompt';
import { PixelIcon, type PixelIconName } from './pixel-icon';
import { carriedLatest } from './list-carry';
import { asRecord } from './text-format';
import { ownedFocus } from './own-scroll-writes';
import {
  type CardRow,
  actionLabel,
  approvalCardModel,
  approvalChainLabel,
  approvalDeadline,
  connectorServiceLabel,
  mailAccountNote,
  amountText,
  sizeText,
  toolActionNoun,
  actionQuestion,
  approvalCardRows,
  connectorChangeText,
} from './approval-card-model';
import { useRemoteHostImageUrl } from './local-image-preview';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { useSidebarReferences } from './sidebar-reference-cache';
import { useSurfaceActive } from './surface-activity';
import { useConversationReleaseHold } from './conversation-release';
import { useSessionTitle } from './session-glance-store';
import { approvalAllowIsPointerOnly, type PermissionScope, permissionChoices } from '../shared/approval-enter-rule';

export {
  actionLabel,
  actionQuestion,
  alwaysAllowScope,
  approvalCardModel,
  approvalCardRows,
  approvalChainLabel,
  approvalReasonText,
  connectorToolLabel,
  sessionAllowScope,
} from './approval-card-model';

function localPreviewUrl(path: unknown): string {
  const value = String(path || '').replace(/\\/g, '/');
  return value ? `file:///${encodeURI(value).replace(/^\/+/, '')}` : '';
}

// Desktop shows the host file directly; a paired browser has no access to the
// host disk, so it reads the image through the remote preview lane instead.
function ApprovalPreviewImage({ path, alt }: { path: unknown; alt: string }) {
  const remoteUrl = useRemoteHostImageUrl(String(path || ''));
  const src = isRemoteHostRenderer() ? remoteUrl : localPreviewUrl(path);
  return <img src={src || undefined} alt={alt} />;
}

const AGENT_KEYS = ['agents'] as const;

const desktopApi = () => (typeof window === 'undefined' ? undefined : window.mixdogDesktop);

/** The "save sign-ins typed in chat" setting (`saveChatLogins`, on unless
 *  set off): the default of a sign-in card's save box. `null` while the
 *  stored value is unknown (not loaded yet, or its read failed): the box is
 *  not offered and nothing is saved until the setting arrives, which every
 *  settings announcement reads again. */
function useSaveChatLogins(enabled: boolean): boolean | null {
  const api = desktopApi();
  const settings = useDesktopStatus(api, 'settings', enabled);
  return settings ? settings.saveChatLogins !== false : null;
}

/** An agent's display name (its home tab title); its id until the catalog has it. */
function useAgentName(agentId: string): string {
  const api = desktopApi();
  const { values } = useSidebarReferences(api, AGENT_KEYS, Boolean(agentId));
  return agentHomeTitle(agentHomeSessionId(agentId) || '', values.agents) || agentId;
}

/** Who the card names as the requester. A bot's chat (agent mode) names the bot,
 *  Mixy included; a coding session is the Lead's (the runtime tags it 'lead'), so
 *  it goes unnamed in the head and reads "Lead" in the remember row. Any other
 *  agent the request names is still named. A sub-agent's request names its
 *  chain from the top-level chat down ("사무관 › Worker", "Lead › Reviewer"),
 *  wherever the card shows. */
export function useRequester(
  approval: Approval,
  agentMode: boolean
): { agentName: string; headAgent: string; faceAgentId: string } {
  const agentId = String(approval.agentId || '');
  const named = agentMode || (agentId !== '' && agentId !== MIXY_AGENT_ID);
  const name = useAgentName(agentId || MIXY_AGENT_ID);
  // The face is the bot's own; a coding session's Lead shows the LEAD mark.
  const faceAgentId = named ? agentId || MIXY_AGENT_ID : '';
  const requester = named
    ? { agentName: name, headAgent: name, faceAgentId }
    : { agentName: t('Lead'), headAgent: '', faceAgentId };
  const chain = approvalChainLabel(approval.chain);
  return chain ? { ...requester, headAgent: chain } : requester;
}

function approvalHandoffTarget(
  approval: Approval,
  hostSessionId: string
): { sessionId: string; title: string; agentId: string } | null {
  const handoff = asRecord(approval.handoff);
  const sessionId = String(approval.sessionId || '');
  if (!handoff || !sessionId || sessionId === hostSessionId) return null;
  return { sessionId, title: String(handoff.title || ''), agentId: String(handoff.agentId || '') };
}

function useHandoffChip(target: ReturnType<typeof approvalHandoffTarget>): { name: string; agentId?: string } | null {
  const title = useSessionTitle(target?.sessionId ?? '', target?.title || t('Session'));
  const bot = useAgentName(target?.agentId ?? '');
  if (!target) return null;
  return target.agentId ? { name: bot, agentId: target.agentId } : { name: title };
}

function useOwnerChip(
  approval: Approval,
  hostSessionId: string,
  chain: string
): { name: string; agentId?: string } | null {
  const sessionId = String(approval.sessionId || '');
  const shownIn = hostSessionId || String(approval.surfaceSessionId || '') || sessionId;
  const differs = Boolean(sessionId) && shownIn !== sessionId;
  const handoffChip = useHandoffChip(differs ? approvalHandoffTarget(approval, shownIn) : null);
  const title = useSessionTitle(differs ? sessionId : '', t('Session'));
  if (!differs) return null;
  return handoffChip ?? { name: chain || title };
}

// ✕ ("decide later") and a takeover's readiness outlive a remount (a
// virtualized row scrolled away and back) for as long as the request is pending.
const laterIds = new Set<string>();
const controlReadyIds = new Set<string>();

function ApprovalPendingChip({ label, agentMode, onOpen }: { label: string; agentMode: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="question-chip"
      data-agent-mode={agentMode || undefined}
      aria-label={t('Open approval')}
      onClick={onOpen}
    >
      <NeedGlyph />
      <span>{t('Approval pending · {{action}}', { action: label })}</span>
      <span className="question-chip-open">{t('Open')}</span>
    </button>
  );
}

function NeedGlyph() {
  return (
    <svg className="question-need" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2.6" />
      <circle cx="12" cy="12" r="3.3" fill="currentColor" />
    </svg>
  );
}

/** A takeover starts only once this PC reports the agent stopped (takeover-gate.ts);
 *  a client without that boundary (a paired phone) has nothing to wait for. */
function useControlReady(id: string, sessionId: string, takeover: boolean): boolean {
  const awaits = takeover && Boolean(sessionId && window.mixdogDesktop?.takeoverReady);
  const [ready, setReady] = useState(() => !awaits || controlReadyIds.has(id));
  useEffect(() => {
    if (ready || !awaits) return;
    let live = true;
    void Promise.resolve(window.mixdogDesktop?.takeoverReady?.(sessionId, id)).then((value) => {
      if (!value || !live) return;
      controlReadyIds.add(id);
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, [ready, awaits, sessionId, id]);
  return ready;
}

type ApprovalCardProps = {
  approval: Approval;
  /** true: recorded; false: another device already answered (the rows stay
   *  disabled until the request leaves the snapshot). */
  resolve: (decision: ToolApprovalDecision) => Promise<unknown>;
  /** Agent mode: the card narrows to the bubble column with QuestionCard. */
  agentMode?: boolean;
  /** Answered on another device: shown disabled with who answered. */
  settled?: { approved: boolean; device: string } | null;
  /** The corner text (a held request: its run and the time left). */
  meta?: string;
  /** "1/2" when more requests wait behind this one. */
  queue?: string;
  /** The chat showing the card: no "세션 열기" to the chat it is already in. */
  hostSessionId?: string;
};

/** The pending human decision of the session, in QuestionCard's place. A
 *  login takeover is the sign-in card; everything else the approval card. */
export function ApprovalCard(props: ApprovalCardProps) {
  const login = approvalCardModel(props.approval).login;
  return login ? <BrowserLoginCard {...props} site={login.site} /> : <ToolApprovalCard {...props} />;
}

// How each login takeover's window last ended, across remounts of its card.
const loginStatuses = new Map<string, DesktopBrowserLoginStatus>();

type LoginRow = { label: string; action: 'open' | 'fill' | 'reimport' | 'cancel'; disabled?: boolean };

/** The sign-in takeover's buttons and heading for where its window stands. */
function loginCardView({
  local,
  choosing,
  settled,
  status,
  picked,
  controlReady,
  site,
}: {
  local: boolean;
  choosing: boolean;
  settled: ApprovalCardProps['settled'];
  status: DesktopBrowserLoginStatus;
  picked: string;
  controlReady: boolean;
  site: string;
}): { rows: LoginRow[]; title: string } {
  const state = status.state;
  const cancel: LoginRow = { label: choosing ? t('Not now') : t('Cancel'), action: 'cancel' };
  let rows: LoginRow[] = [];
  if (!local) {
    // A phone: the sign-in happens on the PC, but the takeover can end here.
    rows = settled ? [] : [cancel];
  } else if (choosing) {
    // Until the agent has stopped, nothing that opens or fills the page can be chosen.
    const yourself: LoginRow = { label: t('Sign in yourself'), action: 'open', disabled: !controlReady };
    rows = picked
      ? [{ label: t('Sign in with this account'), action: 'fill', disabled: !controlReady }, yourself, cancel]
      : [yourself, cancel];
  } else if (!settled && (state === 'idle' || state === 'closed')) {
    const label = state === 'closed' ? t('Sign in again…') : t('Sign in…');
    rows = [{ label, action: 'open', disabled: !controlReady }, cancel];
  } else if (!settled && state === 'refused') {
    rows = [{ label: t('Import again from Chrome'), action: 'reimport' }, cancel];
  }
  let title = t('{{site}} sign-in required', { site });
  if (!local) {
    title = t('Sign in on your PC');
  } else if (state === 'done' || settled?.approved) {
    title = t('Signed in');
  } else if (state === 'closed') {
    title = t('Not signed in');
  } else if (state === 'refused') {
    title = t('{{site}} does not allow sign-in in this window', { site: status.provider || site });
  }
  return { rows, title };
}

function BrowserLoginCard({
  approval,
  resolve,
  agentMode = false,
  settled = null,
  site,
  hostSessionId = '',
}: ApprovalCardProps & { site: string }) {
  const id = String(approval.id ?? '');
  const browserSessionId = useContext(MarkdownSessionContext);
  const sessionId = String(approval.sessionId || browserSessionId || '');
  const { faceAgentId } = useRequester(approval, agentMode);
  const owner = useOwnerChip(approval, hostSessionId, approvalChainLabel(approval.chain));
  const model = approvalCardModel(approval);
  // Saved logins are offered only with the page they may be filled into.
  const accounts = model.fillId ? model.accounts : [];
  // The picked saved login ('' = 다른 계정 입력: sign in by hand).
  const [picked, setPicked] = useState(() => accounts[0]?.id ?? '');
  const api = desktopApi();
  const local = Boolean(sessionId && api?.browserLoginOpen);
  const controlReady = useControlReady(id, sessionId, local && !settled);
  const [status, setStatus] = useState<DesktopBrowserLoginStatus>(() => loginStatuses.get(id) ?? { state: 'idle' });
  const [later, setLater] = useState(() => laterIds.has(id));
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const follow = (pending: Promise<DesktopBrowserLoginStatus> | undefined) => {
    setError('');
    setStatus({ state: 'open' });
    void Promise.resolve(pending).then(
      (next) => {
        if (next?.state && next.state !== 'unavailable') loginStatuses.set(id, next);
        if (!mounted.current) return;
        if (!next || next.state === 'unavailable') {
          setStatus({ state: 'idle' });
          setError(t('The sign-in window could not open.'));
          return;
        }
        setStatus(next);
      },
      (reason) => {
        if (!mounted.current) return;
        setStatus({ state: 'idle' });
        setError(reason instanceof Error ? reason.message : t('The sign-in window could not open.'));
      }
    );
  };
  // A remounted card picks its window up again where it is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: asks once per takeover
  useEffect(() => {
    if (!local || !api?.browserLoginStatus) return;
    void api.browserLoginStatus(sessionId, id).then((current) => {
      if (!mounted.current || !current || current.state === 'unavailable') return;
      if (current.state === 'open') follow(api.browserLoginOpen?.(sessionId, id));
      else setStatus(current);
    });
  }, [local, sessionId, id]);

  const state = status.state;
  const choosing = local && !settled && (state === 'idle' || state === 'closed') && accounts.length > 0;
  const { rows, title } = loginCardView({ local, choosing, settled, status, picked, controlReady, site });
  const done = local && (state === 'done' || Boolean(settled?.approved));
  const closable = local && !done && state !== 'open';

  const settle = (decision: ToolApprovalDecision) =>
    resolve(decision).then(
      (accepted) => {
        if (typeof accepted === 'boolean' || !mounted.current) return;
        setResolving(false);
        setError(t('This decision could not be saved. Please try again.'));
      },
      (reason) => {
        if (!mounted.current) return;
        setResolving(false);
        setError(
          t('This decision could not be saved: {{detail}}', {
            detail: reason instanceof Error ? reason.message : String(reason || ''),
          })
        );
      }
    );
  const activate = (row: LoginRow) => {
    if (row.disabled || resolving || settled) return;
    noteApprovalDecision();
    if (row.action === 'open') {
      follow(api?.browserLoginOpen?.(sessionId, id));
      return;
    }
    if (row.action === 'reimport') {
      requestBrowserImport(browserSessionId);
      return;
    }
    setResolving(true);
    setError('');
    if (row.action === 'fill') {
      const refused = (pageChanged: boolean) => {
        if (!mounted.current) return;
        setResolving(false);
        setError(
          pageChanged
            ? t('The sign-in page changed, so the saved login was not filled.')
            : t('The saved login could not be filled on this page.')
        );
      };
      void Promise.resolve(api?.browserCredentialFill?.(sessionId, picked, model.fillId)).then(
        (filled) => {
          if (filled?.passwordFilled) return void settle({ approved: true, response: 'done', reason: 'saved_login' });
          // A two-step sign-in's username step: the username is in, the
          // takeover stays open for the user to advance and pick the login again.
          if (filled?.usernameFilled) return void (mounted.current && setResolving(false));
          refused(filled?.reason === 'page-changed');
        },
        () => refused(false)
      );
      return;
    }
    void settle({ approved: false });
  };
  const decideLater = () => {
    laterIds.add(id);
    setLater(true);
  };
  if (later && closable) {
    const reopen = () => {
      laterIds.delete(id);
      setLater(false);
    };
    return <ApprovalPendingChip label={title} agentMode={agentMode} onOpen={reopen} />;
  }
  // Cancel on the left, the step forward (fill, sign in, import) as the primary.
  const buttons: ApprovalButton[] = [...rows].reverse().map((row) => ({
    label: row.label,
    tone: row === rows[0] && row.action !== 'cancel' ? 'primary' : undefined,
    disabled: row.disabled,
    onClick: () => activate(row),
  }));
  const radioName = `approval-account-${id}`;
  const preview = choosing ? (
    <>
      <div className="approval-accounts" role="radiogroup" aria-label={t('Saved logins')}>
        {[...accounts, { id: '', label: t('Use another account') }].map((account) => (
          <label
            key={account.id || 'other'}
            className="approval-account"
            data-selected={picked === account.id || undefined}
          >
            <input
              type="radio"
              name={radioName}
              value={account.id}
              checked={picked === account.id}
              disabled={resolving}
              onChange={() => setPicked(account.id)}
            />
            <span className="approval-account-label">{account.label}</span>
          </label>
        ))}
      </div>
      <small className="approval-lock-line">{t('The agent never sees the password.')}</small>
    </>
  ) : undefined;
  return (
    <ApprovalPrompt
      title={title}
      faceAgentId={faceAgentId}
      tone={done ? 'done' : 'need'}
      requester=""
      target={owner}
      preview={preview}
      buttons={buttons}
      focus="primary"
      enterAllows
      onClose={closable ? decideLater : undefined}
      status={done ? site : undefined}
      error={error}
      busy={resolving}
      kind="login"
      agentMode={agentMode}
      data={{ 'data-login': local ? state : 'remote' }}
    >
      {!local && !settled && <ProgressSpinner size={14} aria-hidden="true" />}
    </ApprovalPrompt>
  );
}

/** The preview row's pixel icon for an action kind. */
function actionIcon(action: string, outbound: boolean): PixelIconName {
  if (['email', 'message', 'trash'].includes(action)) return 'mail';
  if (action === 'payment') return 'card';
  if (action === 'delete') return 'alert';
  return outbound && action !== 'form' ? 'globe' : 'form';
}

type ApprovalModel = ReturnType<typeof approvalCardModel>;

/** The settled line once another device answered; undefined while unanswered. */
function approvalSettledStatus(kind: ApprovalModel['kind'], settled: ApprovalCardProps['settled']): string | undefined {
  if (!settled) return undefined;
  const device = settled.device;
  if (kind === 'takeover') {
    return settled.approved ? t('Done on {{device}}', { device }) : t('Cancelled on {{device}}', { device });
  }
  return settled.approved ? t('Allowed from {{device}}', { device }) : t('Denied from {{device}}', { device });
}

/** What the action is about: a payment's amount, a deletion's size, the mails
 *  a trash moves, an email's fields, else the target; null when none applies. */
function approvalActionBody(model: ApprovalModel, icon: ReactNode): ReactNode {
  if (model.action === 'payment') {
    return (
      <div className="approval-amount">
        <b>{amountText(model.details)}</b>
        <small>{[model.target, model.details.currency, model.details.recurrence].filter(Boolean).join(' · ')}</small>
      </div>
    );
  }
  if (model.action === 'delete') {
    return (
      <div className="approval-amount">
        <b>
          {[t('{{n}} items', { n: model.details.count || '1' }), sizeText(model.details.size)]
            .filter(Boolean)
            .join(' · ')}
        </b>
        <small>{[model.target, t('Skips the trash and cannot be undone')].filter(Boolean).join(' · ')}</small>
      </div>
    );
  }
  if (model.action === 'trash' && model.details.messages) {
    return (
      <>
        {model.details.messages.split('\n').map((line) => (
          <ApprovalPreviewRow key={line} icon={icon} main={line} />
        ))}
        {model.details.more && (
          <small className="approval-preview-more">{t('and {{n}} more', { n: model.details.more })}</small>
        )}
        {model.account && (
          <small className="approval-preview-more">{t('Mail in {{account}}', { account: model.account })}</small>
        )}
      </>
    );
  }
  if (model.action === 'email') {
    return (
      <>
        <ApprovalPreviewRow
          icon={icon}
          main={model.details.to || model.target}
          sub={model.account ? t('Sent as {{account}}', { account: model.account }) : undefined}
        />
        <dl className="approval-fields">
          {(
            [
              [t('To'), model.details.to],
              [t('Cc'), model.details.cc],
              [t('Subject'), model.details.subject],
            ] as const
          )
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
        </dl>
      </>
    );
  }
  if (model.target) {
    return <ApprovalPreviewRow icon={icon} main={model.target} sub={mailAccountNote(model.action, model.account)} />;
  }
  return null;
}

/** The editable text an outbound action sends, with the way back to the original. */
function ApprovalTextEditor({
  text,
  payload,
  disabled,
  onChange,
}: {
  text: string;
  payload: string;
  disabled: boolean;
  onChange(text: string): void;
}) {
  const edited = text !== payload;
  return (
    <div className="approval-edit" data-edited={edited || undefined}>
      <textarea
        value={text}
        maxLength={40_000}
        rows={2}
        disabled={disabled}
        aria-label={t('Text to send, editable')}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="approval-edit-row">
        <span className="approval-hint">
          {edited ? t('Edited · the edited text is sent') : t('Click the text to edit it')}
        </span>
        {edited && (
          <button type="button" className="approval-link" disabled={disabled} onClick={() => onChange(payload)}>
            {t('Back to original')}
          </button>
        )}
      </div>
    </div>
  );
}

/** An office transaction's fields (document, transaction, change counts,
 *  preview output, visual diff) and up to four preview pages. */
function OfficeApprovalDetails({ args }: { args: Record<string, unknown> | null | undefined }) {
  const transaction = asRecord(args?.transaction);
  const diff = asRecord(transaction?.diff);
  const summary = asRecord(diff?.summary);
  const preview = asRecord(args?.preview);
  const visualDiff = asRecord(preview?.visualDiff);
  const previewImages = [
    ...(Array.isArray(preview?.images) ? preview.images : []),
    ...(Array.isArray(visualDiff?.images) ? visualDiff.images : []),
  ]
    .map(asRecord)
    .filter((image): image is Record<string, unknown> => Boolean(image?.path))
    .slice(0, 4);
  return (
    <>
      <dl className="approval-fields">
        {Boolean(args?.document) && (
          <div>
            <dt>{t('Document')}</dt>
            <dd>
              <code>{String(args?.document)}</code>
            </dd>
          </div>
        )}
        {Boolean(transaction?.id) && (
          <div>
            <dt>{t('Transaction')}</dt>
            <dd>
              <code>{String(transaction?.id)}</code>
            </dd>
          </div>
        )}
        {summary && (
          <div>
            <dt>{t('Changes')}</dt>
            <dd>
              {t('{{total}} paths · +{{added}} −{{removed}} ~{{modified}}', {
                total: Number(summary.total || 0),
                added: Number(summary.added || 0),
                removed: Number(summary.removed || 0),
                modified: Number(summary.modified || 0),
              })}
            </dd>
          </div>
        )}
        {Boolean(preview?.output) && (
          <div>
            <dt>{t('Preview')}</dt>
            <dd>
              <code>{String(preview?.output)}</code>
            </dd>
          </div>
        )}
        {visualDiff?.available === true && (
          <div>
            <dt>{t('Visual diff')}</dt>
            <dd>{t('{{percent}}% changed pixels', { percent: Number(visualDiff.changedPercent || 0) })}</dd>
          </div>
        )}
      </dl>
      {previewImages.length > 0 && (
        // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the preview strip is a plain container labelled for assistive tech
        <div className="office-approval-preview" aria-label={t('Document preview')}>
          {previewImages.map((image, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: preview pages are positional and never reorder
            <figure key={`${String(image.path)}:${index}`}>
              <ApprovalPreviewImage
                path={image.path}
                alt={
                  image.kind === 'visual-diff'
                    ? t('Visual diff page {{page}}', { page: Number(image.page || index + 1) })
                    : t('Preview page {{page}}', { page: Number(image.page || index + 1) })
                }
              />
              <figcaption>{image.kind === 'visual-diff' ? t('Visual diff') : t('Preview')}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </>
  );
}

function SecretFields({
  form,
  length,
  filled,
  save,
  disabled,
  secretRef,
  usernameRef,
  onFilled,
  onSave,
  onSubmit,
}: {
  form: string;
  length: number;
  /** How many code characters are typed (a count, no characters). */
  filled: number;
  /** `null` while the save default is unknown: no box is offered. */
  save: boolean | null;
  disabled: boolean;
  secretRef: Ref<HTMLInputElement>;
  usernameRef: Ref<HTMLInputElement>;
  onFilled(count: number): void;
  onSave(value: boolean): void;
  /** Enter what the fields hold (read from them by the card). */
  onSubmit(): void;
}) {
  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onSubmit();
  };
  const lock = <small className="approval-lock-line">{t('The agent never sees this.')}</small>;
  if (form === 'otp') {
    // Typing or a paste: the field keeps only the code's characters, the
    // boxes learn how many, and a full code is entered at once.
    const accept = (field: HTMLInputElement) => {
      const code = field.value.replace(/[^0-9A-Za-z]/g, '').slice(0, length);
      if (code !== field.value) field.value = code;
      onFilled(code.length);
      if (code.length === length) onSubmit();
    };
    const current = Math.min(filled, length - 1);
    return (
      <>
        <label className="approval-otp" data-long={length > 6 || undefined}>
          <input
            ref={secretRef}
            className="approval-otp-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={length * 2}
            disabled={disabled}
            aria-label={t('Verification code')}
            spellCheck={false}
            onInput={(event) => accept(event.currentTarget)}
            onKeyDown={submitOnEnter}
          />
          {Array.from({ length }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one box per position
            <Fragment key={index}>
              {index === Math.ceil(length / 2) && <span className="approval-otp-sep" aria-hidden="true" />}
              <span
                className="approval-otp-box"
                data-filled={index < filled || undefined}
                data-current={index === current || undefined}
                aria-hidden="true"
              />
            </Fragment>
          ))}
        </label>
        {lock}
      </>
    );
  }
  const password = (
    <input
      ref={secretRef}
      className="approval-secret"
      type="password"
      maxLength={4_096}
      disabled={disabled}
      aria-label={form === 'login' ? t('Password') : t('Secret value')}
      autoComplete="off"
      spellCheck={false}
      onKeyDown={submitOnEnter}
    />
  );
  if (form !== 'login') {
    return (
      <>
        {password}
        {lock}
      </>
    );
  }
  return (
    <>
      <label className="approval-field">
        <span className="approval-field-label">{t('Username')}</span>
        <input
          ref={usernameRef}
          className="approval-secret"
          type="text"
          maxLength={4_096}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onKeyDown={submitOnEnter}
        />
      </label>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: `password` is the password input, built above */}
      <label className="approval-field">
        <span className="approval-field-label">{t('Password')}</span>
        {password}
      </label>
      {save !== null && (
        <label className="approval-check">
          <input
            type="checkbox"
            checked={save}
            disabled={disabled}
            onChange={(event) => onSave(event.target.checked)}
          />
          <span>{t("Save as this site's login")}</span>
        </label>
      )}
      {lock}
    </>
  );
}

/** The card's buttons in reading order: the full-width rows, deny, the choices, then the primary. */
function cardButtons(
  rows: CardRow[],
  {
    clickOnly,
    permission,
    activate,
  }: { clickOnly: boolean; permission: ReturnType<typeof permissionChoices>; activate: (row: CardRow) => void }
): { buttons: ApprovalButton[]; denyDecision: CardRow['decision'] | undefined } {
  const denyRow = rows.find(
    (row) =>
      typeof row.decision === 'object' &&
      row.decision.approved === false &&
      (!row.decision.response || (row.decision.response === 'skip' && !row.decision.reason))
  );
  const [primary, ...others] = rows;
  const isAlways = (row: CardRow) => {
    const decision = typeof row.decision === 'object' ? row.decision : null;
    return (
      decision?.remember === 'agent' ||
      decision?.remember === 'always' ||
      decision?.remember === 'session' ||
      (Boolean(decision?.scope) && decision?.scope === permission.always?.id)
    );
  };
  const toButton = (row: CardRow, tone?: ApprovalButton['tone']): ApprovalButton => ({
    label: row.label,
    tone,
    disabled: row.disabled,
    hint: row.desc,
    always: isAlways(row) || undefined,
    onClick: () => activate(row),
  });
  const denyButton = denyRow && denyRow !== primary ? [{ ...toButton(denyRow), deny: true }] : [];
  const primaryButton: ApprovalButton = clickOnly
    ? { ...toButton(primary, 'primary'), hint: t('Allowing takes a click; Enter does not allow.') }
    : toButton(primary, 'primary');
  const ownRow = (row: CardRow) => row.decision === 'open' || row.decision === 'reimport';
  const rowButtons = ['open', 'reimport'].flatMap((decision) =>
    others.filter((row) => row.decision === decision).map((row) => ({ ...toButton(row), wide: true }))
  );
  const choices = others.filter((row) => row !== denyRow && !ownRow(row)).map((row) => toButton(row));
  const buttons: ApprovalButton[] = [...rowButtons, ...denyButton, ...choices, primaryButton];
  return { buttons, denyDecision: denyRow?.decision };
}

/** The card's one decision path: a decision in flight blocks the next, an
 *  unconfirmed refusal is retryable, and a failure is worded for the card. */
function useApprovalDecision(resolve: ApprovalCardProps['resolve'], settled: ApprovalCardProps['settled']) {
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const resolvingRef = useRef(false);
  const decide = async (decision: ToolApprovalDecision) => {
    if (resolvingRef.current || settled) return;
    resolvingRef.current = true;
    noteApprovalDecision();
    setError('');
    setResolving(true);
    try {
      const accepted = await resolve(decision);
      // Recorded, or confirmed decided elsewhere: the buttons stay disabled
      // until the request leaves the snapshot. An unconfirmed refusal is retryable.
      if (accepted === 'unconfirmed') {
        resolvingRef.current = false;
        setResolving(false);
        return;
      }
      if (typeof accepted === 'boolean') return;
      setError(t('This decision could not be saved. Please try again.'));
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason || '');
      setError(
        detail
          ? t('This decision could not be saved: {{detail}}', { detail })
          : t('This decision could not be saved. Please try again.')
      );
    }
    resolvingRef.current = false;
    setResolving(false);
  };
  return { decide, resolving, resolvingRef, error, setError };
}

async function provideSecret(secretId: string, value: string, username: string, save: boolean): Promise<boolean> {
  const provide = window.mixdogDesktop?.provideSecretInput;
  try {
    if (username) await provide?.(`${secretId}${SECRET_USERNAME_SUFFIX}`, username);
    if (save) await provide?.(`${secretId}${SECRET_SAVE_SUFFIX}`, '1');
    return (await provide?.(secretId, value)) === true;
  } catch {
    return false;
  }
}

function ToolApprovalCard({
  approval,
  resolve,
  agentMode = false,
  settled = null,
  meta,
  queue,
  hostSessionId = '',
}: ApprovalCardProps) {
  const id = String(approval.id ?? '');
  const model = approvalCardModel(approval);
  // The transcript's session: its pane takes the Chrome import ('' off-transcript).
  const browserSessionId = useContext(MarkdownSessionContext);
  // A session this chat handed work to asks as it does in its own pane (a
  // bot's chat names its bot, a task session is the Lead's), not as this chat.
  const handoff = approvalHandoffTarget(approval, hostSessionId);
  const { agentName, headAgent, faceAgentId } = useRequester(approval, handoff ? Boolean(handoff.agentId) : agentMode);
  const handoffChip = useHandoffChip(handoff);
  const args = asRecord(approval.args);
  const action = String(args?.action || '').toLowerCase();
  let officeLabel = t('Discard recovery');
  if (action === 'commit') officeLabel = t('Commit changes');
  else if (action === 'rollback') officeLabel = t('Roll back');
  const takeoverSessionId = String(approval.sessionId || browserSessionId || '');
  const controlReady = useControlReady(id, takeoverSessionId, model.kind === 'takeover' && !settled);
  // The page's owner and the conversation whose panel shows it (they differ
  // when this chat shows a sub-session's takeover).
  const pageViewer = hostSessionId || browserSessionId || takeoverSessionId;
  const pageOwnerTitle = useSessionTitle(
    takeoverSessionId !== pageViewer ? takeoverSessionId : '',
    t('Another session')
  );
  const browserTakeover = model.kind === 'takeover' && model.surface === 'browser' && !settled;
  // While it waits, a phone tap on the streamed page raises the soft keyboard.
  const takeoverTab = model.takeoverTarget?.tab ?? '';
  useEffect(
    () => (browserTakeover && takeoverSessionId ? holdBrowserTakeover(takeoverSessionId, takeoverTab) : undefined),
    [browserTakeover, takeoverSessionId, takeoverTab]
  );
  const openPage = Boolean(pageViewer && browserPageRequestsAvailable());
  const openScreen = remoteScreenAvailable(desktopApi(), isMobileRemoteSurface());
  const [text, setText] = useState(model.payload);
  // A secret is never React state: the inputs hold it until submit reads them.
  const secretRef = useRef<HTMLInputElement | null>(null);
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const [codeFilled, setCodeFilled] = useState(0);
  const saveDefault = useSaveChatLogins(model.secretForm === 'login');
  const [saveLogin, setSaveLogin] = useState<boolean | null>(null);
  const { decide, resolving, resolvingRef, error, setError } = useApprovalDecision(resolve, settled);
  const edited = model.editable.length > 0 && text !== model.payload;
  // Changed text or a partly filled sign-in form not sent yet keeps the
  // conversation; a field's value is only tested for emptiness, never kept.
  useConversationReleaseHold(
    () => !settled && (edited || codeFilled > 0 || Boolean(secretRef.current?.value || usernameRef.current?.value))
  );
  // The desktop API supplies this method locally and over SSH; the paired API omits it.
  const secretEntry = typeof window !== 'undefined' && typeof window.mixdogDesktop?.provideSecretInput === 'function';
  const owner = useOwnerChip(approval, hostSessionId, approvalChainLabel(approval.chain));
  const handsOver = model.kind === 'secret' || model.kind === 'takeover';
  const rows = approvalCardRows(model, {
    agentName,
    officeLabel,
    reimport: Boolean(browserSessionId && window.mixdogDesktop?.browserProfileImportSources),
    controlReady,
    secretEntry,
    openPage,
    openScreen,
  });
  const disabled = resolving || Boolean(settled);

  const openTakeoverPage = async () => {
    setError('');
    if (model.surface === 'computer') return openRemoteScreen();
    const tabId = model.takeoverTarget?.tab ?? '';
    if (!tabId) return revealBrowserPane(pageViewer);
    const shown = await showBrowserPage({
      viewer: pageViewer,
      owner: takeoverSessionId,
      ownerName: pageOwnerTitle,
      tabId,
    });
    if (shown.status === 'gone') setError(t('This tab is no longer open'));
    else if (shown.status === 'failed') setError(shown.message);
  };

  const activate = (row: CardRow) => {
    if (row.disabled) return;
    if (row.decision === 'reimport') {
      requestBrowserImport(browserSessionId);
      return;
    }
    if (row.decision === 'open') {
      void openTakeoverPage();
      return;
    }
    if (row.decision === 'secret') {
      if (resolvingRef.current) return;
      // Read once, here, for the local IPC only; the fields are cleared at once.
      const field = secretRef.current;
      const value = field?.value ?? '';
      const otpShort = model.secretForm === 'otp' && value.length < model.secretLength;
      if (!field || !value || otpShort) return void ownedFocus(field);
      const login = model.secretForm === 'login';
      const name = login ? (usernameRef.current?.value ?? '').trim() : '';
      const save = login && name !== '' && (saveLogin ?? saveDefault) === true;
      field.value = '';
      if (usernameRef.current) usernameRef.current.value = '';
      setCodeFilled(0);
      void provideSecret(model.secretId, value, login ? name : '', save).then((held) => {
        if (held) return void decide({ approved: true, response: 'provide-secret' });
        setError(t('This PC could not take the value. Please try again.'));
      });
      return;
    }
    const decision = row.decision;
    void decide(
      row.edits && edited
        ? { ...decision, response: 'edit-and-approve', editedArgs: { [model.editable[0]]: text } }
        : decision
    );
  };

  const clickOnly = approvalAllowIsPointerOnly(approval);
  const permission = permissionChoices(model.kind === 'permission' ? model.scopes : []);
  const { buttons, denyDecision } = cardButtons(rows, { clickOnly, permission, activate });
  let onDeny: ((reason: string) => void) | undefined;
  if (denyDecision && typeof denyDecision === 'object') {
    onDeny = (reason) => void decide(reason ? { ...denyDecision, reason } : denyDecision);
  }
  const status = approvalSettledStatus(model.kind, settled);
  // The friendly service name; the raw tool id stays as its tooltip.
  let rawTool = model.tool || (model.kind === 'outbound' ? String(approval.name || '') : '');
  if (model.connector) rawTool = `mcp__${model.connector.server}__${model.connector.tool}`;
  const service = model.agentLabel || connectorServiceLabel(rawTool) || rawTool;
  const ownSession = String(approval.sessionId || '');
  const surface = String(approval.surfaceSessionId || '');
  const sessionLink =
    !handsOver && ownSession && surface && ownSession !== surface && ownSession !== hostSessionId
      ? { sessionId: ownSession, label: t('Open session'), handoff: Boolean(handoff) }
      : null;
  // Who asks next to the amber target chip; a bot's chat is named once, by its chip.
  let requester = headAgent;
  if (handoff) requester = handoff.agentId ? '' : headAgent || agentName;
  // A secret or takeover card names only the asking session, and only where
  // that is another conversation than the one showing it.
  if (handsOver) requester = '';
  const icon = <PixelIcon name={actionIcon(model.action, model.kind === 'outbound')} />;

  const body = approvalActionBody(model, icon);
  const editor = model.editable.length > 0 && (
    <ApprovalTextEditor text={text} payload={model.payload} disabled={disabled} onChange={setText} />
  );
  const office = model.office && <OfficeApprovalDetails args={args} />;
  const cardText = model.connector ? connectorChangeText(agentName, model.connector) : model.text;
  const ownText = model.kind !== 'outbound' && !(model.kind === 'secret' && !secretEntry) && cardText;
  const previewNode =
    body ||
    editor ||
    office ||
    ownText ||
    model.requestAccount ||
    model.detail ||
    (model.kind === 'secret' && secretEntry) ? (
      <>
        {ownText && (
          <p className="approval-text" data-centered={model.kind === 'permission' || undefined}>
            {cardText}
          </p>
        )}
        {model.kind === 'permission' &&
          [
            [t('Always allow'), permission.always],
            [t('Allow just once'), permission.once],
          ].map(([label, scope]) => {
            const shown = scope as PermissionScope | undefined;
            if (!shown || shown.label === shown.id) return null;
            return (
              <small key={String(label)} className="approval-preview-more" data-centered>
                {String(label)} · {shown.label}
              </small>
            );
          })}
        {body}
        {editor}
        {model.requestAccount && (
          <p className="approval-text">
            {t('Account')}: {model.requestAccount}
          </p>
        )}
        {model.detail && <pre className="approval-detail">{model.detail}</pre>}
        {office}
        {model.kind === 'secret' && secretEntry && (
          <SecretFields
            form={model.secretForm}
            length={model.secretLength}
            filled={codeFilled}
            save={saveLogin ?? saveDefault}
            disabled={disabled}
            secretRef={secretRef}
            usernameRef={usernameRef}
            onFilled={setCodeFilled}
            onSave={setSaveLogin}
            onSubmit={() => activate(rows[0])}
          />
        )}
      </>
    ) : null;
  let title = model.kind === 'outbound' ? actionQuestion(model.action) : model.title;
  if (model.kind === 'secret' && !secretEntry) title = t('Enter it on your PC');
  return (
    <ApprovalPrompt
      title={title}
      faceAgentId={faceAgentId}
      tone="need"
      requester={requester}
      target={handsOver ? owner : handoffChip}
      deadline={model.kind === 'secret' ? approvalDeadline(approval) : undefined}
      service={handsOver ? undefined : service}
      serviceTitle={rawTool !== service ? rawTool : undefined}
      sessionLink={sessionLink}
      queue={queue}
      corner={meta}
      preview={previewNode}
      buttons={buttons}
      focus={clickOnly ? 'deny' : 'primary'}
      enterAllows={!clickOnly}
      onDeny={onDeny}
      status={status}
      error={error}
      busy={disabled}
      kind={model.kind}
      agentMode={agentMode}
      keyChips={model.kind !== 'takeover'}
    />
  );
}

/** What an approval decided, named for the one line that reports it after
 *  another device answered ("Send an email"). */
export function approvalRecordLabel(approval: Approval): string {
  const model = approvalCardModel(approval);
  if (model.kind === 'outbound') return actionLabel(model.action);
  return (model.kind === 'approval' && toolActionNoun(String(approval.name || ''))) || model.title;
}

// Held requests: which pending home-thread rows already settled. The row that
// settles one arrives later in the same thread; the conversation publishes the
// settled ids per session so the earlier row's card can fold away.
const heldSettled = new Map<string, ReadonlyMap<string, string>>();
const heldListeners = new Set<() => void>();
const subscribeHeld = (listener: () => void) => {
  heldListeners.add(listener);
  return () => heldListeners.delete(listener);
};

/** Record the settled held requests of `sessionId`'s transcript (`status|device`). */
export function publishHeldSettlements(sessionId: string, items: readonly TranscriptItem[]): void {
  const next = heldSettlementsOf(items);
  const previous = heldSettled.get(sessionId) ?? NO_SETTLEMENTS;
  if (previous === next) return;
  if (previous.size === next.size && [...next].every(([key, value]) => previous.get(key) === value)) return;
  if (next.size) heldSettled.set(sessionId, next);
  else heldSettled.delete(sessionId);
  for (const listener of heldListeners) listener();
}

const NO_SETTLEMENTS: ReadonlyMap<string, string> = new Map();
/** The settled held requests of a transcript, each as its newest row states it (`status|device`), carried on from the
 *  list a frame made it from (list-carry.ts). */
const heldSettlementsOf = carriedLatest((item: TranscriptItem) => {
  const held = asRecord(item?.heldRequest);
  if (!held?.id || held.status === 'pending') return undefined;
  return [String(held.id), `${held.status}|${String(held.device || '')}`] as const;
});

function heldApproval(held: Record<string, unknown>): Approval {
  const action = String(held.action || '');
  const urlArgs = held.target ? { url: held.target } : {};
  return {
    id: String(held.id),
    name: String(held.tool || ''),
    kind: held.kind === 'outbound' ? 'outbound' : 'approval',
    reason: String(held.reason || ''),
    ...(held.account ? { account: String(held.account) } : {}),
    agentId: String(held.agentId || ''),
    remember: Array.isArray(held.remember) ? held.remember : ['once'],
    ...(held.kind === 'outbound'
      ? {
          outbound: {
            category: action,
            target: held.target,
            account: held.account,
            payload: held.payload || '',
            editable: held.editable || [],
            details: held.details || {},
          },
        }
      : { args: urlArgs }),
  };
}

/** A held request of an unattended run, in its owner's home thread: the same
 *  card with "<routine> 실행 · m:ss 남음" while it waits. */
export function HeldRequestCard({ held, sessionId }: { held: Record<string, unknown>; sessionId: string }) {
  const id = String(held.id || '');
  const settledKey = useSyncExternalStore(
    subscribeHeld,
    () => heldSettled.get(sessionId)?.get(id) ?? '',
    () => ''
  );
  const expiresAt = Number(held.expiresAt || 0);
  const [now, setNow] = useState(() => Date.now());
  // Settled while this card was showing: it stays a moment, disabled, saying who answered.
  const [shownSettled, setShownSettled] = useState<{ approved: boolean; device: string } | null>(null);
  const wasPending = useRef(!settledKey);
  const decidedHere = useRef(false);
  const pending = !settledKey && held.status === 'pending' && (!expiresAt || expiresAt > now);
  // An off-screen card (retained or parked conversation) does not tick; shown
  // again, it catches up at once.
  const surfaceActive = useSurfaceActive();
  useEffect(() => {
    if (!pending || !expiresAt || !surfaceActive) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [pending, expiresAt, surfaceActive]);
  useLayoutEffect(() => {
    if (!settledKey || !wasPending.current) return;
    wasPending.current = false;
    const [status, device] = settledKey.split('|');
    if (!device || decidedHere.current) return;
    setShownSettled({ approved: status === 'approved', device });
    const timer = window.setTimeout(() => setShownSettled(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [settledKey]);
  if (!pending && !shownSettled) return null;
  const run = asRecord(held.run);
  const routine = String(run?.name || '') || (run?.kind === 'webhook' ? t('Webhook') : t('Schedule'));
  return (
    <ApprovalCard
      approval={heldApproval(held)}
      agentMode
      settled={shownSettled}
      meta={
        expiresAt
          ? t('{{routine}} run · {{left}} left', { routine, left: clock(expiresAt - now) })
          : t('{{routine}} run', { routine })
      }
      resolve={async (decision) => {
        decidedHere.current = true;
        const accepted = await window.mixdogDesktop.resolveToolApprovalForSession(sessionId, id, decision);
        if (accepted !== true) decidedHere.current = false;
        return accepted;
      }}
    />
  );
}
