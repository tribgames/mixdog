// The phone's whole-PC screen view (design/mockups/remote-screen, frames C, D2,
// D3; docs/remote-screen.md): the PC picture over WebRTC, the one-line remote
// keyboard docked at the bottom, special keys and the touch strategy in ⋯,
// and the secure-desktop / stopped states from the PC's `screen-status`.
// Fingers drive the picture's viewport and the PC's pointer through
// remote-screen-touch.ts (gestures) and remote-screen-gesture.ts (messages).
import { Lock, Monitor, ShieldAlert, Square, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CompositionEvent,
  type CSSProperties,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import type { RemoteScreenDisplaySummary, RemoteScreenInput } from '../shared/remote-webrtc';
import { ProgressSpinner } from './ProgressSpinner';
import { ErrorNotice } from './ErrorNotice';
import { ScreenHeaderRow, ScreenStateCard } from './RemoteScreenChrome';
import { t } from './i18n';
import type { DockAction } from './pane-dock-chrome';
import { useCompositionFinisher } from './remote-composition';
import { createScreenGestureAdapter, type ScreenInputMode } from './remote-screen-gesture';
import {
  screenBlockReason,
  screenHelperPanel,
  type ScreenHelperLine,
  type ScreenHelperPanel,
} from './remote-screen-helper';
import { SCREEN_SPECIAL_KEYS, createScreenTextController, screenSpecialKeyInputs } from './remote-screen-keys';
import {
  installScreenReleaseTriggers,
  screenKeyboardBar,
  type ScreenBlockReason,
  type ScreenView,
} from './remote-screen-state';
import { bindScreenTouch, createScreenCursorStore } from './remote-screen-touch';
import { useRemoteScreen } from './use-remote-screen';
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
  if (line.kind === 'detail') return line.text;
  switch (line.id) {
    case 'in-progress':
      return t('Answer the confirmation prompt shown on the PC.');
    case 'declined':
      return t('The request was declined on the PC. Restart Mixdog on the PC to ask again.');
    case 'failed':
      return t('The helper could not be installed.');
    case 'other-user':
      return t('Another Windows account on the PC owns the helper.');
    case 'unavailable':
      return t('The helper is not available on this PC.');
    case 'in-use':
      return t('Another device is controlling the PC screen.');
    case 'service-failed':
      return t('The helper service could not be started on the PC.');
    case 'sas_disabled_by_policy':
      return t('Ctrl+Alt+Del is blocked by the PC’s policy.');
    case 'desktop_unavailable':
      return t('The PC’s secure screen cannot be opened right now.');
    case 'input_failed':
      return t('Input could not be delivered to the PC.');
    case 'grant_key_missing':
      return t('This phone is not registered with the helper.');
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
          <span key={line.kind === 'copy' ? line.id : line.text}>{helperLineText(line)}</span>
        ))}
        {panel.action && (
          <div className="remote-screen-actions">
            <button type="button" className="remote-screen-primary" disabled={panel.busy} onClick={onInstall}>
              {panel.action === 'update' ? t('Approve helper update') : t('Request helper installation on the PC')}
            </button>
          </div>
        )}
      </div>
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

