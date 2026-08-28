import type { WebContents } from 'electron';

export type BrowserInputOutcome = 'completed' | 'dialog';
export type BrowserMouseButton = 'left' | 'right' | 'middle';
export type BrowserKeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

type SendBrowserInput = (
  guest: WebContents,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<BrowserInputOutcome>;

const KEY_TABLE: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

export function normalizeMouseButton(value: unknown): BrowserMouseButton {
  const button = String(value || 'left').trim().toLowerCase();
  if (button === 'left' || button === 'right' || button === 'middle') return button;
  throw new Error('click button must be left, right, or middle');
}

export function normalizeModifierMask(value: unknown): number {
  if (value === undefined) return 0;
  if (!Array.isArray(value)) throw new Error('click modifiers must be an array');
  let mask = 0;
  for (const raw of value) {
    const modifier = String(raw || '').trim().toLowerCase();
    if (modifier === 'alt') mask |= 1;
    else if (modifier === 'control' || modifier === 'ctrl') mask |= 2;
    else if (modifier === 'meta' || modifier === 'command' || modifier === 'cmd') mask |= 4;
    else if (modifier === 'shift') mask |= 8;
    else throw new Error(`unsupported click modifier "${String(raw)}"`);
  }
  return mask;
}

function cssPoint(point: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

export function createBrowserInputDriver(send: SendBrowserInput) {
  async function pressKey(
    guest: WebContents,
    rawKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const parts = String(rawKey || '').trim().split('+').map((part) => part.trim()).filter(Boolean);
    const keyName = parts.pop() || '';
    const modifierNames = new Set(parts.map((part) => part.toLowerCase()));
    const modifierBits = normalizeModifierMask([...modifierNames]);
    const normalized = keyName.toLowerCase();
    const printable = keyName.length === 1
      ? {
        key: modifierNames.has('shift') ? keyName.toUpperCase() : keyName,
        code: /[a-z]/i.test(keyName) ? `Key${keyName.toUpperCase()}` : `Digit${keyName}`,
        keyCode: keyName.toUpperCase().charCodeAt(0),
        text: modifierBits === 0 ? keyName : undefined,
      }
      : null;
    const spec = KEY_TABLE[normalized] || printable;
    if (!spec) {
      throw new Error(`unsupported key "${rawKey}"; use a character, modifier combination, or one of: ${Object.keys(KEY_TABLE).join(', ')}`);
    }
    const base = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      modifiers: modifierBits,
    };
    if (await send(guest, 'Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' }, signal) === 'dialog') return;
    if (spec.text) {
      if (await send(
        guest,
        'Input.dispatchKeyEvent',
        { ...base, type: 'char', text: spec.text },
        signal,
      ) === 'dialog') return;
    }
    await send(guest, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, signal);
  }

  async function clickAt(
    guest: WebContents,
    cssX: number,
    cssY: number,
    clickCount = 1,
    button: BrowserMouseButton = 'left',
    modifiers = 0,
    signal?: AbortSignal,
  ): Promise<void> {
    const { x, y } = cssPoint({ x: cssX, y: cssY });
    const base = { x, y, button, clickCount, modifiers };
    if (await send(
      guest,
      'Input.dispatchMouseEvent',
      { ...base, type: 'mouseMoved', button: 'none' },
      signal,
    ) === 'dialog') return;
    if (await send(
      guest,
      'Input.dispatchMouseEvent',
      { ...base, type: 'mousePressed' },
      signal,
    ) === 'dialog') return;
    await send(guest, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, signal);
  }

  async function hoverAt(
    guest: WebContents,
    cssX: number,
    cssY: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const point = cssPoint({ x: cssX, y: cssY });
    await send(guest, 'Input.dispatchMouseEvent', {
      ...point,
      type: 'mouseMoved',
      button: 'none',
    }, signal);
  }

  async function dragAt(
    guest: WebContents,
    source: { x: number; y: number },
    target: { x: number; y: number },
    signal?: AbortSignal,
  ): Promise<void> {
    const start = cssPoint(source);
    const end = cssPoint(target);
    if (await send(guest, 'Input.dispatchMouseEvent', {
      ...start, type: 'mouseMoved', button: 'none',
    }, signal) === 'dialog') return;
    if (await send(guest, 'Input.dispatchMouseEvent', {
      ...start, type: 'mousePressed', button: 'left', clickCount: 1,
    }, signal) === 'dialog') return;
    for (let step = 1; step <= 8; step += 1) {
      if (await send(guest, 'Input.dispatchMouseEvent', {
        x: Math.round(start.x + (end.x - start.x) * step / 8),
        y: Math.round(start.y + (end.y - start.y) * step / 8),
        type: 'mouseMoved',
        button: 'left',
        buttons: 1,
      }, signal) === 'dialog') return;
    }
    await send(guest, 'Input.dispatchMouseEvent', {
      ...end, type: 'mouseReleased', button: 'left', clickCount: 1,
    }, signal);
  }

  async function tapAt(
    guest: WebContents,
    point: { x: number; y: number },
    signal?: AbortSignal,
  ): Promise<void> {
    const zoom = guest.getZoomFactor();
    const touch = {
      ...cssPoint({ x: point.x / zoom, y: point.y / zoom }),
      radiusX: 1,
      radiusY: 1,
      force: 1,
      id: 0,
    };
    await send(guest, 'Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [touch],
    }, signal);
    await send(guest, 'Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    }, signal);
  }

  async function swipeAt(
    guest: WebContents,
    source: { x: number; y: number },
    destination: { x: number; y: number },
    signal?: AbortSignal,
  ): Promise<void> {
    const zoom = guest.getZoomFactor();
    const touch = (x: number, y: number) => ({
      ...cssPoint({ x: x / zoom, y: y / zoom }),
      radiusX: 1,
      radiusY: 1,
      force: 1,
      id: 0,
    });
    await send(guest, 'Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [touch(source.x, source.y)],
    }, signal);
    for (let step = 0; step <= 10; step += 1) {
      await send(guest, 'Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [touch(
          source.x + (destination.x - source.x) * step / 10,
          source.y + (destination.y - source.y) * step / 10,
        )],
      }, signal);
    }
    await send(guest, 'Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    }, signal);
  }

  async function scrollAt(
    guest: WebContents,
    point: { x: number; y: number },
    deltaX: number,
    deltaY: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await send(guest, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      ...cssPoint(point),
      deltaX,
      deltaY,
      button: 'none',
    }, signal);
  }

  return {
    pressKey,
    clickAt,
    hoverAt,
    dragAt,
    tapAt,
    swipeAt,
    scrollAt,
  };
}
