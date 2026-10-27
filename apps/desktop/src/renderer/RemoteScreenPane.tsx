// The phone's whole-PC screen view (design/mockups/remote-screen, frames C, D2,
// D3; docs/remote-screen.md): the PC picture over WebRTC, the one-line remote
// keyboard docked at the bottom, special keys and the touch strategy in ⋯,
// and the secure-desktop / stopped states from the PC's `screen-status`.
// Fingers drive the picture's viewport and the PC's pointer through
// remote-screen-touch.ts (gestures) and remote-screen-gesture.ts (messages).
import { ArrowUp, Lock, Monitor, ShieldAlert, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';

import {
  CREDUI_MAX_PASSWORD_LENGTH,
  CREDUI_MAX_USERNAME_LENGTH,
  type RemoteScreenDisplaySummary,
  type RemoteScreenInput,
} from '../shared/remote-webrtc';
import { ProgressSpinner } from './ProgressSpinner';
import { ErrorNotice } from './ErrorNotice';
import { ScreenHeaderRow, ScreenStateCard } from './RemoteScreenChrome';
import { t } from './i18n';
import type { DockAction } from './pane-dock-chrome';
import { currentDeviceId } from './remote-saved-pcs';
import { createScreenGestureAdapter, type ScreenInputMode } from './remote-screen-gesture';
import {
  EMPTY_SCREEN_HELPER_FORM,
  markScreenHelperNoticeShown,
  screenBlockReason,
  screenHelperAsksAccount,
  screenHelperFormReady,
  screenHelperNoticeDue,
  screenHelperPanel,
  screenHelperSheetShown,
  submitScreenHelperForm,
  type ScreenHelperForm,
  type ScreenHelperLine,
  type ScreenHelperPanel,
} from './remote-screen-helper';
import { SCREEN_SPECIAL_KEYS, screenSpecialKeyInputs } from './remote-screen-keys';
import {
  installScreenReleaseTriggers,
  screenKeyboardBar,
  type ScreenBlockReason,
  type ScreenView,
} from './remote-screen-state';
import { createScreenCursorStore } from './remote-screen-touch';
import { useRemoteScreen } from './use-remote-screen';
import { useScreenInput, type ScreenKeyboardHandlers } from './use-screen-input';
import { useScreenViewport } from './use-screen-viewport';

const RELEASE: RemoteScreenInput = { type: 'screen-release' };

export interface RemoteScreenPaneProps {
  display: RemoteScreenDisplaySummary;
  onClose(): void;
  /** The display went away: pick again (the host lists displays afresh). */
  onPickAgain(): void;
}

/** A feedback ring where input was injected; it removes itself when it ends. */
function showRing(stage: HTMLElement, x: number, y: number, radius: number): void {
  const ring = document.createElement('div');
  ring.className = 'remote-screen-ring';
  ring.style.cssText = `left:${x}px;top:${y}px;width:${radius * 2}px;height:${radius * 2}px`;
  ring.addEventListener('animationend', () => ring.remove(), { once: true });
  stage.appendChild(ring);
}

const BLOCK_COPY: Record<ScreenBlockReason, { icon: typeof Lock; title: string; detail: string }> = {
  uac: {
    icon: ShieldAlert,
    title: 'An administrator prompt is open on the PC',
    detail: 'This screen cannot be viewed remotely. Approve it on the PC; the screen returns once you do.',
  },
  lock: {
    icon: Lock,
    title: 'The PC is locked',
    detail: 'The lock screen cannot be viewed remotely. Unlock the PC and the screen returns.',
  },
  secure: {
    icon: ShieldAlert,
    title: 'A secure screen is open on the PC',
    detail: 'This screen cannot be viewed remotely. Finish it on the PC; the screen returns afterwards.',
  },
};
const PROMPT_DETAIL = 'The prompt cannot be answered remotely. Approve it on the PC.';

function sizeLabel(width: number, height: number): string {
  return `${width}×${height}`;
}

function helperLineText(line: ScreenHelperLine): string {
  switch (line.id) {
    case 'in-progress':
      return t('Approve it in the confirmation prompt on the PC.');
    case 'declined':
      return t('Access was declined on the PC. Restart Mixdog on the PC to ask again.');
    case 'failed':
      return t('Access could not be set up.');
    case 'other-user':
      return t('Another Windows account on the PC manages access.');
    case 'unavailable':
      return t('Access is not available on this PC.');
    case 'in-use':
      return t('Another device is controlling the PC screen.');
    case 'service-failed':
      return t('Access could not be started on the PC.');
    case 'sas_disabled_by_policy':
      return t('Ctrl+Alt+Del is blocked by the PC’s policy.');
    case 'desktop_unavailable':
      return t('The PC’s secure screen cannot be opened right now.');
    case 'input_failed':
      return t('Input could not be delivered to the PC.');
    case 'grant_key_missing':
      return t('This phone has no access on the PC.');
    case 'bad-credentials':
      return t('That Windows password was not correct. Try again.');
    case 'not-admin':
      return t('That account is not an administrator on the PC. Use an administrator account’s password.');
    case 'logon-type-denied':
      return t('That account is not allowed to sign in this way on the PC.');
    case 'account-locked':
      return t('That Windows account is locked. Unlock it on the PC, then try again.');
    case 'account-disabled':
      return t('That Windows account is disabled on the PC.');
    case 'policy-blocked':
      return t('A policy on the PC blocked that sign-in.');
    case 'busy':
      return t('Another request is in progress on the PC. Try again in a moment.');
  }
}

function BlockedNote({
  view,
  reason,
  panel,
  onInstall,
}: {
  view: Extract<ScreenView, { kind: 'blocked' }>;
  reason: ScreenBlockReason;
  panel: ScreenHelperPanel;
  onInstall(): void;
}) {
  const copy = BLOCK_COPY[reason];
  const Glyph = copy.icon;
  return (
    <>
      {view.dim && (
        <div className="remote-screen-badge">
          <span className="remote-screen-tile">
            <Glyph size={20} aria-hidden="true" />
          </span>
        </div>
      )}
      <div className="remote-screen-note" role="status">
        <strong>{t(copy.title)}</strong>
        <span>{t(view.dim ? copy.detail : PROMPT_DETAIL)}</span>
        {panel.lines.map((line) => (
          <span key={line.id}>{helperLineText(line)}</span>
        ))}
        {panel.action && (
          <div className="remote-screen-actions">
            <button type="button" className="remote-screen-primary" disabled={panel.busy} onClick={onInstall}>
              {panel.action === 'update' ? t('Approve access again') : t('Approve PC access')}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/** The Windows-password sheet the blocked view's button opens (design/mockups/
 *  remote-screen-helper-install): the password, and the account name only when
 *  the PC's signed-in account is not an administrator. */
function AccessSheet({
  asksAccount,
  busy,
  form,
  lines,
  notSent,
  onChange,
  onSubmit,
  onCancel,
}: {
  asksAccount: boolean;
  busy: boolean;
  form: ScreenHelperForm;
  lines: ScreenHelperLine[];
  notSent: boolean;
  onChange(form: ScreenHelperForm): void;
  onSubmit(): void;
  onCancel(): void;
}) {
  const wrong = lines.some((line) => line.id === 'bad-credentials');
  return (
    <>
      <div className="remote-screen-scrim" aria-hidden="true" onClick={busy ? undefined : onCancel} />
      <form
        className="remote-screen-sheet"
        role="dialog"
        aria-label={t('Approve PC access')}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="remote-screen-grab" aria-hidden="true" />
        <h3>{t('Approve PC access')}</h3>
        {asksAccount ? (
          <>
            <p className="remote-screen-sheet-error">
              {t(
                'The account signed in on the PC is not an administrator. Enter an administrator account name and password.'
              )}
            </p>
            <label className="remote-screen-field">
              <span>{t('Administrator account name')}</span>
              <input
                type="text"
                value={form.user}
                maxLength={CREDUI_MAX_USERNAME_LENGTH}
                disabled={busy}
                placeholder={t('Account name')}
                aria-label={t('Administrator account name')}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => onChange({ ...form, user: event.target.value })}
              />
            </label>
          </>
        ) : (
          <p>
            {t(
              'Enter the Windows password you use to sign in to the PC once, and you can also handle administrator prompts, the lock screen and Ctrl+Alt+Del from your phone.'
            )}
          </p>
        )}
        <label className="remote-screen-field">
          <span>{t('Windows password')}</span>
          <input
            type="password"
            value={form.password}
            maxLength={CREDUI_MAX_PASSWORD_LENGTH}
            disabled={busy}
            aria-label={t('Windows password')}
            aria-invalid={wrong ? true : undefined}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => onChange({ ...form, password: event.target.value })}
          />
        </label>
        {lines.map((line) => (
          <p key={line.id} className="remote-screen-sheet-error" role="status">
            {helperLineText(line)}
          </p>
        ))}
        {notSent && (
          <p className="remote-screen-sheet-error" role="status">
            {t('The request could not be sent to the PC.')}
          </p>
        )}
        <p>
          {t(
            'Use your password, not a PIN. If you sign in with a Microsoft account, it is that account’s password. The password is not saved.'
          )}
        </p>
        <div className="remote-screen-sheet-buttons">
          <button type="button" disabled={busy} onClick={onCancel}>
            {t('Cancel')}
          </button>
          <button
            type="submit"
            className="remote-screen-primary"
            disabled={busy || !screenHelperFormReady(form, asksAccount)}
          >
            {busy ? t('Checking…') : t('Approve')}
          </button>
        </div>
      </form>
    </>
  );
}

function StoppedCard({
  reason,
  onRestart,
  onClose,
}: {
  reason: 'display-removed' | 'other';
  onRestart(): void;
  onClose(): void;
}) {
  const removed = reason === 'display-removed';
  return (
    <ScreenStateCard>
      <span className="remote-screen-tile remote-screen-tile--large">
        <Monitor size={20} aria-hidden="true" />
      </span>
      <strong>{removed ? t('The display was disconnected') : t('Screen viewing was stopped on the PC')}</strong>
      <span>
        {removed
          ? t('This display is no longer available on the PC. Choose a display again to keep viewing.')
          : t('The connection ended from the PC’s indicator. Press the button to view again.')}
      </span>
      <div className="remote-screen-actions">
        <button type="button" className="remote-screen-primary" onClick={onRestart}>
          {removed ? t('Choose a display') : t('View again')}
        </button>
        <button type="button" onClick={onClose}>
          {t('Close')}
        </button>
      </div>
    </ScreenStateCard>
  );
}

/** The one-line remote keyboard (`.browser-remote-keyboard`), docked at the
 *  bottom. What is typed stays here until Send (or the soft keyboard's Enter). */
export function ScreenKeyboardBar({
  fieldRef,
  handlers,
  onSend,
  visible,
  enabled,
}: {
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  /** Send: a running composition is committed, then the bar's whole text goes
   *  to the PC in one piece (an Enter key when the bar is empty). */
  onSend(): void;
  /** False on the secure desktop: hidden, but its height stays reserved. */
  visible: boolean;
  /** Typable only while the PC accepts control. */
  enabled: boolean;
  handlers: ScreenKeyboardHandlers;
}) {
  return (
    <div
      className="browser-remote-keyboard is-composer"
      data-open="true"
      style={visible ? undefined : { visibility: 'hidden' }}
      aria-hidden={visible ? undefined : true}
    >
      <textarea
        ref={fieldRef}
        disabled={!enabled}
        rows={1}
        maxLength={2_000}
        inputMode="text"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        aria-label={t('Type on PC screen')}
        placeholder={t('Type on PC screen')}
        {...handlers}
      />
      <button
        type="button"
        className="send-button"
        disabled={!enabled}
        aria-label={t('Send')}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onSend}
      >
        <ArrowUp size={16} />
      </button>
    </div>
  );
}

export default function RemoteScreenPane({ display, onClose, onPickAgain }: RemoteScreenPaneProps) {
  const api = window.mixdogDesktop;
  // The host refused a key, combo or text it had accepted off the channel.
  const [notSent, setNotSent] = useState(false);
  // The helper install / update request could not be sent.
  const [helperNotSent, setHelperNotSent] = useState(false);
  const screen = useRemoteScreen({ api, screenId: display.screenId, onInputRejected: () => setNotSent(true) });
  const { view, send, retry, geometry, installHelper } = screen;
  const blocked = view.kind === 'blocked' ? view : null;
  // The Windows-password sheet: opened by the blocked view's button, closed by
  // Cancel, by an answer that leaves nothing to ask (done, declined, …) and
  // when the secure screen is gone. The typed password lives only here, and is
  // emptied by every submit.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState<ScreenHelperForm>(EMPTY_SCREEN_HELPER_FORM);
  const panel = screenHelperPanel(screen.helper, screen.helperPending, screen.status?.helper);
  const [accountSeen, setAccountSeen] = useState(false);
  const asksAccount = screenHelperAsksAccount(screen.helper, accountSeen);
  useEffect(() => {
    if (asksAccount) setAccountSeen(true);
  }, [asksAccount]);
  // The one-time first-open notice (existing users never got the offer in
  // Computer Use setup): its button opens the same sheet.
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [sheetFromNotice, setSheetFromNotice] = useState(false);
  const sheetShown = screenHelperSheetShown({
    open: sheetOpen,
    blocked: blocked !== null,
    fromNotice: sheetFromNotice,
    action: panel.action,
  });
  useEffect(() => {
    if (sheetOpen && !sheetShown) {
      setSheetOpen(false);
      setSheetFromNotice(false);
      setForm(EMPTY_SCREEN_HELPER_FORM);
    }
  }, [sheetOpen, sheetShown]);
  useEffect(() => {
    const deviceId = currentDeviceId();
    if (noticeOpen || !screenHelperNoticeDue(view, panel, window.localStorage, deviceId)) return;
    markScreenHelperNoticeShown(window.localStorage, deviceId);
    setNoticeOpen(true);
  }, [noticeOpen, view, panel]);
  const noticeShown = noticeOpen && view.kind === 'live' && panel.action === 'install' && !sheetShown;
  const openSheet = useCallback(() => {
    setHelperNotSent(false);
    setForm(EMPTY_SCREEN_HELPER_FORM);
    setSheetOpen(true);
  }, []);
  const openSheetFromNotice = useCallback(() => {
    setNoticeOpen(false);
    setSheetFromNotice(true);
    openSheet();
  }, [openSheet]);
  const closeSheet = useCallback(() => {
    setSheetOpen(false);
    setSheetFromNotice(false);
    setForm(EMPTY_SCREEN_HELPER_FORM);
    setHelperNotSent(false);
  }, []);
  const action = panel.action;
  const busy = panel.busy;
  const submitSheet = useCallback(() => {
    if (!action || busy) return;
    const { credential, form: next } = submitScreenHelperForm(form, asksAccount);
    if (!credential) return;
    setForm(next);
    setHelperNotSent(false);
    void installHelper(action, credential).then((sent) => {
      if (!sent) setHelperNotSent(true);
    });
  }, [action, busy, form, asksAccount, installHelper]);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pictureRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const [mode, setMode] = useState<ScreenInputMode>('direct');
  const width = geometry?.pixelWidth ?? display.pixelWidth;
  const height = geometry?.pixelHeight ?? display.pixelHeight;

  const bar = screenKeyboardBar(view);
  const controllableRef = useRef(bar.enabled);
  controllableRef.current = bar.enabled;
  const sendAll = useCallback(
    (inputs: RemoteScreenInput[]) => {
      // `send` is gated on control (a withheld control is already on screen);
      // pointer motion is never worth a notice, a key or text that was lost is.
      for (const input of inputs) {
        const delivered = send(input);
        if (
          !delivered &&
          controllableRef.current &&
          (input.type === 'screen-key' || input.type === 'screen-keys' || input.type === 'screen-text')
        ) {
          setNotSent(true);
        }
      }
    },
    [send]
  );
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };
  const pcCursorRef = useRef(screen.cursor);
  pcCursorRef.current = screen.cursor;
  const stampRef = useRef(screen.cursorStamp);
  stampRef.current = screen.cursorStamp;
  const adapter = useMemo(() => createScreenGestureAdapter({ size: () => sizeRef.current }), []);
  // The trackpad cursor starts from where the PC reports its own.
  const cursorStore = useMemo(
    () =>
      createScreenCursorStore(
        () => pcCursorRef.current(),
        () => stampRef.current()
      ),
    []
  );
  const viewport = useScreenViewport({
    stageRef,
    pictureRef,
    picture: { width, height },
    mounted: view.kind !== 'stopped',
  });

  // Everything held on the PC is lifted whenever a touch or key can no longer
  // be trusted to end: the page hides, leaves or blurs, a touch is cancelled,
  // and when this view is left.
  const releaseAll = useCallback(() => {
    adapter.cancel();
    send(RELEASE);
  }, [adapter, send]);
  const releaseRef = useRef(releaseAll);
  releaseRef.current = releaseAll;
  // A cancelled touch bubbles up from the stage to the document.
  useEffect(() => installScreenReleaseTriggers({ document, window, stage: document }, () => releaseRef.current()), []);

  // Typing stays in the bar until Send; fingers drive the picture and never
  // touch the bar's field (use-screen-input.ts).
  const live = view.kind === 'live';
  const ring = useCallback((stage: HTMLElement, x: number, y: number, radius: number) => {
    if (controllableRef.current) showRing(stage, x, y, radius);
  }, []);
  const input = useScreenInput({
    stageRef,
    fieldRef,
    live,
    mode,
    viewport,
    cursor: cursorStore,
    adapter,
    sendAll,
    ring,
    releaseRef,
  });

  const controlling = bar.enabled;
  const menu: DockAction[] = [
    ...SCREEN_SPECIAL_KEYS.map(
      (special): DockAction => ({
        id: `key-${special.id}`,
        label: special.label,
        detail: special.needsHelper && screen.status?.helper !== 'active' ? t('Needs access on the PC') : undefined,
        disabled: !controlling,
        onSelect: () => sendAll(screenSpecialKeyInputs(special.id)),
      })
    ),
    {
      id: 'mode-direct',
      label: t('Direct touch'),
      checked: mode === 'direct',
      separatorBefore: true,
      onSelect: () => setMode('direct'),
    },
    { id: 'mode-trackpad', label: t('Trackpad'), checked: mode === 'trackpad', onSelect: () => setMode('trackpad') },
  ];

  let toolbarText = sizeLabel(width, height);
  if (view.kind === 'live') {
    toolbarText = t(view.control ? '{{size}} · Controlling' : '{{size}} · View only', { size: toolbarText });
  }
  const showPicture = view.kind === 'live' || blocked !== null || (view.kind === 'connecting' && !!view.reconnecting);

  if (view.kind === 'stopped') {
    return (
      <div className="browser-pane browser-remote-pane remote-screen-pane">
        <ScreenHeaderRow title={display.label} onClose={onClose} />
        <div className="remote-screen-stage">
          <StoppedCard
            reason={view.reason}
            onRestart={view.reason === 'display-removed' ? onPickAgain : retry}
            onClose={onClose}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="browser-pane browser-remote-pane remote-screen-pane">
      <ScreenHeaderRow title={display.label} actions={menu} onClose={onClose} />
      <div className="browser-pane-toolbar">
        <div className="browser-pane-address-form">
          <div className="browser-pane-address remote-screen-status" role="status">
            {toolbarText}
          </div>
        </div>
        <button
          type="button"
          className="browser-pane-nav-button remote-screen-stop"
          onClick={onClose}
          aria-label={t('Stop viewing')}
          data-tooltip={t('Stop viewing')}
        >
          <Square size={15} aria-hidden="true" />
        </button>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the touch layer drives this surface; typing goes through the keyboard bar. */}
      <div
        ref={stageRef}
        className="remote-screen-stage browser-remote-content"
        onContextMenu={(event) => event.preventDefault()}
      >
        <div
          ref={pictureRef}
          className="remote-screen-picture"
          data-dim={blocked?.dim ? 'true' : 'false'}
          // Decoding (and reporting frames) under the state card until promoted.
          // The viewport writes the transform.
          style={{ width, height, opacity: showPicture ? 1 : 0 } as CSSProperties}
        >
          <video
            ref={screen.videoRef}
            muted
            playsInline
            autoPlay
            disablePictureInPicture
            aria-hidden={showPicture ? undefined : true}
          />
        </div>
        {blocked && (
          <BlockedNote
            view={blocked}
            reason={screenBlockReason(blocked, screen.helper)}
            // The sheet carries the lines while it is open.
            panel={sheetShown ? { ...panel, lines: [] } : panel}
            onInstall={openSheet}
          />
        )}
        {/* Reconnecting is silent: no card or text, the picture area stays shown (it may go
            blank until the new session's frames arrive), and the global dot carries a long outage. */}
        {view.kind === 'connecting' && !view.reconnecting && (
          <ScreenStateCard>
            <ProgressSpinner size={24} />
            <span>{t('Connecting to PC screen…')}</span>
          </ScreenStateCard>
        )}
        {view.kind === 'failed' && (
          <ScreenStateCard>
            <ErrorNotice
              error={t('The connection to the PC ended.')}
              title={t('Could not connect to PC screen')}
              role="status"
            />
            <div className="remote-screen-actions">
              <button type="button" className="remote-screen-primary" onClick={retry}>
                {t('Try again')}
              </button>
              <button type="button" onClick={onClose}>
                {t('Close')}
              </button>
            </div>
          </ScreenStateCard>
        )}
        {(notSent || (helperNotSent && !sheetShown)) && (
          <div className="browser-remote-status">
            <ErrorNotice
              error={
                helperNotSent && !sheetShown ? t('The request could not be sent to the PC.') : t('Input was not sent.')
              }
              role="status"
              onDismiss={() => {
                setNotSent(false);
                setHelperNotSent(false);
              }}
            />
          </div>
        )}
      </div>
      {/* Outside the stage: its touch layer would turn a tap on a button into a PC click. */}
      {noticeShown && (
        <div className="remote-screen-note remote-screen-note-bar" role="status">
          <strong>{t('Set up PC access')}</strong>
          <span>
            {t('Approve PC access once to handle administrator prompts and the lock screen from your phone.')}
          </span>
          <div className="remote-screen-actions">
            <button type="button" className="remote-screen-primary" onClick={openSheetFromNotice}>
              {t('Approve PC access')}
            </button>
            <button type="button" onClick={() => setNoticeOpen(false)}>
              {t('Not now')}
            </button>
          </div>
        </div>
      )}
      {bar.present && (
        <ScreenKeyboardBar
          fieldRef={fieldRef}
          handlers={input.handlers}
          onSend={input.onSend}
          visible={bar.visible}
          enabled={bar.enabled}
        />
      )}
      {sheetShown && (
        <AccessSheet
          asksAccount={asksAccount}
          busy={busy}
          form={form}
          lines={panel.lines}
          notSent={helperNotSent}
          onChange={setForm}
          onSubmit={submitSheet}
          onCancel={closeSheet}
        />
      )}
    </div>
  );
}
