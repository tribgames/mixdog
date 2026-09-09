import type { DesktopBrowserPageControl } from './contract';

export function normalizeBrowserPageControl(value: unknown): DesktopBrowserPageControl {
  if (!value || typeof value !== 'object') throw new TypeError('Browser input is invalid.');
  const input = value as Record<string, unknown>;
  const documentId = input.documentId;
  if (typeof documentId !== 'string' || !/^p\d+:\d+$/.test(documentId)) {
    throw new TypeError('Browser document token is invalid.');
  }
  const number = (name: string, min: number, max: number): number => {
    const value = input[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new TypeError(`Browser ${name} is invalid.`);
    }
    return value;
  };
  const text = (name: string, limit: number): string => {
    const value = input[name];
    if (typeof value !== 'string' || !value.length || value.length > limit) {
      throw new TypeError(`Browser ${name} is invalid.`);
    }
    return value;
  };
  switch (input.type) {
    case 'answer-dialog': {
      if (typeof input.accept !== 'boolean' || (input.promptText !== undefined
        && (typeof input.promptText !== 'string' || input.promptText.length > 2000))) {
        throw new TypeError('Browser dialog answer is invalid.');
      }
      return { type: input.type, documentId, requestId: text('requestId', 100),
        accept: input.accept, promptText: input.promptText as string | undefined };
    }
    case 'choose-files': {
      if (input.cancel !== undefined && typeof input.cancel !== 'boolean') throw new TypeError('Browser file choice is invalid.');
      return { type: input.type, documentId, requestId: text('requestId', 100), cancel: input.cancel as boolean | undefined };
    }
    case 'new-tab': return { type: input.type, documentId };
    case 'select-tab': case 'close-tab': {
      const tabId = text('tabId', 80);
      if (!/^p\d+$/.test(tabId)) throw new TypeError('Browser tab id is invalid.');
      return { type: input.type, documentId, tabId };
    }
    case 'navigate': return { type: input.type, documentId, url: text('url', 4096) };
    case 'back': case 'forward': case 'reload': case 'stop':
      return { type: input.type, documentId };
    case 'resize': return { type: input.type, documentId, width: number('width', 1, 3840), height: number('height', 1, 3840) };
    case 'zoom': return { type: input.type, documentId, factor: number('factor', 0.25, 5) };
    case 'text': return { type: input.type, documentId, text: text('text', 32_000) };
    case 'key': return { type: input.type, documentId, key: text('key', 64) };
    case 'pointer': {
      if (!['mouseMoved', 'mousePressed', 'mouseReleased'].includes(String(input.phase))
        || !['none', 'left', 'middle', 'right'].includes(String(input.button))) {
        throw new TypeError('Browser pointer is invalid.');
      }
      return {
        type: input.type, documentId,
        phase: input.phase as 'mouseMoved' | 'mousePressed' | 'mouseReleased',
        button: input.button as 'none' | 'left' | 'middle' | 'right',
        x: number('x', 0, 100_000), y: number('y', 0, 100_000),
        buttons: number('buttons', 0, 7), modifiers: number('modifiers', 0, 15),
        clickCount: number('clickCount', 0, 3),
      };
    }
    case 'wheel': return {
      type: input.type, documentId, x: number('x', 0, 100_000), y: number('y', 0, 100_000),
      deltaX: number('deltaX', -20_000, 20_000), deltaY: number('deltaY', -20_000, 20_000),
    };
    default: throw new TypeError('Unknown browser input.');
  }
}
