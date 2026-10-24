// Desktop-originated pushes on the relay leg: terminal output, explorer
// refreshes and language-server events reach only the phones that registered
// the matching lane (see RelayClientState.lanes).
import type { DesktopService } from './desktop-service-contract';
import { clientReadsLane, type RelayClientState } from './remote-relay-clients';
import { TerminalDataBufferer } from './terminal-data-buffer';
import { ACTIVITY_RAIL_PINS_EVENT } from '../shared/activity-rail-pins';
import { PROVIDER_MODELS_EVENT } from '../shared/provider-models';
import { SETTINGS_CHANGED_EVENT, UPDATER_STATE_EVENT } from '../shared/settings-changed';
import { BROWSER_APPROVAL_SESSIONS_EVENT, readBrowserApprovalSessions } from '../shared/browser-approval-sessions';
import { TERMINAL_SIZE_OWNER_EVENT, type TerminalSizeOwnerChange } from '../shared/terminal-size-owner';
import { TERMINAL_ACTIVITY_EVENT } from '../shared/terminal-activity';
import { BROWSER_OPEN_REQUESTED_DESKTOP_EVENT, REMOTE_BROWSER_OPEN_EVENT } from '../shared/remote-browser';
import {
  type DesktopVisualizeEvent,
  REMOTE_VISUALIZE_CHANGED_EVENT,
  REMOTE_VISUALIZE_LANE,
  VISUALIZE_REMOTE_DESKTOP_EVENT,
} from '../shared/visualize';

export interface RelayPushLaneDeps {
  clients: ReadonlyMap<string, RelayClientState>;
  broadcastEncrypted(payload: unknown, droppable: boolean, include?: (state: RelayClientState) => boolean): void;
  subscribeTerminalData?: (listener: (event: { id: string; data: string }) => void) => () => void;
  subscribeDesktopEvents?: DesktopService['subscribeDesktopEvents'];
  /** The browser-approval session list published before these lanes started. */
  readBrowserApprovalSessions?: () => Promise<unknown>;
}

export interface RelayPushLanes {
  /** Frames a newly authenticated connection gets at once: the waiting
   *  browser-approval sessions, so a reconnect drops marks that ended meanwhile. */
  joinFrames(): unknown[];
  dispose(): void;
}

const readsLane =
  (lane: string) =>
  (state: RelayClientState): boolean =>
    clientReadsLane(state.lanes, lane);
const readsTerminal = readsLane('terminal');
const readsFiles = readsLane('files');
const readsEditor = readsLane('editor');
const readsVisualize = readsLane(REMOTE_VISUALIZE_LANE);

/** Desktop events every client receives under their own name. */
const GLOBAL_DESKTOP_EVENTS = new Set<string>([
  ACTIVITY_RAIL_PINS_EVENT,
  PROVIDER_MODELS_EVENT,
  SETTINGS_CHANGED_EVENT,
  UPDATER_STATE_EVENT,
]);

