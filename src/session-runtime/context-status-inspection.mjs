// Inspector attachment for a /context status. Entry ids address positions in
// the transcript the inspector listed, and a running turn keeps appending to
// it. Resolving a preview against the live transcript therefore refused almost
// every entry opened during a turn ("Context changed. Select the entry
// again."). Keep the last inspected snapshots — message and tool references
// only — so a preview is answered from the exact revision its reader is
// looking at.
import { providerBaselineCoverage } from '../runtime/agent/orchestrator/session/loop/compact-policy.mjs';
import { buildContextInspection, inspectionRevision, readContextInspection } from './context-inspection.mjs';

// How many inspected readings stay resolvable for entry previews. One open
// inspector needs a single slot; the spares cover a second surface and a reader
// who keeps opening entries while newer readings arrive.
const INSPECTION_SNAPSHOT_LIMIT = 4;

// Calibration is the only input outside the revision: the provider's count for
// the prefix it measured can be replaced while the transcript stands still.
function coverageKey(coverage) {
  return coverage ? `${coverage.count}:${coverage.tokens}` : 'none';
}

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
  const readings = new Map();

  function retain(revision, reading) {
    readings.delete(revision);
    readings.set(revision, reading);
    for (const oldest of readings.keys()) {
      if (readings.size <= INSPECTION_SNAPSHOT_LIMIT) break;
      readings.delete(oldest);
    }
  }

  return function withInspection(status, messages, tools, options, session) {
    if (options?.inspect !== true) return status;
    const requestedRevision = options.entryId !== undefined ? String(options.revision || '') : '';
    // A preview names the revision its entry ids came from, so it is answered
    // from that exact reading. Every other request is identified by its live
    // inputs: an unchanged transcript reuses the reading already built for
    // them instead of pricing the whole conversation again on every open.
    let reading = requestedRevision ? readings.get(requestedRevision) : null;
    if (!reading) {
      const revision = inspectionRevision({
        sessionId: status.sessionId,
        provider: status.provider,
        model: status.model,
        messages,
        tools,
      });
      // The provider's own count for the prefix it measured lets the
      // inspector reconcile its estimates with the gauge's headline.
      const coverage = providerBaselineCoverage(session, messages);
      const key = coverageKey(coverage);
      const cached = readings.get(revision);
      reading =
        cached && cached.coverageKey === key
          ? cached
          : {
              coverageKey: key,
              ...buildContextInspection({
                sessionId: status.sessionId,
                provider: status.provider,
                model: status.model,
                // Copy both lists: the live turn pushes into its own array, and
                // a retained revision has to keep the order its entry ids were
                // built from.
                messages: messages.slice(),
                tools: tools.slice(),
                overheadTokens: status.request.requestOverheadTokens,
                coverage,
                deferredCatalogNames: deferredCatalogNames(session),
                revision,
              }),
            };
    }
    retain(reading.revision, reading);
    return { ...status, inspection: readContextInspection(reading, options) };
  };
}
