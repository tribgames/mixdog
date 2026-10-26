// The phone's whole-PC screen view (design/mockups/remote-screen, frames C, D2,
// D3; docs/remote-screen.md): the PC picture over WebRTC, the one-line remote
// keyboard docked at the bottom, special keys and the touch strategy in ⋯,
// and the secure-desktop / stopped states from the PC's `screen-status`.
// Finger gestures reach it through `bindGestures` (remote-screen-gesture.ts).
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
import {
  createScreenGestureAdapter,
  type ScreenGestureAction,
  type ScreenInputMode,
  type ScreenPoint,
} from './remote-screen-gesture';
import { SCREEN_SPECIAL_KEYS, createScreenTextController, screenSpecialKeyInputs } from './remote-screen-keys';
import {
  installScreenReleaseTriggers,
  screenKeyboardBar,
  type ScreenBlockReason,
  type ScreenView,
} from './remote-screen-state';
import { useRemoteScreen } from './use-remote-screen';

const RELEASE: RemoteScreenInput = { type: 'screen-release' };

/** What the touch layer is given to drive the stage. It returns its disposer. */
export interface ScreenGestureTarget {
  stage: HTMLElement;
  video: HTMLVideoElement;
  mode: ScreenInputMode;
  /** One gesture action → its screen input, in order. */
  send(action: ScreenGestureAction): void;
  /** An interrupted long-press drag. */
  cancel(): void;
}

export interface RemoteScreenPaneProps {
  display: RemoteScreenDisplaySummary;
  onClose(): void;
  /** The display went away: pick again (the host lists displays afresh). */
  onPickAgain(): void;
  /** Wires the touch gestures and viewport to the stage (not built in). */
  bindGestures?(target: ScreenGestureTarget): () => void;
  /** Trackpad mode's cursor on the PC picture, once the PC reports it. */
  cursorSource?(): ScreenPoint | null;
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

function BlockedNote({ view }: { view: Extract<ScreenView, { kind: 'blocked' }> }) {
  const copy = BLOCK_COPY[view.reason];
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

export default function RemoteScreenPane({
  display,
  onClose,
  onPickAgain,
  bindGestures,
  cursorSource,
}: RemoteScreenPaneProps) {
  const api = window.mixdogDesktop;
  const screen = useRemoteScreen({ api, screenId: display.screenId });
  const { view, send, retry, geometry } = screen;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const [mode, setMode] = useState<ScreenInputMode>('direct');
  const [notSent, setNotSent] = useState(false);
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
          (input.type === 'screen-key' || input.type === 'screen-text')
        ) {
          setNotSent(true);
        }
      }
    },
    [send]
  );
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };
  const cursorRef = useRef(cursorSource);
  cursorRef.current = cursorSource;
  const adapter = useMemo(
    () => createScreenGestureAdapter({ size: () => sizeRef.current, cursor: () => cursorRef.current?.() ?? null }),
    []
  );

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

  const sendGesture = useCallback(
    (action: ScreenGestureAction) => {
      // A press on the picture commits a half-typed syllable first.
      if (action.type === 'tap' || action.type === 'drag-start') composition.finish();
      sendAll(adapter.screenInputFromGesture(action));
    },
    [adapter, sendAll, composition]
  );
  // The touch layer is bound only while the PC accepts control.
  const controllable = bar.enabled;
  useEffect(() => {
    const stage = stageRef.current;
    const video = screen.videoRef.current;
    if (!bindGestures || !controllable || !stage || !video) return undefined;
    return bindGestures({ stage, video, mode, send: sendGesture, cancel: () => sendGesture({ type: 'drag-cancel' }) });
  }, [bindGestures, controllable, mode, sendGesture, screen.videoRef]);

  const chooseMode = useCallback(
    (next: ScreenInputMode) => {
      sendAll(adapter.setMode(next));
      setMode(next);
    },
    [adapter, sendAll]
  );
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
  const ratio = `${width} / ${height}`;
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
          className="remote-screen-fit"
          data-dim={blocked?.dim ? 'true' : 'false'}
          // Decoding (and reporting frames) under the state card until promoted.
          style={{ '--screen-ratio': ratio, opacity: showPicture ? 1 : 0 } as CSSProperties}
        >
          <video
            ref={screen.videoRef}
            muted
            playsInline
            autoPlay
            disablePictureInPicture
            aria-hidden={showPicture ? undefined : true}
          />
          {blocked && <BlockedNote view={blocked} />}
        </div>
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
        {notSent && (
          <div className="browser-remote-status">
            <ErrorNotice error={t('Input was not sent.')} role="status" onDismiss={() => setNotSent(false)} />
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
