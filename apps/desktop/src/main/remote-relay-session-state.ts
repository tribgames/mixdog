// Transcript fan-out for the relay leg: one latest-state mailbox per session
// feeds every attached phone that has the session visible, each with its own
// delta baseline, and the paint probes measure publish-to-paint on demand.
import type { DesktopSessionStateUpdate } from '../shared/contract';
import { createRemotePaintProbeTracker } from '../shared/remote-performance';
import type { LatestStateMailbox } from './desktop-service-protocol';
import { reportRemoteFirstTranscript } from './remote-performance-diagnostics';
import type { RelayClientState } from './remote-relay-clients';
import { createRemoteStreamingMailbox } from './remote-streaming-mailbox';
import { remoteTranscriptSnapshot } from './remote-transcript';
import { createSnapshotDeltaEncoder, isNoDelta } from './state-delta';

/** The host owns bounded history pages. A second transport-only slice hid
 * user prompts behind tool activity and prevented the renderer from ever
 * reaching its history paging threshold. Keep that page intact; compression
 * and per-client deltas still avoid retransmitting unchanged history. */
export function encodeRelayClientSessionState(
  encoders: Map<string, ReturnType<typeof createSnapshotDeltaEncoder>>,
  sessionId: string,
  snapshot: unknown,
  compact = false
): unknown {
  let encoder = encoders.get(sessionId);
  if (!encoder) {
    encoder = createSnapshotDeltaEncoder({ compact });
    encoders.set(sessionId, encoder);
  }
  return encoder.encode(remoteTranscriptSnapshot(snapshot));
}

export interface RelaySessionStateFanoutDeps {
  clients: ReadonlyMap<string, RelayClientState>;
  sendEncryptedFrame(clientId: string, payload: unknown, droppable: boolean): Promise<void>;
}

export interface RelaySessionStateFanout {
  publish(update: DesktopSessionStateUpdate): void;
  /** A phone's paint acknowledgement, when the payload is one. */
  acknowledgeFrame(payload: unknown): ReturnType<ReturnType<typeof createRemotePaintProbeTracker>['acknowledgeFrame']>;
  /** Drops every retained update and probe: the relay leg was replaced. */
  clear(): void;
}

export function createRelaySessionStateFanout(deps: RelaySessionStateFanoutDeps): RelaySessionStateFanout {
  const mailboxes = new Map<string, LatestStateMailbox<DesktopSessionStateUpdate>>();
  const paintProbes = createRemotePaintProbeTracker({
    enabled: process.env.MIXDOG_DESKTOP_PERF === '1',
  });
  const mailboxFor = (sessionId: string): LatestStateMailbox<DesktopSessionStateUpdate> => {
    const retained = mailboxes.get(sessionId);
    if (retained) return retained;
    let mailbox!: LatestStateMailbox<DesktopSessionStateUpdate>;
    mailbox = createRemoteStreamingMailbox((sequence, update, critical) => {
      const perfProbe = paintProbes.issue(sessionId);
      void Promise.all(
        [...deps.clients].map(([clientId, state]) => {
          if (!state.channel || state.syncing || !state.visibleSessionIds.has(sessionId)) {
            return Promise.resolve();
          }
          const wire = encodeRelayClientSessionState(
            state.sessionStateEncoders,
            sessionId,
            update.snapshot,
            state.compactWire
          );
          // This client's baseline already matches the snapshot: the frame would
          // carry a revision number and nothing else.
          if (isNoDelta(wire)) return Promise.resolve();
          if (!state.firstTranscriptReported) {
            state.firstTranscriptReported = true;
            // Sized once, on the frame that ends the wait — never on the stream
            // behind it.
            const bytes = Buffer.byteLength(JSON.stringify(wire) ?? '', 'utf8');
            reportRemoteFirstTranscript(Date.now() - state.openedAt, bytes);
          }
          if (!state.compactWire) {
            return deps.sendEncryptedFrame(
              clientId,
              {
                event: 'sessionState',
                payload: {
                  sessionId,
                  wire,
                  frameSource: update.frameSource,
                  ...(update.laneEnd ? { laneEnd: update.laneEnd } : {}),
                  ...(perfProbe ? { perfProbe } : {}),
                  ...(typeof update.contentRevision === 'number' ? { contentRevision: update.contentRevision } : {}),
                },
              },
              !critical
            );
          }
          // Compact envelope. The nested event/payload/sessionId trio costs
          // ~110 bytes on a frame whose new content is often ~30, so the keys
          // shrink to single letters and the session travels as a handle whose
          // name is sent once (`n`).
          let handle = state.sessionHandles.get(sessionId);
          const firstUse = handle === undefined;
          if (handle === undefined) {
            handle = state.sessionHandles.size + 1;
            state.sessionHandles.set(sessionId, handle);
          }
          return deps.sendEncryptedFrame(
            clientId,
            {
              e: 'T',
              s: handle,
              ...(firstUse ? { n: sessionId } : {}),
              w: wire,
              // 'live' is the overwhelming default; only a replay announces itself.
              ...(update.frameSource && update.frameSource !== 'live' ? { f: update.frameSource } : {}),
              // Only a null frame carries it, so the key never rides a streaming one.
              ...(update.laneEnd ? { le: update.laneEnd } : {}),
              ...(perfProbe ? { pp: perfProbe } : {}),
              ...(typeof update.contentRevision === 'number' ? { cr: update.contentRevision } : {}),
            },
            !critical
          );
        })
      ).finally(() => mailbox.acknowledge(sequence));
    });
    mailboxes.set(sessionId, mailbox);
    return mailbox;
  };
  return {
    publish: (update) => mailboxFor(update.sessionId).publish(update),
    acknowledgeFrame: (payload) => paintProbes.acknowledgeFrame(payload),
    clear: () => {
      for (const mailbox of mailboxes.values()) mailbox.clear();
      mailboxes.clear();
      paintProbes.clear();
    },
  };
}
