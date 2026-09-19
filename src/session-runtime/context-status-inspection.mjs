// Inspector attachment for a /context status. Entry ids address positions in
// the transcript the inspector listed, and a running turn keeps appending to
// it. Resolving a preview against the live transcript therefore refused almost
// every entry opened during a turn ("Context changed. Select the entry
// again."). Keep the last inspected snapshots — message and tool references
// only — so a preview is answered from the exact revision its reader is
// looking at.
import { providerBaselineCoverage } from '../runtime/agent/orchestrator/session/loop/compact-policy.mjs';
import { inspectContext } from './context-inspection.mjs';

// How many inspected snapshots stay resolvable for entry previews. One open
// inspector needs a single slot; the spares cover a second surface and a reader
// who keeps opening entries while newer readings arrive.
const INSPECTION_SNAPSHOT_LIMIT = 4;

function deferredCatalogNames(session) {
  return new Set(
    [
      ...(Array.isArray(session?.deferredToolCatalog) ? session.deferredToolCatalog : []),
      ...(Array.isArray(session?.deferredLateToolCatalog) ? session.deferredLateToolCatalog : []),
    ]
      .map((tool) => String(tool?.name || '').trim())
      .filter(Boolean)
  );
}

export function createInspectionSnapshots() {
  const snapshots = new Map();

  function retain(revision, input) {
    snapshots.delete(revision);
    snapshots.set(revision, input);
    for (const oldest of snapshots.keys()) {
      if (snapshots.size <= INSPECTION_SNAPSHOT_LIMIT) break;
      snapshots.delete(oldest);
    }
  }

  return function withInspection(status, messages, tools, options, session) {
    if (options?.inspect !== true) return status;
    const requestedRevision = options.entryId !== undefined ? String(options.revision || '') : '';
    const retained = requestedRevision ? snapshots.get(requestedRevision) : null;
    const input = retained || {
      sessionId: status.sessionId,
      provider: status.provider,
      model: status.model,
      // Copy both lists: the live turn pushes into its own array, and a
      // retained revision has to keep the order its entry ids were built from.
      messages: messages.slice(),
      tools: tools.slice(),
      overheadTokens: status.request.requestOverheadTokens,
      // The provider's own count for the prefix it measured lets the
      // inspector reconcile its estimates with the gauge's headline.
      coverage: providerBaselineCoverage(session, messages),
      deferredCatalogNames: deferredCatalogNames(session),
    };
    const inspection = inspectContext(input, options);
    retain(inspection.revision, input);
    return { ...status, inspection };
  };
}
