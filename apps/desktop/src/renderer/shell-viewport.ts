// Shared viewport writer. Web and Electron use the same 940/760 CSS bands;
// remote only marks itself so the - ㅁ x caption reserve can stay off.

import { isRemoteHostRenderer } from './remote-ui-projection';

// visualViewport scroll/resize fire on EVERY frame of an Android URL-bar
// collapse or keyboard animation. Each root variable write invalidates style
// for the whole document, so a value is written only when it changed.
const appliedViewportVars = new Map<string, string>();

function writeViewportVar(root: HTMLElement, name: string, value: string): void {
  if (appliedViewportVars.get(name) === value) return;
  appliedViewportVars.set(name, value);
  root.style.setProperty(name, value);
}

function syncViewportVars(): void {
  const root = document.documentElement;
  const visual = window.visualViewport;
  const width = visual?.width ?? window.innerWidth;
  const height = visual?.height ?? window.innerHeight;
  writeViewportVar(root, '--vvw', `${Math.round(width)}px`);
  writeViewportVar(root, '--vvh', `${Math.round(height)}px`);
  writeViewportVar(root, '--vv-offset-left', `${Math.round(visual?.offsetLeft ?? 0)}px`);
  writeViewportVar(root, '--vv-offset-top', `${Math.round(visual?.offsetTop ?? 0)}px`);
  // iOS keeps the layout viewport (and the home-indicator inset) while the
  // soft keyboard covers the bottom; only the visual viewport shrinks. The
  // composer must then drop its safe-area pad, or it floats one home-bar
  // height above the keyboard. Android resizes the layout viewport with it.
  const keyboard = window.innerHeight - height > KEYBOARD_MIN_HEIGHT;
  if (keyboard !== (root.dataset.mixdogKeyboard === 'open')) {
    if (keyboard) root.dataset.mixdogKeyboard = 'open';
    else delete root.dataset.mixdogKeyboard;
  }
}

/** Smaller visual-viewport losses are URL bars and zoom, not a keyboard. */
const KEYBOARD_MIN_HEIGHT = 120;

function syncShellFlags(): void {
  const root = document.documentElement;
  if (isRemoteHostRenderer()) {
    root.dataset.mixdogRemote = '1';
    return;
  }
  delete root.dataset.mixdogRemote;
}

export function installShellViewport(): () => void {
  let frame = 0;
  const apply = () => {
    syncViewportVars();
    syncShellFlags();
  };
  const sync = () => {
    if (frame !== 0) return;
    if (typeof window.requestAnimationFrame !== 'function') {
      apply();
      return;
    }
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      apply();
    });
  };
  apply();
  const visual = window.visualViewport;
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);
  visual?.addEventListener('resize', sync);
  visual?.addEventListener('scroll', sync);
  return () => {
    if (frame !== 0) window.cancelAnimationFrame?.(frame);
    frame = 0;
    window.removeEventListener('resize', sync);
    window.removeEventListener('orientationchange', sync);
    visual?.removeEventListener('resize', sync);
    visual?.removeEventListener('scroll', sync);
  };
}
