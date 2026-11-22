import { useInsertionEffect } from 'react';

/** `name` on the root while `on`, for a stylesheet that would otherwise test
 *  the whole document with :has(). Set before any layout effect of the commit
 *  can measure, as the :has() was. */
export function useRootFlag(name: string, on: boolean): void {
  useInsertionEffect(() => {
    if (!on) return undefined;
    document.documentElement.setAttribute(name, '');
    return () => document.documentElement.removeAttribute(name);
  }, [name, on]);
}

const EXPANDED_SURFACE =
  '.session-terminal-surface-container[data-parked="false"][data-expanded="true"], .session-browser-surface-container[data-parked="false"][data-expanded="true"]';

/** Mirrors on the root whether an expanded terminal or browser surface shows
 *  (pane-layout.css), so no rule there tests the whole document with :has(),
 *  which any inserted node anywhere invalidated. Called wherever a surface is
 *  placed, parked or removed. */
export function syncExpandedSurfaceFlag(): void {
  document.documentElement.toggleAttribute('data-surface-expanded', Boolean(document.querySelector(EXPANDED_SURFACE)));
}
