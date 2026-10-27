import { useEffect, useMemo, useRef } from 'react';
import type {
  RefObject,
  PointerEvent,
  KeyboardEvent,
  ClipboardEvent,
  FocusEvent,
  FormEvent,
  CompositionEvent,
  WheelEvent,
} from 'react';
import type { DesktopBrowserPageAction } from '../shared/contract';
import { remoteBrowserImagePoint } from '../shared/remote-browser';
import { createSendBar, type SendBarKey } from './remote-send-bar';

/** What the input hook needs from a page client: the local isolated page
 * client and the relay-stream adapter both satisfy it. */
export interface BrowserPageInputClient {
  frame(): { width: number; height: number; viewportWidth: number; viewportHeight: number } | null;
  fire(action: DesktopBrowserPageAction, token?: string): void;
  shortcut(shortcut: string): void;
  inputToken(): string;
}

const POINTER_BUTTONS: Partial<Record<number, 'middle' | 'right'>> = { 1: 'middle', 2: 'right' };
const POINTER_BUTTON_BITS: Partial<Record<number, number>> = { 0: 1, 1: 4 };
const COMMAND_KEY_SHORTCUTS: Partial<Record<string, string>> = { l: 'address', '0': 'zoom-reset', '-': 'zoom-out' };

export function useBrowserPageInput(
  client: BrowserPageInputClient,
  image: RefObject<HTMLElement | null>,
  keyboard: RefObject<HTMLTextAreaElement | null>,
  /** `sendAtOnce` (the phone's typing bar): what is typed stays in the bar and
   *  goes to the page in one piece on send (remote-send-bar.ts). Off, typing
   *  and IME composition reach the page live. */
  options: { sendAtOnce?: boolean } = {}
) {
  const sendAtOnce = useRef(false);
  sendAtOnce.current = options.sendAtOnce === true;
  const clientRef = useRef(client);
  clientRef.current = client;
  const pressKeyRef = useRef<(press: SendBarKey) => void>(() => {});
  const bar = useMemo(
    () =>
      createSendBar({
        text: (text) => clientRef.current.fire({ type: 'text', text }),
        key: (press) => pressKeyRef.current(press),
      }),
    []
  );
  // `beforeinput` is native only (React's onBeforeInput is another event): a
  // soft keyboard's line break is Send. Rebound each render: the bar mounts late.
  useEffect(() => {
    const field = keyboard.current;
    if (!field) return undefined;
    const listener = (event: Event) => {
      if (sendAtOnce.current && bar.beforeInput({ inputType: (event as InputEvent).inputType }, field))
        event.preventDefault();
    };
    field.addEventListener('beforeinput', listener);
    return () => field.removeEventListener('beforeinput', listener);
  });
  const composing = useRef(false);
  const compositionOwner = useRef<{ client: typeof client; token: string } | null>(null);
  const pressed = useRef(new Map<number, 'left' | 'middle' | 'right'>());
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const point = (x: number, y: number) => {
    if (image.current?.hidden) return null;
    const frame = client.frame();
    const bounds = image.current?.getBoundingClientRect();
    const pixel = frame && bounds ? remoteBrowserImagePoint(bounds, frame, { x, y }) : null;
    return pixel && frame
      ? {
          x: (pixel.x * frame.viewportWidth) / frame.width,
          y: (pixel.y * frame.viewportHeight) / frame.height,
        }
      : null;
  };
  const pointer = (event: PointerEvent<HTMLDivElement>, phase: 'mouseMoved' | 'mousePressed' | 'mouseReleased') => {
    // The page transport supports only left, right, and middle buttons.
    // Do not turn auxiliary-button presses/releases into left clicks.
    if (phase !== 'mouseMoved' && event.button > 2) {
      event.preventDefault();
      return;
    }
    const buttons = event.buttons & 7;
    const position = point(event.clientX, event.clientY) ?? (phase === 'mouseReleased' ? lastPoint.current : null);
    if (!position) return;
    lastPoint.current = position;
    event.preventDefault();
    const button =
      phase === 'mouseMoved'
        ? ([...pressed.current.values()].at(-1) ?? 'none')
        : (POINTER_BUTTONS[event.button] ?? 'left');
    if (phase === 'mousePressed' && button !== 'none') {
      pressed.current.set(event.button, button);
      event.currentTarget.setPointerCapture(event.pointerId);
      keyboard.current?.focus({ preventScroll: true });
    }
    if (phase === 'mouseReleased') pressed.current.delete(event.button);
    client.fire({
      type: 'pointer',
      phase,
      ...position,
      button: phase === 'mouseMoved' && !buttons ? 'none' : button,
      buttons,
      modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0),
      clickCount: Math.min(3, Math.max(1, event.detail)),
    });
  };
  /** A key or chord for the page: the browser shortcuts first (reload, zoom,
   *  address, back / forward), else the key itself. */
  const pressKey = (press: SendBarKey) => {
    const command = press.ctrlKey || press.metaKey;
    const key = press.key.toLowerCase();
    if (key === 'f5' || (command && key === 'r')) {
      client.fire({ type: 'reload' });
      return;
    }
    if (command && ['+', '=', '-', '0', 'l'].includes(key)) {
      client.shortcut(COMMAND_KEY_SHORTCUTS[key] ?? 'zoom-in');
      return;
    }
    if (press.altKey && ['arrowleft', 'arrowright'].includes(key)) {
      client.fire({ type: key === 'arrowleft' ? 'back' : 'forward' });
      return;
    }
    const modifiers = [
      press.ctrlKey && 'Control',
      press.metaKey && 'Meta',
      press.altKey && 'Alt',
      press.shiftKey && 'Shift',
    ].filter(Boolean);
    client.fire({ type: 'key', key: [...modifiers, press.key === ' ' ? 'Space' : press.key].join('+') });
  };
  pressKeyRef.current = pressKey;
  const text = (element: HTMLTextAreaElement) => {
    const value = element.value;
    element.value = '';
    if (value) client.fire({ type: 'text', text: value });
  };
  const releasePointer = () => {
    if (!lastPoint.current) return;
    for (const [index, button] of pressed.current) {
      pressed.current.delete(index);
      const buttons = [...pressed.current.keys()].reduce((bits, key) => bits | (POINTER_BUTTON_BITS[key] ?? 2), 0);
      client.fire({
        type: 'pointer',
        phase: 'mouseReleased',
        ...lastPoint.current,
        button,
        buttons,
        modifiers: 0,
        clickCount: 1,
      });
    }
  };
  return {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => pointer(event, 'mousePressed'),
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => pointer(event, 'mouseMoved'),
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => pointer(event, 'mouseReleased'),
    onPointerCancel: releasePointer,
    onBlur: (event: FocusEvent<HTMLTextAreaElement>) => {
      releasePointer();
      if (sendAtOnce.current) bar.blur(event.currentTarget);
    },
    onFocus: (event: FocusEvent<HTMLTextAreaElement>) => {
      if (sendAtOnce.current) bar.focus(event.currentTarget);
    },
    onKeyUp: () => {
      if (sendAtOnce.current) bar.keyUp();
    },
    onWheel: (event: WheelEvent<HTMLDivElement>) => {
      const position = point(event.clientX, event.clientY);
      if (!position) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        if (event.deltaY) client.shortcut(event.deltaY < 0 ? 'zoom-in' : 'zoom-out');
        return;
      }
      let unit = 1;
      if (event.deltaMode === 1) unit = 16;
      else if (event.deltaMode === 2) unit = event.currentTarget.clientHeight;
      const frame = client.frame()!;
      const bounds = image.current!.getBoundingClientRect();
      const scale = Math.min(bounds.width / frame.width, bounds.height / frame.height);
      client.fire({
        type: 'wheel',
        ...position,
        deltaX:
          ((event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit * frame.viewportWidth) /
          (frame.width * scale),
        deltaY:
          ((event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit * frame.viewportHeight) / (frame.height * scale),
      });
    },
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      event.stopPropagation();
      const press = {
        key: event.key,
        code: event.code,
        keyCode: event.nativeEvent.keyCode,
        isComposing: event.nativeEvent.isComposing,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      };
      if (sendAtOnce.current) {
        if (bar.keyDown(press, event.currentTarget)) event.preventDefault();
        return;
      }
      if (composing.current || press.isComposing || press.keyCode === 229 || event.key === 'Process') return;
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
      event.preventDefault();
      pressKey(press);
    },
    /** The bar's send button: the bar's whole text to the page (a running
     *  composition is committed first), or an Enter key when the bar is empty. */
    submit: () => {
      const field = keyboard.current;
      if (sendAtOnce.current && field) bar.send(field, document.activeElement === field);
      else client.fire({ type: 'key', key: 'Enter' });
    },
    onInput: (event: FormEvent<HTMLTextAreaElement>) => {
      const isComposing = (event.nativeEvent as InputEvent).isComposing;
      if (sendAtOnce.current) bar.input(event.currentTarget, isComposing);
      else if (!composing.current && !isComposing) text(event.currentTarget);
    },
    onCompositionStart: () => {
      if (sendAtOnce.current) {
        bar.compositionStart();
        return;
      }
      composing.current = true;
      compositionOwner.current = { client, token: client.inputToken() };
    },
    onCompositionUpdate: (event: CompositionEvent<HTMLTextAreaElement>) => {
      if (sendAtOnce.current) return;
      const owner = compositionOwner.current;
      if (owner)
        owner.client.fire(
          {
            type: 'composition',
            text: event.data,
            selectionStart: event.data.length,
            selectionEnd: event.data.length,
          },
          owner.token
        );
    },
    onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => {
      if (sendAtOnce.current) {
        bar.compositionEnd(event.currentTarget);
        return;
      }
      composing.current = false;
      const owner = compositionOwner.current;
      compositionOwner.current = null;
      event.currentTarget.value = '';
      if (owner) owner.client.fire({ type: 'composition-end', text: event.data }, owner.token);
    },
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
      // Into the bar: it goes with the rest of the text on send.
      if (sendAtOnce.current) {
        bar.paste();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const value = event.clipboardData.getData('text/plain');
      if (value) client.fire({ type: 'text', text: value });
    },
  };
}
