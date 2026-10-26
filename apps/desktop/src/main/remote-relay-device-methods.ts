// The RPC method table each phone connection is served by, and the per-paired-
// device state those tables share across reconnects: the device's name (as the
// relay authenticated it) and its one-file link grants.
import type { DesktopRemoteClientInfo } from '../shared/contract';
import type { FileDownloadService } from './file-downloads';
import {
  createRemoteMethods,
  createSelectedFileGrants,
  type RemoteMethodDependencies,
  type SelectedFileGrants,
} from './remote-methods';
import type { RelayClientState } from './remote-relay-clients';
import type { RelaySessionStateFanout } from './remote-relay-session-state';
import { requestPhoneTranscriptPage } from './remote-transcript-window';
import { viewIsStale } from './remote-view-staleness';

type RemoteMethodTable = ReturnType<typeof createRemoteMethods>;

export interface RelayDeviceMethodsDeps {
  /** Spread into every table, as the relay received it. */
  base: RemoteMethodDependencies;
  /** Local nickname for a paired device (credential id); wins over the relay's name. */
  deviceAlias(credentialId: string): string | undefined;
  /** The relay's paired-device list. */
  listClients(): Promise<DesktopRemoteClientInfo[]>;
  fileDownloads: FileDownloadService;
  push: NonNullable<RemoteMethodDependencies['push']>;
  nativePush: NonNullable<RemoteMethodDependencies['nativePush']>;
  approvalNotifications: NonNullable<RemoteMethodDependencies['approvalNotifications']>;
  sessionStates: Pick<RelaySessionStateFanout, 'latestItems' | 'refresh'>;
}

export interface RelayDeviceMethods {
  methodsFor(clientId: string, state: RelayClientState): RemoteMethodTable;
  forgetDeviceName(credentialId: string): void;
  dropFileGrants(credentialId: string): void;
  clearFileGrants(): void;
}

export function createRelayDeviceMethods(deps: RelayDeviceMethodsDeps): RelayDeviceMethods {
  // One method table per relay leg: the device name and stale-view state are
  // those of the credential the relay authenticated for it.
  const clientMethods = new WeakMap<RelayClientState, RemoteMethodTable>();
  // Paired-device names come from the relay's own client list, keyed by the
  // credential it authenticated for the leg — the request never names itself.
  const deviceNames = new Map<string, string>();
  const deviceNameFor = async (credentialId: string): Promise<string> => {
    const alias = deps.deviceAlias(credentialId);
    if (alias) return alias;
    const cached = deviceNames.get(credentialId);
    if (cached) return cached;
    let name = '';
    try {
      const paired = await deps.listClients();
      name = Array.isArray(paired)
        ? String(paired.find((entry) => entry.id === credentialId)?.name || '')
            .trim()
            .slice(0, 80)
        : '';
    } catch {
      name = '';
    }
    if (name) deviceNames.set(credentialId, name);
    return name;
  };
  // One-file link grants are bound to the paired device the same way: a
  // reconnect keeps the tokens the client already holds for linked files.
  const deviceFileGrants = new Map<string, SelectedFileGrants>();
  const fileGrantsFor = (credentialId: string): SelectedFileGrants | undefined => {
    if (!credentialId) return undefined;
    let grants = deviceFileGrants.get(credentialId);
    if (!grants) {
      grants = createSelectedFileGrants((sessionId) => deps.fileDownloads.sessionRemoved(sessionId));
      deviceFileGrants.set(credentialId, grants);
    }
    return grants;
  };
  const methodsFor = (clientId: string, state: RelayClientState): RemoteMethodTable => {
    let table = clientMethods.get(state);
    if (!table) {
      const selectedFileGrants = fileGrantsFor(state.credentialId);
      table = createRemoteMethods(
        {
          ...deps.base,
          fileDownloads: deps.fileDownloads,
          ...(selectedFileGrants ? { selectedFileGrants } : {}),
          push: deps.push,
          approvalNotifications: deps.approvalNotifications,
          nativePush: deps.nativePush,
        },
        {
          credentialId: () => state.credentialId,
          connectionId: () => clientId,
          deviceName: () => deviceNameFor(state.credentialId),
          staleView: (sessionId, device) => {
            const held = (
              state.sessionStateEncoders.get(sessionId)?.resumePoint()?.held as { items?: unknown[] } | null
            )?.items;
            const stale = viewIsStale(held, deps.sessionStates.latestItems(sessionId), device);
            if (stale) deps.sessionStates.refresh(sessionId);
            return stale;
          },
          viewedSessionIds: () => [...state.visibleSessionIds],
          heldTranscript: (sessionId) => state.sessionStateEncoders.get(sessionId)?.resumePoint()?.held ?? null,
          requestRead: (sessionId) => {
            state.requestedReads ??= new Set();
            state.requestedReads.add(sessionId);
          },
          requestTranscriptPage: (sessionId, limit) =>
            requestPhoneTranscriptPage(state.sessionStateEncoders.get(sessionId), limit),
          releaseRead: (sessionId) => state.requestedReads?.delete(sessionId),
        }
      );
      clientMethods.set(state, table);
    }
    return table;
  };
  return {
    methodsFor,
    forgetDeviceName: (credentialId) => {
      deviceNames.delete(credentialId);
    },
    dropFileGrants: (credentialId) => {
      deviceFileGrants.delete(credentialId);
    },
    clearFileGrants: () => deviceFileGrants.clear(),
  };
}
