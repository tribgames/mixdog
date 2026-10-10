import type { WebContents } from 'electron';

/** The shell scrollbar inside browser guest pages: 8px, transparent track,
 *  inset pill thumb, no arrow buttons. Scrollbar pseudo-elements only — the
 *  page layout is otherwise untouched. */
export const PAGE_SCROLLBAR_CSS = `
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: rgba(128, 128, 128, 0.5);
  background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover { background: rgba(128, 128, 128, 0.7); background-clip: padding-box; }
::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
::-webkit-scrollbar-corner { background: transparent; }
`;

/** Re-inject on every document: insertCSS applies to the current document only. */
export function injectPageScrollbarCss(guest: Pick<WebContents, 'on' | 'insertCSS' | 'isDestroyed'>): void {
  guest.on('dom-ready', () => {
    if (guest.isDestroyed()) return;
    void guest.insertCSS(PAGE_SCROLLBAR_CSS).catch(() => {
      /* a page that navigated away mid-injection simply keeps its own bars */
    });
  });
}
