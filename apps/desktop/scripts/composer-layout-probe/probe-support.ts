import { flushSync } from 'react-dom';

// Sample after layout/ResizeObserver/paint, not in the rAF phase preceding
// them. Reading a rect inside rAF measured an animation's new height against
// the previous ResizeObserver delivery and reported an unpainted gap.
export const frame = () => new Promise<void>((done) => requestAnimationFrame(() => window.setTimeout(done, 0)));

export async function waitFor(ready: () => boolean, label: string) {
  const deadline = performance.now() + 5_000;
  while (!ready()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await frame();
  }
}

// The isolated offscreen window has no OS keyboard focus. Deliver the same
// focus/input/selection events that typing into its native textarea produces.
export function editPrompt(input: HTMLTextAreaElement, text: string) {
  flushSync(() => {
    input.focus({ preventScroll: true });
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    input.dispatchEvent(new Event('select', { bubbles: true }));
  });
}
