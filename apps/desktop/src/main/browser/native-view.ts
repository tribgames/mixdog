/** Opt-in native presentation (MIXDOG_BROWSER_NATIVE_VIEW): the Browser pane
 *  shows the page itself over its surface, so a person scrolls, clicks and
 *  types on the real page instead of a sampled image.
 *
 *  Every page is a view in its own frameless window (see page-window), parked
 *  off-screen, where it keeps rendering for the agent and the pixel display.
 *  While the pane shows a page, the shell adopts that view into its own
 *  content: shell and page then compose in one window, so the page follows
 *  panel resizing in the same frame instead of trailing it as a separate
 *  window would. Agent CDP input to a shown page leaves the shell's focused
 *  element and selection untouched. */
import type { BrowserWindow, WebContents } from 'electron';
import { agentInputInFlight } from './agent-input';
import { browserPageView, browserPageWindow } from './page-window';

/** Parked page windows sit here, outside every display. */
const PARK_POSITION = -32_000;

/** Deliberate gestures that take a page over from the agent: presses, keys,
 *  wheel and touchpad/touch scrolling, and touches. */
const TAKEOVER_INPUT = new Set<string>([
  'mouseDown',
  'mouseWheel',
  'rawKeyDown',
  'keyDown',
  'gestureScrollBegin',
  'gestureTapDown',
  'touchStart',
]);

export interface BrowserNativeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BrowserNativeViewHost {
  shell: BrowserWindow;
  currentGuest(sessionId: string): WebContents | null;
  /** A person pressed, dragged, scrolled or typed on a presented page. */
  humanInput(guest: WebContents): void;
}

export function createBrowserNativeViews(host: BrowserNativeViewHost) {
  const { shell } = host;
  /** Each session's shown page and where, in shell content DIPs. */
  const presented = new Map<string, { guest: WebContents; bounds: BrowserNativeRect }>();
  const adopted = (guest: WebContents) => {
    const view = browserPageView(guest);
    return view && !shell.isDestroyed() && shell.contentView.children.includes(view) ? view : null;
  };

  /** Return a page to its window, off every display. A hidden native window
   *  commits a new renderer (a cross-site navigation) without frames — in the
   *  app it then drew once a second, stalling the agent and the pixel
   *  display. So a page window is never hidden: from creation on it is shown,
   *  unfocusable, far outside the desktop, and as a tool window never listed
   *  in Alt+Tab or the taskbar. */
  function park(guest: WebContents): void {
    const owner = guest.isDestroyed() ? null : browserPageWindow(guest);
    const view = owner && browserPageView(guest);
    if (!owner || !view) return;
    if (adopted(guest)) {
      // Keyboard focus must not stay with a page nobody can see.
      if (guest.isFocused()) shell.webContents.focus();
      const { width, height } = view.getBounds();
      shell.contentView.removeChildView(view);
      owner.contentView.addChildView(view);
      owner.setContentSize(width, height);
      view.setBounds({ x: 0, y: 0, width, height });
    }
    const [width, height] = owner.getContentSize();
    owner.setBounds({ x: PARK_POSITION, y: PARK_POSITION, width, height });
    if (!owner.isVisible()) owner.showInactive();
  }

  /** Adopt a presented page into the shell over the pane, or keep it parked
   *  while the shell itself cannot be seen (it returns with the shell). */
  function place({ guest, bounds }: { guest: WebContents; bounds: BrowserNativeRect }): boolean {
    const owner = guest.isDestroyed() ? null : browserPageWindow(guest);
    const view = owner && browserPageView(guest);
    if (!owner || !view || shell.isDestroyed()) return false;
    if (!shell.isVisible() || shell.isMinimized()) {
      park(guest);
      return true;
    }
    if (!adopted(guest)) {
      owner.contentView.removeChildView(view);
      shell.contentView.addChildView(view);
    }
    view.setBounds(bounds);
    // The page's window keeps its page size for display reads and restores.
    const [width, height] = owner.getContentSize();
    if (width !== bounds.width || height !== bounds.height) owner.setContentSize(bounds.width, bounds.height);
    return true;
  }

  function parkAll(): void {
    for (const { guest } of presented.values()) park(guest);
    presented.clear();
  }

  // A reloading or crashed shell cannot report its pane geometry any more;
  // its pages must not stay painted over whatever it shows next.
  shell.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) parkAll();
  });
  shell.webContents.on('render-process-gone', parkAll);
  // An adopted page moves and resizes with the shell. A hidden or minimized
  // shell would stop drawing it, so it is parked meanwhile and adopted again
  // when the shell returns.
  const follow = () => {
    for (const entry of presented.values()) place(entry);
  };
  for (const event of ['show', 'restore', 'hide', 'minimize'] as const) shell.on(event as 'show', follow);

  return {
    /** Show the session's current page at `rect` (shell CSS pixels), or park
     *  it. Returns whether the page is now presented natively. */
    present(sessionId: string, rect: BrowserNativeRect | null): boolean {
      const guest = rect ? host.currentGuest(sessionId) : null;
      const previous = presented.get(sessionId);
      presented.delete(sessionId);
      if (previous && (previous.guest !== guest || !rect)) park(previous.guest);
      if (!rect || !guest || guest.isDestroyed() || guest.isOffscreen() || shell.isDestroyed()) return false;
      const zoom = shell.webContents.getZoomFactor();
      const entry = {
        guest,
        bounds: {
          x: Math.round(rect.x * zoom),
          y: Math.round(rect.y * zoom),
          width: Math.max(1, Math.round(rect.width * zoom)),
          height: Math.max(1, Math.round(rect.height * zoom)),
        },
      };
      if (!place(entry)) return false;
      presented.set(sessionId, entry);
      return true;
    },
    /** Park a new page at once (see park), and attribute native input on it
     *  to the person using it. Agent and phone input arrive through CDP on the
     *  same browser-side path (they raise the same input events as a physical
     *  device) and are excluded while in flight. Hover alone never takes over. */
    watch(guest: WebContents): void {
      park(guest);
      guest.once('destroyed', () => {
        for (const [sessionId, entry] of presented) if (entry.guest === guest) presented.delete(sessionId);
        const view = adopted(guest);
        if (view) shell.contentView.removeChildView(view);
      });
      guest.on('input-event', (_event, input) => {
        if (agentInputInFlight(guest)) return;
        const pressed = input.modifiers?.some((modifier) => modifier.endsWith('buttondown'));
        if (TAKEOVER_INPUT.has(input.type) || (input.type === 'mouseMove' && pressed)) host.humanInput(guest);
      });
    },
    parkAll,
  };
}
