/**
 * Turning a caller's words into one exact window. An app label resolves only
 * when it names a single window; two matches are refused with their candidates
 * rather than guessed, because acting on the wrong window is not recoverable.
 */
import type { InstalledApps } from '../host/window-reads';
import type { ComputerWindowRecord } from '../shared/window-transition';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';

export interface WindowTargetingHost {
  readComputerWindows(command: ComputerCommand, includeApp?: boolean): Promise<ComputerWindowRecord[] | null>;
  readInstalledApps(command: ComputerCommand): Promise<InstalledApps | null>;
}

/** The installed catalogue runs to hundreds of entries, so a listing answers a
 *  query and otherwise only says how much more is there. */
const MAX_INSTALLED_APP_MATCHES = 40;

const EXACT_WINDOW_COMMAND_ACTIONS = new Set([
  'focus_window',
  'move_window',
  'window_state',
  'close_window',
  'terminate_process',
  'invoke_menu',
]);

export function assertExactWindowCommandTarget(command: ComputerCommand): void {
  const action = String(command.action || '');
  if (EXACT_WINDOW_COMMAND_ACTIONS.has(action) && !String(command.window_id || '').trim()) {
    throw new Error(`${action} requires an exact window_id before dispatch`);
  }
}

// Windows grouped per app process, focused apps first.
function windowsGroupedByApp(windows: ComputerWindowRecord[]) {
  const groups = new Map<
    string,
    {
      name: string;
      pid: number;
      focused: boolean;
      minimized: boolean;
      windows: Array<{
        window_id: string;
        title: string;
        class_name: string;
        minimized: boolean;
        maximized: boolean;
      }>;
    }
  >();
  for (const window of windows) {
    const key = `${window.app.toLowerCase()}\0${window.pid}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        name: window.app,
        pid: window.pid,
        focused: false,
        minimized: true,
        windows: [],
      };
      groups.set(key, group);
    }
    group.focused ||= window.focused;
    group.minimized &&= window.minimized;
    group.windows.push({
      window_id: window.id,
      title: window.title,
      class_name: window.className,
      minimized: window.minimized,
      maximized: window.maximized,
    });
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      window_count: group.windows.length,
    }))
    .sort((left, right) => Number(right.focused) - Number(left.focused) || left.name.localeCompare(right.name));
}

export function createWindowTargeting(host: WindowTargetingHost) {
  const { readComputerWindows, readInstalledApps } = host;

  async function resolveAppWindowId(command: ComputerCommand): Promise<string> {
    const requested = String(command.app || '')
      .trim()
      .toLowerCase();
    if (!requested) throw new Error('app target is empty');
    const windows = await readComputerWindows(command, true);
    if (!windows) throw new Error('could not enumerate windows for app targeting');
    const exact = windows.filter((window) => window.app.toLowerCase() === requested);
    const matches =
      exact.length > 0
        ? exact
        : windows.filter(
            (window) =>
              window.app.toLowerCase().includes(requested) ||
              window.title.toLowerCase().includes(requested) ||
              window.className.toLowerCase().includes(requested)
          );
    if (matches.length === 0) {
      throw new Error(`window_target_not_found: no visible window matched app "${command.app}"`);
    }
    if (matches.length === 1) return matches[0].id;
    const candidates = matches
      .slice(0, 12)
      .map((window) => `${window.id} "${window.title || '<untitled>'}"`)
      .join(' | ');
    throw new Error(
      `ambiguous_window_target: app "${command.app}" matched ${matches.length} windows (${candidates}); retry with one exact window_id`
    );
  }

  async function resolveRecaptureWindowTarget(
    command: ComputerCommand,
    observedWindowId: string
  ): Promise<{ windowId: string; error?: string }> {
    const explicitWindowId = String(command.window_id || '').trim();
    if (explicitWindowId) return { windowId: explicitWindowId };
    if (String(command.app || '').trim()) {
      try {
        return { windowId: await resolveAppWindowId(command) };
      } catch (error) {
        return {
          windowId: '',
          error: `exact app target is unavailable for recapture: ${(error as Error).message || String(error)}`,
        };
      }
    }
    const fallbackWindowId = String(observedWindowId || '').trim();
    return fallbackWindowId
      ? { windowId: fallbackWindowId }
      : {
          windowId: '',
          error: 'exact target window is unavailable for recapture',
        };
  }

  async function resolveForegroundWindowId(command: ComputerCommand): Promise<string> {
    const windows = await readComputerWindows(command);
    const focused = windows?.filter((window) => window.focused) || [];
    if (focused.length !== 1) {
      throw new Error('no single foreground window is available; use app or window_id');
    }
    return focused[0].id;
  }

  async function listComputerApps(command: ComputerCommand): Promise<ComputerCommandResult> {
    const windows = await readComputerWindows(command, true);
    if (!windows) throw new Error('could not enumerate apps');
    const apps = windowsGroupedByApp(windows);
    const installed = await readInstalledApps(command);
    if (!installed) return { text: JSON.stringify({ apps }) };
    const query = String(command.query || '').trim();
    return {
      text: JSON.stringify(
        query
          ? {
              apps,
              installed: installed.matches.slice(0, MAX_INSTALLED_APP_MATCHES),
              installed_matched: installed.matches.length,
              installed_total: installed.total,
            }
          : { apps, installed_total: installed.total }
      ),
    };
  }

  return {
    resolveAppWindowId,
    resolveRecaptureWindowTarget,
    resolveForegroundWindowId,
    listComputerApps,
  };
}
