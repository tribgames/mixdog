// Provider adapters also report transport/ack progress so stall watchdogs can
// distinguish a live connection from a dead one. Those events are not visible
// model output and must not satisfy user-facing TTFT or launch heavy warmups.
export function isVisibleStreamProgress(kind) {
  return kind === 'text' || kind === 'reasoning' || kind === 'tool';
}
