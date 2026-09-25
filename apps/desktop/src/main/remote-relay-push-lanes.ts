// Desktop-originated pushes on the relay leg: terminal output, explorer
// refreshes and language-server events reach only the phones that registered
// the matching lane (see RelayClientState.lanes).
import type { DesktopService } from './desktop-service-contract';
import { clientReadsLane, type RelayClientState } from './remote-relay-clients';
import { TerminalDataBufferer } from './terminal-data-buffer';

export interface RelayPushLaneDeps {
  clients: ReadonlyMap<string, RelayClientState>;
  broadcastEncrypted(payload: unknown, droppable: boolean, include?: (state: RelayClientState) => boolean): void;
  subscribeTerminalData?: (listener: (event: { id: string; data: string }) => void) => () => void;
  subscribeDesktopEvents?: DesktopService['subscribeDesktopEvents'];
}

const readsLane =
  (lane: string) =>
  (state: RelayClientState): boolean =>
    clientReadsLane(state.lanes, lane);
const readsTerminal = readsLane('terminal');
const readsFiles = readsLane('files');
const readsEditor = readsLane('editor');

export function createRelayPushLanes(deps: RelayPushLaneDeps): { dispose(): void } {
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
      if (deps.clients.size === 0) return;
      // Explorer live refresh and language-server pushes are the same lanes the
      // Electron window receives; a paired browser stays as fresh as the desktop.
      // None of them is droppable: a dropped frame leaves a stale listing or a
      // stale squiggle behind with no later push to correct it.
      if (name === 'folder-changed') {
        deps.broadcastEncrypted({ event: 'folderChanged', payload: value }, false, readsFiles);
      } else if (name === 'lsp-diagnostics') {
        deps.broadcastEncrypted({ event: 'lspDiagnostics', payload: value }, false, readsEditor);
      } else if (name === 'lsp-status') {
        deps.broadcastEncrypted({ event: 'lspStatus', payload: value }, false, readsEditor);
      }
    }) ?? (() => {});
  return {
    dispose: () => {
      unsubscribeTerminals();
      terminalBuffer.dispose();
      unsubscribeDesktopEvents();
    },
  };
}
