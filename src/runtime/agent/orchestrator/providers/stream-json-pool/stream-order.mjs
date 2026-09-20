/**
 * stream-json-pool/stream-order.mjs — per-stream FIFO tails. One stream can
 * mix routes (inline below the threshold, offloaded above it, inline again
 * after backpressure or a lost worker); chaining every submission on its
 * stream tail keeps chunk N+1 settling after chunk N no matter which route
 * each took. Entries are refcounted and self-delete at pending === 0, so
 * only idle metadata is ever dropped: an ACTIVE stream can never lose its
 * ordering state to a capacity bound (the live-stream count bounds it).
 */
export function createStreamOrder(stats) {
  // streamKey -> { tail, pending }
  const tails = new Map();

  /**
   * Serialize one stream's submissions. Returns the raw (possibly
   * synchronous) result when the stream has nothing in flight, so the common
   * inline path stays free of promise/microtask overhead.
   */
  function withStreamOrder(streamKey, run) {
    if (!streamKey) return run();
    let entry = tails.get(streamKey) || null;
    const started = entry ? entry.tail.then(run, run) : run();
    if (!started || typeof started.then !== 'function') {
      // Nothing was in flight for this stream and the work completed
      // synchronously: there is no ordering state to retain.
      return started;
    }
    const settled = started.then(
      () => {},
      () => {}
    );
    if (entry) {
      entry.tail = settled;
      entry.pending += 1;
    } else {
      entry = { tail: settled, pending: 1 };
      tails.set(streamKey, entry);
    }
    if (tails.size > stats.peakOrderedStreams) {
      stats.peakOrderedStreams = tails.size;
    }
    const owned = entry;
    settled.then(() => {
      if (tails.get(streamKey) !== owned) return;
      owned.pending = Math.max(0, owned.pending - 1);
      // A stream releases ONLY its own slot, and only once nothing of
      // that stream is in flight. There is no cross-stream eviction, so
      // an active stream can never lose the tail that orders its chunks.
      if (owned.pending === 0) tails.delete(streamKey);
    });
    return started;
  }

  return {
    withStreamOrder,
    has: (streamKey) => tails.has(streamKey),
    get size() {
      return tails.size;
    },
    /**
     * Drop a finished stream's ordering slot. An entry that still has work in
     * flight is left alone — it self-deletes once its last chunk settles — so
     * an early/late release can never unorder a stream that is still running.
     */
    release(streamKey) {
      const entry = tails.get(streamKey);
      if (entry && entry.pending === 0) tails.delete(streamKey);
    },
    clear: () => tails.clear(),
  };
}
