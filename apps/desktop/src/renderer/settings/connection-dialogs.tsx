import { ArrowUp, Check, Folder } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopRemoteAccessInfo } from '../../shared/contract';
import { ErrorNotice } from '../ErrorNotice';
import { t, uiFormatLocale } from '../i18n';
import { timeFormatOptions } from '../time-format-preference';
import { useMobileBack } from '../mobile-back';
import { scrimDismiss } from '../scrim-dismiss';
import { setRemoteClaimPromptActive } from '../remote-claim-prompt-state';
import { claimDisplay, resolveClaim, useClaimQueue } from '../remote-claim-store';
import { acquireTitleBarDim } from '../titlebar-dim';
import type { CapabilityApi } from './capability-data';
import { ConnRow, KindIcon } from './connection-ui';
import { AddressRow, PairCodeBlock, usePairCode } from './pair-code';
import { errorMessage } from '../editor-pane-session-errors';
import { joinHostPath, parentHostPath } from '../HostFolderBrowser';

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled)';

/** The one dialog frame of the Connection page: 480 wide, 24 padding, title
 *  with a muted description, body, footer. No close button — Escape, a press
 *  on the dimmed backdrop and the cancel button close it. Focus stays inside
 *  while it shows and returns to where it was afterwards. */
export function ConnDialog({
  title,
  description,
  footer,
  onEscape,
  onScrim,
  scrimCloses = true,
  viewKey = '',
  role = 'dialog',
  children,
}: {
  title: string;
  description?: string;
  footer: ReactNode;
  onEscape(): void;
  /** A press on the backdrop; defaults to onEscape. Set it where Escape first
   *  folds an inner popup, so the backdrop still closes the dialog at once. */
  onScrim?(): void;
  /** Off where closing is an answer (a pairing request is declined), so a
   *  stray press beside the dialog never decides it. */
  scrimCloses?: boolean;
  /** Changes when the content is swapped for another view in place. */
  viewKey?: string;
  role?: 'dialog' | 'alertdialog';
  children?: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  const scrimRef = useRef(onScrim ?? onEscape);
  scrimRef.current = onScrim ?? onEscape;
  const id = useId();
  // Every Connection dialog closes on back through its Escape path.
  useMobileBack(true, onEscape);
  // The scrim cannot cover the native caption controls: hold the dim claim.
  useEffect(() => acquireTitleBarDim(), []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = ref.current;
      if (event.key === 'Tab' && dialog) {
        const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        const current = document.activeElement;
        if (!dialog.contains(current) || (event.shiftKey && current === first)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (!event.shiftKey && current === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key !== 'Escape') return;
      event.preventDefault();
      escapeRef.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previous?.focus?.();
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewKey is the trigger: a swapped view that lost the focused control gets focus back inside.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.contains(document.activeElement)) return;
    (dialog.querySelector<HTMLElement>('[data-autofocus]') ?? dialog.querySelector<HTMLElement>(FOCUSABLE))?.focus();
  }, [viewKey]);
  return (
    <div
      className="settings-confirm-layer"
      {...scrimDismiss(() => {
        if (scrimCloses) scrimRef.current();
      })}
    >
      <section ref={ref} className="conn-dialog" role={role} aria-modal="true" aria-labelledby={`${id}-title`}>
        <header>
          <h3 id={`${id}-title`}>{title}</h3>
          {description && <p>{description}</p>}
        </header>
        {children}
        <footer>{footer}</footer>
      </section>
    </div>
  );
}

export function Steps({ items, start = 1 }: { items: ReactNode[]; start?: number }) {
  return (
    <ol className="conn-steps">
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered steps.
        <li key={index} data-n={start + index}>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

type Segment = 'phone' | 'browser' | 'pc';

function ConnectBody({
  api,
  info,
  segment,
  setSegment,
  pair,
}: {
  api: CapabilityApi;
  info: DesktopRemoteAccessInfo | null | undefined;
  segment: Segment;
  setSegment(next: Segment): void;
  pair: ReturnType<typeof usePairCode>;
}) {
  const segments: Array<[Segment, string]> = [
    ['phone', t('Phone')],
    ['browser', t('Browser')],
    ['pc', t('Other PC')],
  ];
  const address = info?.relayConnectUrl?.replace(/^https?:\/\//u, '') ?? '';
  const codePair = api.getRemotePairCode ? pair : { ...pair, unsupported: true };
  let content: ReactNode;
  if (segment === 'phone') {
    content = (
      <>
        <div className="conn-qr-row">
          {info?.relayAppQrSvg ? (
            // biome-ignore lint/security/noDangerouslySetInnerHtml: QR SVG generated by the app's own relay info, not user content.
            <div className="conn-qr" aria-hidden="true" dangerouslySetInnerHTML={{ __html: info.relayAppQrSvg }} />
          ) : (
            <div className="conn-qr conn-qr--loading" role="status" aria-busy="true" aria-label={t('Getting ready')} />
          )}
          <Steps
            items={[
              t('Scan with your phone camera to install the Mixdog app'),
              t('In the app, tap Connect with a code and enter this code'),
            ]}
          />
        </div>
        <PairCodeBlock pair={codePair} />
        <Steps start={3} items={[t('Allow the request on this PC')]} />
      </>
    );
  } else if (segment === 'browser') {
    content = (
      <>
        <div className="conn-stack">
          <Steps items={[t('Open this address in a browser')]} />
          {address && <AddressRow address={address} />}
        </div>
        <Steps start={2} items={[t('Enter this code')]} />
        <PairCodeBlock pair={codePair} />
      </>
    );
  } else {
    content = (
      <>
        <Steps items={[t('On that PC, go to Settings → Connection → Open another PC'), t('Enter this code')]} />
        <PairCodeBlock pair={codePair} />
      </>
    );
  }
  return (
    <div className="conn-body">
      <div className="conn-seg" role="tablist">
        {segments.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={segment === id} onClick={() => setSegment(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="conn-view">{content}</div>
    </div>
  );
}

function ClaimBody({ claim, error }: { claim: ReturnType<typeof useClaimQueue>[number]; error: string }) {
  const shown = claimDisplay(claim);
  let method = t('QR code');
  if (claim.method === 'code') method = t('Code');
  else if (claim.method === 'retry') method = t('Retry request');
  const time = new Date(claim.requestedAt ?? Date.now()).toLocaleTimeString(uiFormatLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    ...timeFormatOptions(),
  });
  return (
    <div className="conn-claim">
      <div className="conn-device">
        <span className="conn-tile conn-tile--lg">
          <KindIcon kind={shown.kind} />
        </span>
        <div>
          <b>{shown.name}</b>
          <span>{t('Wants to connect to this PC')}</span>
        </div>
      </div>
      <div className="conn-rule" />
      <dl className="conn-kv">
        <dt>{t('Type')}</dt>
        <dd>{shown.type}</dd>
        <dt>{t('Method')}</dt>
        <dd>{method}</dd>
        <dt>{t('Requested')}</dt>
        <dd>{time}</dd>
      </dl>
      <p className="conn-note">
        {t('If you allow it, this device can use everything on this PC, including files, terminals and agents.')}
      </p>
      {error && <ErrorNotice error={error} />}
    </div>
  );
}

/** "Connect a device" (A1–A6). A request that arrives while it is open turns
 *  the same dialog into the approval (B1), then the result (B2). */
export function ConnectDeviceDialog({
  api,
  info,
  onClose,
}: {
  api: CapabilityApi;
  info: DesktopRemoteAccessInfo | null | undefined;
  onClose(): void;
}) {
  const [segment, setSegment] = useState<Segment>('phone');
  const [allowed, setAllowed] = useState<{ name: string; type: string } | null>(null);
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState<{ claimId: string; reason: string } | null>(null);
  const answeringRef = useRef(false);
  const claim = useClaimQueue()[0];

  // While this dialog shows, requests are answered here, not by the notice.
  useEffect(() => {
    setRemoteClaimPromptActive(true);
    return () => setRemoteClaimPromptActive(false);
  }, []);

  const pair = usePairCode(api, !claim);

  const answer = async (approved: boolean): Promise<void> => {
    if (!claim || answeringRef.current) return;
    answeringRef.current = true;
    setAnswering(true);
    setAnswerError(null);
    try {
      const handled = await resolveClaim(claim, approved);
      const shown = claimDisplay(claim);
      setAllowed(handled && approved ? { name: shown.name, type: shown.kindText } : null);
    } catch (reason) {
      setAnswerError({ claimId: claim.claimId, reason: errorMessage(reason) });
    } finally {
      answeringRef.current = false;
      setAnswering(false);
    }
  };

  const close = (
    <button type="button" className="conn-btn" onClick={onClose}>
      {t('Close')}
    </button>
  );
  if (claim) {
    return (
      <ConnDialog
        title={t('Connection request')}
        description={t('Allow only if you made the request.')}
        role="alertdialog"
        viewKey="claim"
        onEscape={() => void answer(false)}
        scrimCloses={false}
        footer={
          <>
            <span className="conn-grow" />
            <button type="button" className="conn-btn" disabled={answering} onClick={() => void answer(false)}>
              {t('Deny')}
            </button>
            <button
              type="button"
              className="conn-btn conn-btn--primary"
              disabled={answering}
              onClick={() => void answer(true)}
            >
              {t('Allow')}
            </button>
          </>
        }
      >
        <ClaimBody claim={claim} error={answerError?.claimId === claim.claimId ? answerError.reason : ''} />
      </ConnDialog>
    );
  }
  if (allowed) {
    return (
      <ConnDialog
        title={t('Connected')}
        description={t('You can disconnect it from the list at any time.')}
        viewKey="allowed"
        onEscape={onClose}
        footer={
          <>
            <button type="button" className="conn-link" onClick={() => setAllowed(null)}>
              {t('Connect another device')}
            </button>
            <span className="conn-grow" />
            <button type="button" className="conn-btn conn-btn--primary" onClick={onClose}>
              {t('Done')}
            </button>
          </>
        }
      >
        <ConnRow
          icon={<Check size={16} aria-hidden="true" />}
          title={allowed.name}
          meta={t('{{kind}} · Just connected', { kind: allowed.type })}
        />
      </ConnDialog>
    );
  }
  const link: ReactNode =
    segment === 'browser' ? <span className="conn-footnote">{t('Notifications only work in the app.')}</span> : null;
  return (
    <ConnDialog
      title={t('Connect a device')}
      description={t('Choose the kind of device to connect.')}
      viewKey="connect"
      onEscape={onClose}
      footer={
        <>
          {link}
          <span className="conn-grow" />
          {close}
        </>
      }
    >
      <ConnectBody api={api} info={info} segment={segment} setSegment={setSegment} pair={pair} />
    </ConnDialog>
  );
}

/** Confirmation for a change that cannot be undone (D1, D2). */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm(): void;
  onClose(): void;
  /** Options that belong to the confirmation (a checkbox). */
  children?: ReactNode;
}) {
  return (
    <ConnDialog
      title={title}
      description={description}
      role="alertdialog"
      onEscape={onClose}
      footer={
        <>
          <span className="conn-grow" />
          <button type="button" className="conn-btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className="conn-btn conn-btn--danger"
            onClick={() => {
              onClose();
              onConfirm();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </ConnDialog>
  );
}

export interface ServerFolderListing {
  /** Canonical directory the server listed. */
  path: string;
  entries: Array<{ name: string; git: boolean }>;
  truncated: boolean;
}

/** Folder chooser for a server window (D1): the server's folders in place of
 *  this PC's OS dialog. `list('')` starts at the user's home on the server. */
function folderListingNote(listing: ServerFolderListing | null): string {
  return listing?.entries.length === 0 ? t('No folders') : '\u00a0';
}

export function ServerFolderDialog({
  serverName,
  list,
  onSelect,
  onClose,
}: {
  serverName: string;
  list(path: string): Promise<ServerFolderListing>;
  onSelect(path: string): void;
  onClose(): void;
}) {
  const [target, setTarget] = useState('');
  const [draft, setDraft] = useState('');
  const [listing, setListing] = useState<ServerFolderListing | null>(null);
  const [error, setError] = useState('');
  const listRef = useRef(list);
  listRef.current = list;
  // `target` is the trigger; the list function is read through its ref.
  useEffect(() => {
    let live = true;
    setError('');
    listRef.current(target).then(
      (result) => {
        if (!live) return;
        setListing(result);
        setDraft(result.path);
      },
      () => {
        if (live) setError(t('This folder cannot be opened on the server.'));
      }
    );
    return () => {
      live = false;
    };
  }, [target]);
  const here = listing?.path ?? '';
  const parent = here ? parentHostPath(here) : null;
  const pickRow = (name: string, git: boolean, onClick: () => void, icon: ReactNode, label?: string) => (
    <button type="button" key={name} className="conn-row conn-row--pick" aria-label={label} onClick={onClick}>
      <span className="conn-tile">{icon}</span>
      <span className="conn-row-text">
        <span className="conn-row-title">
          <b>{name}</b>
        </span>
      </span>
      {git && <span className="conn-row-meta">{t('Git')}</span>}
    </button>
  );
  return createPortal(
    <ConnDialog
      title={t('Choose a Mixdog project folder')}
      description={serverName ? t('These folders are on {{server}}.', { server: serverName }) : undefined}
      onEscape={onClose}
      footer={
        <>
          <span className="conn-grow" />
          <button type="button" className="conn-btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className="conn-btn conn-btn--primary"
            disabled={!listing || Boolean(error)}
            onClick={() => onSelect(here)}
          >
            {t('Choose')}
          </button>
        </>
      }
    >
      <div className="conn-field">
        <input
          type="text"
          className="conn-input"
          data-autofocus
          value={draft}
          aria-label={t('Path')}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            setTarget(draft.trim());
          }}
        />
        <div className="conn-list conn-list--picker">
          {parent !== null &&
            pickRow('..', false, () => setTarget(parent), <ArrowUp size={16} aria-hidden="true" />, t('Up'))}
          {listing?.entries.map((entry) =>
            pickRow(
              entry.name,
              entry.git,
              () => setTarget(joinHostPath(here, entry.name)),
              <Folder size={16} aria-hidden="true" />
            )
          )}
        </div>
        <div className="conn-field-msg">{error ? <ErrorNotice error={error} /> : folderListingNote(listing)}</div>
      </div>
    </ConnDialog>,
    document.body
  );
}

/** One-line name editor (F2). */
export function RenameDialog({
  title,
  description,
  helper,
  initial,
  allowEmpty,
  onSave,
  onClose,
}: {
  title: string;
  description: string;
  helper?: string;
  initial: string;
  allowEmpty: boolean;
  onSave(name: string): Promise<unknown>;
  onClose(): void;
}) {
  const [name, setName] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const trimmed = name.trim();
  const save = (): void => {
    if (saving || (!allowEmpty && !trimmed)) return;
    setSaving(true);
    setError('');
    void onSave(trimmed)
      .then(onClose)
      .catch((reason) => {
        setError(errorMessage(reason));
        setSaving(false);
      });
  };
  return (
    <ConnDialog
      title={title}
      description={description}
      onEscape={onClose}
      footer={
        <>
          <span className="conn-grow" />
          <button type="button" className="conn-btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className="conn-btn conn-btn--primary"
            disabled={saving || (!allowEmpty && !trimmed)}
            onClick={save}
          >
            {t('Save')}
          </button>
        </>
      }
    >
      <div className="conn-field">
        <input
          type="text"
          className="conn-input"
          data-autofocus
          value={name}
          maxLength={80}
          aria-label={title}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save();
          }}
        />
        <div className="conn-field-msg">{error ? <ErrorNotice error={error} /> : (helper ?? '\u00a0')}</div>
      </div>
    </ConnDialog>
  );
}
