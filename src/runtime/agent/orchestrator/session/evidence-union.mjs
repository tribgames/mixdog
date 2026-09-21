// Compatibility boundary for request projection and its telemetry. Tool
// results are delivered verbatim, including repeated source windows and paths.
// Stored-history compaction and artifact offload are handled elsewhere.
export function projectProviderEvidence(messages) {
  const bytes = Array.isArray(messages) ? messages.reduce((sum, message) => sum + toolResultBytes(message), 0) : 0;
  return {
    messages,
    stats: {
      beforeBytes: bytes,
      afterBytes: bytes,
      evidenceRows: 0,
      reusedRows: 0,
      referenceGroups: 0,
      changedToolResults: 0,
      exactResultRefs: 0,
      exactResultBytesSaved: 0,
      pathFacts: 0,
      pathAliases: 0,
      reusedPathFacts: 0,
      pathAliasBytesSaved: 0,
    },
  };
}

function toolResultBytes(message) {
  if (message?.role !== 'tool' || typeof message.content !== 'string') return 0;
  return Buffer.byteLength(message.content, 'utf8');
}
