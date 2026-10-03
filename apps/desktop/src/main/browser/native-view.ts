/** Opt-in native presentation (MIXDOG_BROWSER_NATIVE_VIEW): the Browser pane
 *  shows the page's own window over its surface, so a person scrolls, clicks
 *  and types on the real page instead of a sampled image.
 *
 *  Every page keeps its frameless owner window (see guest-lifecycle). While
 *  the pane shows a page, that window is an owned window of the shell, placed
 *  over the pane without taking activation; otherwise it is parked off-screen
 *  (see park), where it keeps rendering for the agent and the pixel display.
 *  (Moving the page's view
 *  into the shell instead does not work: it stays composited by its hidden
 *  owner and never reaches the display.) Agent CDP input to a shown page
 *  leaves the shell's focused element and selection untouched. */
import { BrowserWindow, type WebContents } from 'electron';
import { agentInputInFlight } from './agent-input';

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

  /** Move a page off every display. A hidden native window commits a new
   *  renderer (a cross-site navigation) without frames — in the app it then
   *  drew once a second, stalling the agent and the pixel display. So a page
   *  window is never hidden: from creation on it is shown, unowned (the shell
   *  minimizing would hide an owned window) and unfocusable, far outside the
   *  desktop, and as a tool window never listed in Alt+Tab or the taskbar. */
  function park(guest: WebContents): void {
    const owner = guest.isDestroyed() ? null : BrowserWindow.fromWebContents(guest);
    if (!owner || owner.isDestroyed()) return;
    // Keyboard focus must not stay with a page nobody can see.
    if (owner.isFocused() && !shell.isDestroyed() && shell.isVisible() && !shell.isMinimized()) shell.focus();
    if (owner.isFocusable()) owner.setFocusable(false);
    if (owner.getParentWindow()) owner.setParentWindow(null);
    const [width, height] = owner.getContentSize();
    owner.setBounds({ x: PARK_POSITION, y: PARK_POSITION, width, height });
    if (!owner.isVisible()) owner.showInactive();
  }

  /** Put a presented page's window over the pane, or keep it parked while the
   *  shell itself cannot be seen (it returns with the shell). */
  function place({ guest, bounds }: { guest: WebContents; bounds: BrowserNativeRect }): boolean {
    const owner = guest.isDestroyed() ? null : BrowserWindow.fromWebContents(guest);
    if (!owner || owner.isDestroyed() || shell.isDestroyed()) return false;
    if (!shell.isVisible() || shell.isMinimized()) {
      park(guest);
      return true;
    }
    const content = shell.getContentBounds();
    if (owner.getParentWindow() !== shell) owner.setParentWindow(shell);
    owner.setBounds({ x: content.x + bounds.x, y: content.y + bounds.y, width: bounds.width, height: bounds.height });
    // A person types into the shown page; hidden pages never take activation.
    if (!owner.isFocusable()) owner.setFocusable(true);
    if (!owner.isVisible()) owner.showInactive();
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
  // Owned windows follow the shell: moved and resized with it, hidden while
  // it is hidden or minimized, and shown again when it returns.
  const follow = () => {
    for (const entry of presented.values()) place(entry);
  };
  for (const event of ['move', 'resize', 'show', 'restore', 'hide', 'minimize'] as const)
    shell.on(event as 'move', follow);

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
      });
      // Alt+F4 on a shown page would close its window and with it the page.
      guest.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.alt && input.key === 'F4') event.preventDefault();
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
