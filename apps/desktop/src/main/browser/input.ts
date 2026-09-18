import type { WebContents } from 'electron';
import { measureBrowserMouseEvent, timedBrowserOperation } from './timing';

export type BrowserInputOutcome = 'completed' | 'dialog';
export type BrowserMouseButton = 'left' | 'right' | 'middle';
export type BrowserKeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

type SendBrowserInput = (
  guest: WebContents,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
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
  const button = String(value || 'left')
    .trim()
    .toLowerCase();
  if (button === 'left' || button === 'right' || button === 'middle') return button;
  throw new Error('click button must be left, right, or middle');
}

export function normalizeModifierMask(value: unknown): number {
  if (value === undefined) return 0;
  if (!Array.isArray(value)) throw new Error('click modifiers must be an array');
  let mask = 0;
  for (const raw of value) {
    const modifier = String(raw || '')
      .trim()
      .toLowerCase();
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

export function browserImagePointToCss(point: { x: number; y: number }, zoomFactor: number): { x: number; y: number } {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return { x: point.x / zoom, y: point.y / zoom };
}

export function assertBrowserKeyDoesNotAccessClipboard(rawKey: string): void {
  const parts = String(rawKey || '')
    .trim()
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const key = parts.at(-1) || '';
  const modifiers = new Set(parts.slice(0, -1));
  const controlOrMeta =
    modifiers.has('control') ||
    modifiers.has('ctrl') ||
    modifiers.has('meta') ||
    modifiers.has('command') ||
    modifiers.has('cmd');
  const clipboardLetter = key === 'c' || key === 'v' || key === 'x';
  const clipboardInsert = key === 'insert' && (controlOrMeta || modifiers.has('shift'));
  if ((controlOrMeta && clipboardLetter) || clipboardInsert) {
    throw new Error('Browser Use press cannot access the system clipboard');
  }
}

/** US-layout characters whose physical key cannot be derived from the
 *  character itself. Deriving it turns "." into Delete (46) and "-" into
 *  Insert (45) for every page that reads a keydown's code. */
const CHARACTER_KEYS: Record<string, { code: string; keyCode: number; shift?: boolean }> = {
  ' ': { code: 'Space', keyCode: 32 },
  '`': { code: 'Backquote', keyCode: 192 },
  '~': { code: 'Backquote', keyCode: 192, shift: true },
  '-': { code: 'Minus', keyCode: 189 },
  _: { code: 'Minus', keyCode: 189, shift: true },
  '=': { code: 'Equal', keyCode: 187 },
  '+': { code: 'Equal', keyCode: 187, shift: true },
  '[': { code: 'BracketLeft', keyCode: 219 },
  '{': { code: 'BracketLeft', keyCode: 219, shift: true },
  ']': { code: 'BracketRight', keyCode: 221 },
  '}': { code: 'BracketRight', keyCode: 221, shift: true },
  '\\': { code: 'Backslash', keyCode: 220 },
  '|': { code: 'Backslash', keyCode: 220, shift: true },
  ';': { code: 'Semicolon', keyCode: 186 },
  ':': { code: 'Semicolon', keyCode: 186, shift: true },
  "'": { code: 'Quote', keyCode: 222 },
  '"': { code: 'Quote', keyCode: 222, shift: true },
  ',': { code: 'Comma', keyCode: 188 },
  '<': { code: 'Comma', keyCode: 188, shift: true },
  '.': { code: 'Period', keyCode: 190 },
  '>': { code: 'Period', keyCode: 190, shift: true },
  '/': { code: 'Slash', keyCode: 191 },
  '?': { code: 'Slash', keyCode: 191, shift: true },
  '!': { code: 'Digit1', keyCode: 49, shift: true },
  '@': { code: 'Digit2', keyCode: 50, shift: true },
  '#': { code: 'Digit3', keyCode: 51, shift: true },
  $: { code: 'Digit4', keyCode: 52, shift: true },
  '%': { code: 'Digit5', keyCode: 53, shift: true },
  '^': { code: 'Digit6', keyCode: 54, shift: true },
  '&': { code: 'Digit7', keyCode: 55, shift: true },
  '*': { code: 'Digit8', keyCode: 56, shift: true },
  '(': { code: 'Digit9', keyCode: 57, shift: true },
  ')': { code: 'Digit0', keyCode: 48, shift: true },
};

const SHIFT_MODIFIER = 8;

/** Intermediate moves of one drag: enough for a page that tracks movement,
 *  few enough to stay one quick gesture. */
const DRAG_STEPS = 8;
const DRAG_INTERCEPT_POLLS = 5;
const DRAG_INTERCEPT_POLL_MS = 20;
/** Dropping a file copies it into the page; it never moves or links it. */
const DRAG_OPERATION_COPY = 1;

/** What Chromium hands over when it intercepts a page's own drag: the items
 *  the page put on the drag, plus the operations it allows. */
export interface BrowserDragData {
  items: Array<Record<string, unknown>>;
  files?: string[];
  dragOperationsMask: number;
}

/** The host's view of an intercepted drag. The driver never reads page state
 *  itself; it only asks whether this gesture turned into a native drag. */
export interface BrowserDragInterception {
  /** Forget a payload left by an earlier gesture. */
  reset(guest: WebContents): void;
  /** Take the payload this gesture produced, if Chromium delivered one. */
  take(guest: WebContents): BrowserDragData | null;
}

/** The physical key behind one character. A single `press` and typed text
 *  share it, so both report the same code, key code and shift state. */
function characterKey(character: string): { code: string; keyCode: number; shift: boolean } {
  const mapped = CHARACTER_KEYS[character];
  if (mapped) return { code: mapped.code, keyCode: mapped.keyCode, shift: mapped.shift ?? false };
  const letter = /^[a-z]$/i.test(character);
  const digit = /^[0-9]$/.test(character);
  // An unmapped character (any non-US-layout letter) keeps the empty code
  // and zero key code a browser reports for it.
  let code = '';
  if (letter) code = `Key${character.toUpperCase()}`;
  else if (digit) code = `Digit${character}`;
  return {
    code,
    keyCode: letter || digit ? character.toUpperCase().charCodeAt(0) : 0,
    // Only a shifted punctuation mark carries Shift by itself. "Control+A"
    // names the A key, not Control+Shift+A, so a letter never adds it here.
    shift: false,
  };
}

export function createBrowserInputDriver(
  send: SendBrowserInput,
  options: { allowClipboard?: boolean; drags?: BrowserDragInterception } = {}
) {
  async function pressKey(guest: WebContents, rawKey: string, signal?: AbortSignal): Promise<void> {
    if (!options.allowClipboard) assertBrowserKeyDoesNotAccessClipboard(rawKey);
    const raw = String(rawKey || '').trim();
    const plus = raw.endsWith('+');
    const parts = (plus ? raw.slice(0, -1) : raw)
      .split('+')
      .map((part) => part.trim())
      .filter(Boolean);
    if (plus) parts.push('+');
    const keyName = parts.pop() || '';
    const modifierNames = new Set(parts.map((part) => part.toLowerCase()));
    const character = keyName.length === 1 ? characterKey(keyName) : null;
    // A shifted character is Shift plus its base key; sending the base key
    // without Shift is a combination no keyboard can produce.
    const modifierBits = normalizeModifierMask([...modifierNames]) | (character?.shift ? SHIFT_MODIFIER : 0);
    // Shift still types a character; any other modifier makes it a shortcut.
    const typesText = (modifierBits & ~SHIFT_MODIFIER) === 0;
    const normalized = keyName.toLowerCase();
    const typed = modifierNames.has('shift') ? keyName.toUpperCase() : keyName;
    const printableText = typesText ? typed : undefined;
    const printable = character
      ? { key: typed, code: character.code, keyCode: character.keyCode, text: printableText }
      : null;
    const functionKey = /^f([1-9]|1\d|2[0-4])$/.test(normalized)
      ? {
          key: normalized.toUpperCase(),
          code: normalized.toUpperCase(),
          keyCode: 111 + Number(normalized.slice(1)),
          text: undefined,
        }
      : null;
    const spec = KEY_TABLE[normalized] || printable || functionKey;
    if (!spec) {
      throw new Error(
        `unsupported key "${rawKey}"; use a character, modifier combination, or one of: ${Object.keys(KEY_TABLE).join(', ')}`
      );
    }
    const base = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      modifiers: modifierBits,
    };
    if ((await send(guest, 'Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' }, signal)) === 'dialog') return;
    // Control+Enter is a shortcut, not a newline: a shortcut never types.
    if (spec.text && typesText) {
      if (
        (await send(guest, 'Input.dispatchKeyEvent', { ...base, type: 'char', text: spec.text }, signal)) === 'dialog'
      )
        return;
    }
    await send(guest, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, signal);
  }

  /** Typing the way a person does: one key event per character, so a search
   *  box that opens suggestions on keydown, or an editor that watches keys,
   *  reacts to it. Replacing a whole value in one step is `fill`. */
  async function typeText(guest: WebContents, text: string, signal?: AbortSignal): Promise<void> {
    for (const character of String(text ?? '')) {
      if (character === '\r') continue;
      if (character === '\n') {
        await pressKey(guest, 'enter', signal);
        continue;
      }
      const spec = characterKey(character);
      if (!spec.code) {
        // Outside the US layout — Korean, an accent, an emoji — no physical
        // key produces the character, so the browser's own text insertion
        // carries it and the page still sees an input event.
        if ((await send(guest, 'Input.insertText', { text: character }, signal)) === 'dialog') return;
        continue;
      }
      // Typing an uppercase letter is Shift plus its key, the way a person
      // produces it; pressing one as a shortcut key is not.
      const shifted = spec.shift || /^[A-Z]$/.test(character);
      const base = {
        key: character,
        code: spec.code,
        windowsVirtualKeyCode: spec.keyCode,
        nativeVirtualKeyCode: spec.keyCode,
        modifiers: shifted ? SHIFT_MODIFIER : 0,
      };
      if (
        (await send(guest, 'Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: character }, signal)) ===
        'dialog'
      )
        return;
      if ((await send(guest, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, signal)) === 'dialog') return;
    }
  }

  async function clickAt(
    guest: WebContents,
    cssX: number,
    cssY: number,
    clickCount = 1,
    button: BrowserMouseButton = 'left',
    modifiers = 0,
    signal?: AbortSignal
  ): Promise<void> {
    const { x, y } = cssPoint({ x: cssX, y: cssY });
    const base = { x, y, button, clickCount, modifiers };
    if (
      (await measureBrowserMouseEvent('mouseMoved', () =>
        send(guest, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none' }, signal)
      )) === 'dialog'
    )
      return;
    if (
      (await measureBrowserMouseEvent('mousePressed', () =>
        send(guest, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, signal)
      )) === 'dialog'
    )
      return;
    await measureBrowserMouseEvent('mouseReleased', () =>
      send(guest, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, signal)
    );
  }

  async function hoverAt(guest: WebContents, cssX: number, cssY: number, signal?: AbortSignal): Promise<void> {
    const point = cssPoint({ x: cssX, y: cssY });
    await send(
      guest,
      'Input.dispatchMouseEvent',
      {
        ...point,
        type: 'mouseMoved',
        button: 'none',
      },
      signal
    );
  }

  /** A page that answers a press-and-move with its own HTML5 drag never sees
   *  the rest of the mouse gesture: Chromium hands the drag payload to the
   *  host and then waits for drag events. Without that exchange a Kanban
   *  card or a file drop zone ignores the whole gesture, so the driver arms
   *  interception, watches for the payload, and finishes as a drop. A page
   *  that drags with plain mouse handlers stays on the mouse path. */
  async function dragAt(
    guest: WebContents,
    source: { x: number; y: number },
    target: { x: number; y: number },
    signal?: AbortSignal
  ): Promise<void> {
    const start = cssPoint(source);
    const end = cssPoint(target);
    const drags = options.drags;
    const dragEvent = (type: string, point: { x: number; y: number }, data: BrowserDragData) =>
      send(guest, 'Input.dispatchDragEvent', { ...point, type, data }, signal);
    drags?.reset(guest);
    if (drags) await send(guest, 'Input.setInterceptDrags', { enabled: true }, signal);
    try {
      if (
        (await send(guest, 'Input.dispatchMouseEvent', { ...start, type: 'mouseMoved', button: 'none' }, signal)) ===
        'dialog'
      )
        return;
      if (
        (await send(
          guest,
          'Input.dispatchMouseEvent',
          { ...start, type: 'mousePressed', button: 'left', clickCount: 1 },
          signal
        )) === 'dialog'
      )
        return;
      let data: BrowserDragData | null = null;
      let entered = false;
      for (let step = 1; step <= DRAG_STEPS; step += 1) {
        const point = {
          x: Math.round(start.x + ((end.x - start.x) * step) / DRAG_STEPS),
          y: Math.round(start.y + ((end.y - start.y) * step) / DRAG_STEPS),
        };
        if (data) {
          if ((await dragEvent('dragOver', point, data)) === 'dialog') return;
          continue;
        }
        if (
          (await send(
            guest,
            'Input.dispatchMouseEvent',
            { ...point, type: 'mouseMoved', button: 'left', buttons: 1 },
            signal
          )) === 'dialog'
        )
          return;
        data = drags?.take(guest) ?? null;
        if (data) {
          if ((await dragEvent('dragEnter', point, data)) === 'dialog') return;
          entered = true;
        }
      }
      // The payload can still be in flight when the last move returns.
      data ||= await waitForInterceptedDrag(guest, drags, signal);
      if (!data) {
        await send(
          guest,
          'Input.dispatchMouseEvent',
          { ...end, type: 'mouseReleased', button: 'left', clickCount: 1 },
          signal
        );
        return;
      }
      if (!entered && (await dragEvent('dragEnter', end, data)) === 'dialog') return;
      if ((await dragEvent('dragOver', end, data)) === 'dialog') return;
      await dragEvent('drop', end, data);
    } finally {
      if (drags) {
        await send(guest, 'Input.setInterceptDrags', { enabled: false }, signal).catch(() => undefined);
      }
    }
  }

  /** Files delivered the way a person drops them: the payload is announced
   *  first, so a zone that only listens for a drag sees it coming. */
  async function dropFilesAt(
    guest: WebContents,
    point: { x: number; y: number },
    paths: string[],
    signal?: AbortSignal
  ): Promise<void> {
    const data = { items: [], files: [...paths], dragOperationsMask: DRAG_OPERATION_COPY };
    const at = cssPoint(point);
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      if ((await send(guest, 'Input.dispatchDragEvent', { ...at, type, data }, signal)) === 'dialog') return;
    }
  }

  async function waitForInterceptedDrag(
    guest: WebContents,
    drags: BrowserDragInterception | undefined,
    signal?: AbortSignal
  ): Promise<BrowserDragData | null> {
    if (!drags) return null;
    for (let attempt = 0; attempt < DRAG_INTERCEPT_POLLS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, DRAG_INTERCEPT_POLL_MS));
      signal?.throwIfAborted();
      const data = drags.take(guest);
      if (data) return data;
    }
    return null;
  }

  async function tapAt(guest: WebContents, point: { x: number; y: number }, signal?: AbortSignal): Promise<void> {
    const zoom = guest.getZoomFactor();
    const touch = {
      ...cssPoint({ x: point.x / zoom, y: point.y / zoom }),
      radiusX: 1,
      radiusY: 1,
      force: 1,
      id: 0,
    };
    await send(
      guest,
      'Input.dispatchTouchEvent',
      {
        type: 'touchStart',
        touchPoints: [touch],
      },
      signal
    );
    await send(
      guest,
      'Input.dispatchTouchEvent',
      {
        type: 'touchEnd',
        touchPoints: [],
      },
      signal
    );
  }

  async function swipeAt(
    guest: WebContents,
    source: { x: number; y: number },
    destination: { x: number; y: number },
    signal?: AbortSignal
  ): Promise<void> {
    const zoom = guest.getZoomFactor();
    const touch = (x: number, y: number) => ({
      ...cssPoint({ x: x / zoom, y: y / zoom }),
      radiusX: 1,
      radiusY: 1,
      force: 1,
      id: 0,
    });
    await send(
      guest,
      'Input.dispatchTouchEvent',
      {
        type: 'touchStart',
        touchPoints: [touch(source.x, source.y)],
      },
      signal
    );
    for (let step = 0; step <= 10; step += 1) {
      await send(
        guest,
        'Input.dispatchTouchEvent',
        {
          type: 'touchMove',
          touchPoints: [
            touch(
              source.x + ((destination.x - source.x) * step) / 10,
              source.y + ((destination.y - source.y) * step) / 10
            ),
          ],
        },
        signal
      );
    }
    await send(
      guest,
      'Input.dispatchTouchEvent',
      {
        type: 'touchEnd',
        touchPoints: [],
      },
      signal
    );
  }

  async function scrollAt(
    guest: WebContents,
    point: { x: number; y: number },
    deltaX: number,
    deltaY: number,
    signal?: AbortSignal
  ): Promise<void> {
    await send(
      guest,
      'Input.dispatchMouseEvent',
      {
        type: 'mouseWheel',
        ...cssPoint(point),
        deltaX,
        deltaY,
        button: 'none',
      },
      signal
    );
  }

  return {
    pressKey: timedBrowserOperation('input', pressKey),
    typeText: timedBrowserOperation('input', typeText),
    dropFilesAt: timedBrowserOperation('input', dropFilesAt),
    clickAt: timedBrowserOperation('input', clickAt),
    hoverAt: timedBrowserOperation('input', hoverAt),
    dragAt: timedBrowserOperation('input', dragAt),
    tapAt: timedBrowserOperation('input', tapAt),
    swipeAt: timedBrowserOperation('input', swipeAt),
    scrollAt: timedBrowserOperation('input', scrollAt),
  };
}
