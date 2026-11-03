// "Start screen" (Settings → Display): whether a launch resumes the last
// conversation ('last') or opens a fresh conversation with no project
// ('new-projectless', the default; restored tabs stay open behind it). A
// device-local renderer preference of the desktop window only: the phone and
// web clients keep reopening the conversation they showed last.
import { isNativeDesktopWindow } from './remote-ui-projection';

export type StartupView = 'last' | 'new-projectless';

const STARTUP_VIEW_KEY = 'mixdog.desktop.startup-view.v1';
// sessionStorage outlives a window reload but not the window, so it tells a
// launch apart from a reload of the running window.
const WINDOW_LAUNCHED_KEY = 'mixdog.desktop.window-launched';
let fallbackView: StartupView = 'new-projectless';
let launchDecision: boolean | null = null;

export function getStartupView(): StartupView {
  try {
    const stored = window.localStorage.getItem(STARTUP_VIEW_KEY);
    if (stored === 'last' || stored === 'new-projectless') fallbackView = stored;
  } catch {
    // Desktop-local preferences degrade to the in-memory value.
  }
  return fallbackView;
}

export function setStartupView(view: StartupView): boolean {
  fallbackView = view === 'last' ? 'last' : 'new-projectless';
  try {
    window.localStorage.setItem(STARTUP_VIEW_KEY, fallbackView);
    return true;
  } catch {
    return false;
  }
}

/** True once per window launch when the preference asks for a projectless new
 *  conversation. A reload of the running window keeps what it restores. The
 *  first answer is kept so every caller in this renderer agrees. */
export function startsOnProjectlessDraft(): boolean {
  if (launchDecision !== null) return launchDecision;
  let launch = true;
  try {
    launch = window.sessionStorage.getItem(WINDOW_LAUNCHED_KEY) === null;
    window.sessionStorage.setItem(WINDOW_LAUNCHED_KEY, '1');
  } catch {
    // Without sessionStorage every load counts as a launch.
  }
  launchDecision = launch && isNativeDesktopWindow() && getStartupView() === 'new-projectless';
  return launchDecision;
}
