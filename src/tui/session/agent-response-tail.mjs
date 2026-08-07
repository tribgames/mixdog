// Pure, tail-only inbound-agent response aggregation. The caller decides
// whether the transcript tail is eligible; this helper never searches older
// rows, so a retry cannot mutate across a real transcript boundary.
function responseEntry(response = {}) {
  return {
    key: String(response.key || ''),
    raw: String(response.rawResult ?? response.raw ?? '').trim(),
    result: response.result,
    hasBody: response.hasBody === true,
    isError: response.isError === true,
  };
}

export function formatAgentResponseRaw(entries = []) {
  return entries
    .map((entry, index) => {
      const raw = String(entry?.raw || '').trim();
      return raw ? `${index + 1}. agent\n${raw}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function priorEntries(previous) {
  if (Array.isArray(previous?.agentResponseEntries) && previous.agentResponseEntries.length) {
    return previous.agentResponseEntries.map(responseEntry);
  }
  return [responseEntry({
    key: previous?.agentResponseKey,
    rawResult: previous?.rawResult ?? previous?.result,
    result: previous?.result,
    hasBody: previous?.agentResponseHasBody,
    isError: previous?.isError,
  })];
}

export function appendAgentResponseTail(previous, response, now = Date.now()) {
  if (previous?.kind !== 'tool' || previous.agentDirection !== 'inbound') return null;
  const next = responseEntry(response);
  const entries = priorEntries(previous);
  const existingIndex = next.key ? entries.findIndex((entry) => entry.key === next.key) : -1;

  if (existingIndex >= 0) {
    // A preview/final/retry for the same execution is one response. Replace
    // that entry in-place only because this aggregate is still the transcript
    // tail; never turn it into another count or a nested raw block.
    entries[existingIndex] = next;
  } else {
    // Distinct responses can merge only when their presentation phase matches.
    // A visible bodyless failure stays a separate row from a later full body.
    if (previous.agentResponseHasBody !== next.hasBody) return null;
    entries.push(next);
  }

  return {
    args: response.args,
    result: response.result,
    rawResult: formatAgentResponseRaw(entries) || null,
    isError: entries.some((entry) => entry.isError),
    count: entries.length,
    completedCount: entries.length,
    completedAt: now,
    agentResponseEntries: entries,
    agentResponseKeys: entries.map((entry) => entry.key).filter(Boolean),
    agentResponseHasBody: entries.every((entry) => entry.hasBody),
    agentResponseAggregate: entries.length > 1,
  };
}