export function createRelayPushLanes(deps: RelayPushLaneDeps): RelayPushLanes {
  // Kept from every publication; seeded by a read only until the first one.
  // A device that joined before the read answered was given `[]`: the seed
  // reaches it too.
  let browserApprovalSessions: string[] | null = null;
  void deps
    .readBrowserApprovalSessions?.()
    .then((value) => {
      if (browserApprovalSessions !== null) return;
      const ids = readBrowserApprovalSessions(value);
      if (!ids) return;
      browserApprovalSessions = ids;
      if (deps.clients.size > 0) {
        deps.broadcastEncrypted({ event: BROWSER_APPROVAL_SESSIONS_EVENT, payload: ids }, false);
      }
    })
    .catch(() => undefined);
  let terminalBuffer!: TerminalDataBufferer;
  terminalBuffer = new TerminalDataBufferer(
    (event) => {
      if (deps.clients.size > 0) {
        deps.broadcastEncrypted({ event: 'termData', payload: event }, true, readsTerminal);
      }
      terminalBuffer.acknowledge(event.id, event.data.length);
    },
    { delayMs: 16, leadingEdge: true }
  );
  const terminalReaderAttached = (): boolean => {
    for (const state of deps.clients.values()) {
      if (state.channel && readsTerminal(state)) return true;
    }
    return false;
  };
  const unsubscribeTerminals =
    deps.subscribeTerminalData?.((event) => {
      // A build running on the desktop must not even enter the buffer when no
      // phone is showing a terminal.
      if (terminalReaderAttached()) terminalBuffer.push(event);
    }) ?? (() => {});
  const unsubscribeDesktopEvents =
    deps.subscribeDesktopEvents?.(({ name, value }) => {
      if (name === BROWSER_APPROVAL_SESSIONS_EVENT) {
        const ids = readBrowserApprovalSessions(value);
        if (!ids) return;
        browserApprovalSessions = ids;
        // Every paired device marks these sessions; a lost frame would leave
        // a stale mark, so it is never droppable.
        if (deps.clients.size > 0) deps.broadcastEncrypted({ event: name, payload: ids }, false);
        return;
      }
      if (deps.clients.size === 0) return;
      // Explorer live refresh and language-server pushes are the same lanes the
      // Electron window receives; a paired browser stays as fresh as the desktop.
      // None of them is droppable: a dropped frame leaves a stale listing or a
      // stale squiggle behind with no later push to correct it.
      if (GLOBAL_DESKTOP_EVENTS.has(name)) {
        // Global UI state (pins, models, settings, updater), not a
        // panel-specific subscription lane: every client hears it as is.
        deps.broadcastEncrypted({ event: name, payload: value }, false);
      } else if (name === BROWSER_OPEN_REQUESTED_DESKTOP_EVENT) {
        // An agent handoff (CAPTCHA): losing it leaves the user unaware the
        // page needs them, so it is never droppable.
        deps.broadcastEncrypted({ event: REMOTE_BROWSER_OPEN_EVENT, payload: value }, false);
      } else if (name === TERMINAL_SIZE_OWNER_EVENT) {
        // Each phone is told whether IT owns the size: the owner keeps fitting
        // its own pane, every other terminal view follows the owner's grid.
        const change = value as TerminalSizeOwnerChange;
        const ownerState = deps.clients.get(change.owner);
        const payload = { id: change.id, cols: change.cols, rows: change.rows };
        deps.broadcastEncrypted(
          { event: 'termSizeOwner', payload: { ...payload, own: true } },
          false,
          (state) => state === ownerState && readsTerminal(state)
        );
        deps.broadcastEncrypted(
          { event: 'termSizeOwner', payload: { ...payload, own: false } },
          false,
          (state) => state !== ownerState && readsTerminal(state)
        );
      } else if (name === TERMINAL_ACTIVITY_EVENT) {
        // Tab dots: a lost frame would leave a stale dot, so never droppable.
        deps.broadcastEncrypted({ event: 'termActivity', payload: value }, false, readsTerminal);
      } else if (name === VISUALIZE_REMOTE_DESKTOP_EVENT) {
        // The agent's visualize tabs (already path-free). Never droppable: a
        // lost frame leaves a stale tab list or a missed reveal behind.
        const { sessionId, state, reveal, openUrl } = value as DesktopVisualizeEvent;
        if (state) {
          deps.broadcastEncrypted(
            {
              event: REMOTE_VISUALIZE_CHANGED_EVENT,
              payload: { sessionId, state, ...(reveal ? { reveal: true } : {}) },
            },
            false,
            readsVisualize
          );
        }
        // A web URL opened in the desktop's session browser panel: the
        // existing browser handoff reveals that page on every client.
        if (openUrl)
          deps.broadcastEncrypted({ event: REMOTE_BROWSER_OPEN_EVENT, payload: { sessionId, reveal: true } }, false);
      } else if (name === 'folder-changed') {
        deps.broadcastEncrypted({ event: 'folderChanged', payload: value }, false, readsFiles);
      } else if (name === 'lsp-diagnostics') {
        deps.broadcastEncrypted({ event: 'lspDiagnostics', payload: value }, false, readsEditor);
      } else if (name === 'lsp-status') {
        deps.broadcastEncrypted({ event: 'lspStatus', payload: value }, false, readsEditor);
      }
    }) ?? (() => {});
  return {
    joinFrames: () => [{ event: BROWSER_APPROVAL_SESSIONS_EVENT, payload: browserApprovalSessions ?? [] }],
    dispose: () => {
      unsubscribeTerminals();
      terminalBuffer.dispose();
      unsubscribeDesktopEvents();
    },
  };
}
