// The whole-PC screen pane's input wiring: the typing bar's handlers (text
// stays in the bar until Send, remote-send-bar.ts) and the finger layer on the
// stage (remote-screen-touch.ts). The two never meet: a touch on the picture
// (pinch, pan, fling, tap, two-finger tap) never focuses the bar's field, so
// it can never open the soft keyboard; only a direct tap on the bar does.
import {
  useCallback,
  useEffect,
  useMemo,
  type ClipboardEvent,
  type CompositionEvent,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import type { RemoteScreenInput } from '../shared/remote-webrtc';
import type { ScreenGestureAction, ScreenInputMode } from './remote-screen-gesture';
import { createScreenTextController } from './remote-screen-keys';
import { bindScreenTouch, type createScreenCursorStore } from './remote-screen-touch';
import type { ViewportStore } from './remote-touch-gestures';

export interface ScreenKeyboardHandlers {
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onKeyUp(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void;
  onInput(event: FormEvent<HTMLTextAreaElement>): void;
  onFocus(event: FocusEvent<HTMLTextAreaElement>): void;
  onBlur(event: FocusEvent<HTMLTextAreaElement>): void;
  onCompositionStart(event: CompositionEvent<HTMLTextAreaElement>): void;
  onCompositionEnd(event: CompositionEvent<HTMLTextAreaElement>): void;
}

export function useScreenInput({
  stageRef,
  fieldRef,
  live,
  mode,
  viewport,
  cursor,
  adapter,
  sendAll,
  ring,
  releaseRef,
}: {
  stageRef: RefObject<HTMLElement | null>;
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  /** Fingers drive the picture only while it is live. */
  live: boolean;
  mode: ScreenInputMode;
  viewport: ViewportStore;
  cursor: ReturnType<typeof createScreenCursorStore>;
  adapter: { screenInputFromGesture(action: ScreenGestureAction): RemoteScreenInput[] };
  /** Delivers inputs; the pane's central gate decides whether they go. */
  sendAll(inputs: RemoteScreenInput[]): void;
  ring(stage: HTMLElement, x: number, y: number, radius: number): void;
  /** Lifts everything held on the PC. */
  releaseRef: RefObject<() => void>;
}): { handlers: ScreenKeyboardHandlers; onSend(): void } {
  const text = useMemo(() => createScreenTextController({ emit: sendAll }), [sendAll]);
  const handlers = useMemo<ScreenKeyboardHandlers>(
    () => ({
      onKeyDown: (event) => {
        event.stopPropagation();
        const native = event.nativeEvent;
        const handled = text.keyDown(
          {
            key: event.key,
            code: event.code,
            keyCode: native.keyCode,
            isComposing: native.isComposing,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
          },
          event.currentTarget
        );
        if (handled) event.preventDefault();
      },
      onPaste: () => text.paste(),
      onKeyUp: () => text.keyUp(),
      onInput: (event) => text.input(event.currentTarget, (event.nativeEvent as InputEvent).isComposing),
      onFocus: (event) => text.focus(event.currentTarget),
      onBlur: (event) => text.blur(event.currentTarget),
      onCompositionStart: () => text.compositionStart(),
      onCompositionEnd: (event) => text.compositionEnd(event.currentTarget),
    }),
    [text]
  );
  const onSend = useCallback(() => {
    const field = fieldRef.current;
    if (field) text.send(field, document.activeElement === field);
  }, [fieldRef, text]);

  // `beforeinput` is native only (React's onBeforeInput is another event): a
  // soft keyboard's line break is Send. Rebound each render: the bar mounts late.
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return undefined;
    const listener = (event: Event) => {
      if (text.beforeInput({ inputType: (event as InputEvent).inputType }, field)) event.preventDefault();
    };
    field.addEventListener('beforeinput', listener);
    return () => field.removeEventListener('beforeinput', listener);
  });

  // Fingers pan and zoom the picture whenever it is live; what they would
  // send is refused by the central gate unless the PC accepts control. A new
  // strategy rebinds, which lifts a button a long-press still held.
  useEffect(() => {
    const stage = stageRef.current;
    if (!live || !stage) return undefined;
    const dispose = bindScreenTouch({
      stage,
      mode,
      viewport,
      cursor,
      send: (action) => sendAll(adapter.screenInputFromGesture(action)),
      ring: (x, y, radius) => ring(stage, x, y, radius),
    });
    return () => {
      dispose();
      releaseRef.current?.();
    };
  }, [stageRef, live, mode, viewport, cursor, adapter, sendAll, ring, releaseRef]);

  return { handlers, onSend };
}