/** The one-line remote keyboard (`.browser-remote-keyboard`), docked at the bottom. */
function ScreenKeyboardBar({
  fieldRef,
  handlers,
  visible,
  enabled,
}: {
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  /** False on the secure desktop: hidden, but its height stays reserved. */
  visible: boolean;
  /** Typable only while the PC accepts control. */
  enabled: boolean;
  handlers: {
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
    onKeyUp(event: KeyboardEvent<HTMLTextAreaElement>): void;
    onInput(event: FormEvent<HTMLTextAreaElement>): void;
    onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void;
    onFocus(event: FocusEvent<HTMLTextAreaElement>): void;
    onBlur(event: FocusEvent<HTMLTextAreaElement>): void;
    onCompositionStart(event: CompositionEvent<HTMLTextAreaElement>): void;
    onCompositionUpdate(event: CompositionEvent<HTMLTextAreaElement>): void;
    onCompositionEnd(event: CompositionEvent<HTMLTextAreaElement>): void;
  };
}) {
  return (
    <div
      className="browser-remote-keyboard"
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
      <button type="button" disabled={!enabled} onClick={() => fieldRef.current?.blur()} aria-label={t('Close')}>
        <X size={16} />
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
  const requestHelper = useCallback(() => {
    setHelperNotSent(false);
    void installHelper().then((sent) => {
      if (!sent) setHelperNotSent(true);
    });
  }, [installHelper]);
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
  const cursorStore = useMemo(() => createScreenCursorStore(
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

  // Keyboard: text and keys, IME composition kept like the page keyboard.
  const text = useMemo(() => createScreenTextController({ emit: sendAll }), [sendAll]);
  const keyboard = useMemo(
    () => ({
      onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
        event.stopPropagation();
        const { key, code, keyCode, isComposing } = event.nativeEvent;
        const { ctrlKey, altKey, metaKey, shiftKey } = event;
        if (text.keyDown({ key, code, keyCode, isComposing, ctrlKey, altKey, metaKey, shiftKey })) event.preventDefault();
      },
      onKeyUp: () => text.keyUp(),
      onInput: (event: FormEvent<HTMLTextAreaElement>) =>
        text.input(event.currentTarget, (event.nativeEvent as InputEvent).isComposing),
      onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
        event.preventDefault();
        event.stopPropagation();
        text.paste(event.clipboardData.getData('text/plain'));
      },
      onFocus: (event: FocusEvent<HTMLTextAreaElement>) => text.focus(event.currentTarget),
      onBlur: (event: FocusEvent<HTMLTextAreaElement>) => text.blur(event.currentTarget),
      onCompositionStart: () => text.compositionStart(),
      onCompositionUpdate: () => {},
      onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) =>
        text.compositionEnd(event.data, event.currentTarget),
    }),
    [text]
  );
  const composition = useCompositionFinisher(keyboard, fieldRef);

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

  // Fingers pan and zoom the picture whenever it is live; what they would
  // send is refused by the central gate unless the PC accepts control. A new
  // strategy rebinds, which lifts a button a long-press still held.
  const live = view.kind === 'live';
  const finishComposition = composition.finish;
  useEffect(() => {
    const stage = stageRef.current;
    if (!live || !stage) return undefined;
    const dispose = bindScreenTouch({
      stage,
      mode,
      viewport,
      cursor: cursorStore,
      send: (action) => sendAll(adapter.screenInputFromGesture(action)),
      // A press on the picture commits a half-typed syllable first.
      beforePress: finishComposition,
      ring: (x, y, radius) => {
        if (controllableRef.current) showRing(stage, x, y, radius);
      },
    });
    return () => {
      dispose();
      releaseRef.current();
    };
  }, [live, mode, viewport, cursorStore, adapter, sendAll, finishComposition]);

  const chooseMode = useCallback((next: ScreenInputMode) => setMode(next), []);
  const controlling = bar.enabled;
  const menu: DockAction[] = [
    ...SCREEN_SPECIAL_KEYS.map(
      (special): DockAction => ({
        id: `key-${special.id}`,
        label: special.label,
        detail:
          special.needsHelper && screen.status?.helper !== 'active' ? t('Needs the secure desktop helper') : undefined,
        disabled: !controlling,
        onSelect: () => sendAll(screenSpecialKeyInputs(special.id)),
      })
    ),
    {
      id: 'mode-direct',
      label: t('Direct touch'),
      checked: mode === 'direct',
      separatorBefore: true,
      onSelect: () => chooseMode('direct'),
    },
    { id: 'mode-trackpad', label: t('Trackpad'), checked: mode === 'trackpad', onSelect: () => chooseMode('trackpad') },
  ];

  let toolbarText = sizeLabel(width, height);
  if (view.kind === 'live') {
    toolbarText = t(view.control ? '{{size}} · Controlling' : '{{size}} · View only', { size: toolbarText });
  }
  const blocked = view.kind === 'blocked' ? view : null;
  const showPicture = view.kind === 'live' || blocked !== null;

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
            panel={screenHelperPanel(screen.helper, screen.helperPending, screen.status?.helper)}
            onInstall={requestHelper}
          />
        )}
        {view.kind === 'connecting' && (
          <ScreenStateCard>
            <ProgressSpinner size={24} />
            <span>{t('Connecting to PC screen…')}</span>
          </ScreenStateCard>
        )}
        {view.kind === 'failed' && (
          <ScreenStateCard>
            <ErrorNotice error={t('The connection to the PC ended.')} title={t('Could not connect to PC screen')} role="status" />
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
        {(notSent || helperNotSent) && (
          <div className="browser-remote-status">
            <ErrorNotice
              error={helperNotSent ? t('The request could not be sent to the PC.') : t('Input was not sent.')}
              role="status"
              onDismiss={() => {
                setNotSent(false);
                setHelperNotSent(false);
              }}
            />
          </div>
        )}
      </div>
      {bar.present && (
        <ScreenKeyboardBar
          fieldRef={fieldRef}
          handlers={composition.handlers}
          visible={bar.visible}
          enabled={bar.enabled}
        />
      )}
    </div>
  );
}
