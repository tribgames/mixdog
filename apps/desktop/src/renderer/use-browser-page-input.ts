import { useRef } from 'react';
import type {
  RefObject,
  PointerEvent,
  KeyboardEvent,
  ClipboardEvent,
  FormEvent,
  CompositionEvent,
  WheelEvent,
} from 'react';
import type { createBrowserPageClient } from './browser-page-client';
import { remoteBrowserImagePoint } from '../shared/remote-browser';

const POINTER_BUTTONS: Partial<Record<number, 'middle' | 'right'>> = { 1: 'middle', 2: 'right' };
const POINTER_BUTTON_BITS: Partial<Record<number, number>> = { 0: 1, 1: 4 };
const COMMAND_KEY_SHORTCUTS: Partial<Record<string, string>> = { l: 'address', '0': 'zoom-reset', '-': 'zoom-out' };

export function useBrowserPageInput(
  client: ReturnType<typeof createBrowserPageClient>,
  image: RefObject<HTMLElement | null>,
  keyboard: RefObject<HTMLTextAreaElement | null>
) {
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
    onBlur: releasePointer,
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
      if (
        composing.current ||
        event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === 229 ||
        event.key === 'Process'
      )
        return;
      const command = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (key === 'f5' || (command && key === 'r')) {
        event.preventDefault();
        client.fire({ type: 'reload' });
        return;
      }
      if (command && ['+', '=', '-', '0', 'l'].includes(key)) {
        event.preventDefault();
        client.shortcut(COMMAND_KEY_SHORTCUTS[key] ?? 'zoom-in');
        return;
      }
      if (event.altKey && ['arrowleft', 'arrowright'].includes(key)) {
        event.preventDefault();
        client.fire({ type: key === 'arrowleft' ? 'back' : 'forward' });
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
      event.preventDefault();
      const modifiers = [
        event.ctrlKey && 'Control',
        event.metaKey && 'Meta',
        event.altKey && 'Alt',
        event.shiftKey && 'Shift',
      ].filter(Boolean);
      client.fire({ type: 'key', key: [...modifiers, event.key === ' ' ? 'Space' : event.key].join('+') });
    },
    onInput: (event: FormEvent<HTMLTextAreaElement>) => {
      if (!composing.current && !(event.nativeEvent as InputEvent).isComposing) text(event.currentTarget);
    },
    onCompositionStart: () => {
      composing.current = true;
      compositionOwner.current = { client, token: client.inputToken() };
    },
    onCompositionUpdate: (event: CompositionEvent<HTMLTextAreaElement>) => {
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
      composing.current = false;
      const owner = compositionOwner.current;
      compositionOwner.current = null;
      event.currentTarget.value = '';
      if (owner) owner.client.fire({ type: 'composition-end', text: event.data }, owner.token);
    },
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const value = event.clipboardData.getData('text/plain');
      if (value) client.fire({ type: 'text', text: value });
    },
  };
}
