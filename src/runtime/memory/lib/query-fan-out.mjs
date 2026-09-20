// Array query — fan out in parallel, each query runs its own hybrid search
// path, and results are grouped in the response so the caller sees one
// ranked list per angle. Collapses what would otherwise be N sequential
// tool calls into a single invocation.
import { embedTexts, isEmbeddingModelReady, warmupEmbeddingProvider } from './embedding-provider.mjs';

// Dedup + fan-out cap. The cap protects the result envelope from over-eager
// callers (20+ near-duplicate queries N× the IO) without silently swallowing
// the caller's intent: when the input exceeds QUERIES_CAP, a one-line note is
// prepended so the caller can see the truncation and re-shape their list.
const QUERIES_CAP = 5;

export async function fanOutSearchQueries(args, signal, { search, log, embeddingOnDemandCanStart }) {
  const dedup = [...new Set(args.query.map((q) => String(q || '').trim()).filter(Boolean))];
  if (dedup.length === 0) return { text: '' };
  const queries = dedup.slice(0, QUERIES_CAP);
  const dropped = dedup.length - queries.length;
  const rest = { ...args };
  delete rest.query;
  const deadlineSec = Math.max(1, Number(process.env.MEMORY_FANOUT_DEADLINE_S) || 180);
  const deadlineMs = deadlineSec * 1000;
  const fanOutAbort = new AbortController();
  let deadlineTimer;
  const deadlineRace = new Promise((_res, rej) => {
    deadlineTimer = setTimeout(() => {
      fanOutAbort.abort(new Error(`memory fan-out deadline exceeded (${deadlineSec}s)`));
      rej(Object.assign(new Error(`memory fan-out deadline exceeded (${deadlineSec}s)`), { _deadline: true }));
    }, deadlineMs);
  });
  let settled;
  try {
    // Pre-warm cached query vectors when the model is resident. A cold
    // fan-out starts one shared warmup here; each sub-query then observes
    // the same bounded wait in embedRecallQuery instead of starting its own
    // worker load.
    if (isEmbeddingModelReady()) {
      // Race against the same deadline as the fan-out itself: a stuck
      // embedding worker would previously park here indefinitely because
      // the timer hadn't been started yet from the fan-out's perspective.
      await Promise.race([embedTexts(queries, { inputType: 'query' }), deadlineRace]);
    } else if (embeddingOnDemandCanStart()) {
      void warmupEmbeddingProvider().catch((err) => {
        log(`[memory-service] embedding warmup after cold fan-out skipped dense search: ${err?.message || err}\n`);
      });
    }
    settled = await Promise.race([
      Promise.all(
        queries.map(async (q) => {
          if (fanOutAbort.signal.aborted) throw fanOutAbort.signal.reason;
          if (signal?.aborted) throw signal.reason ?? new Error('aborted');
          const sub = await search({ ...rest, query: q }, signal);
          return `[${q}]\n${sub.text || '(no results)'}`;
        })
      ),
      deadlineRace,
    ]);
  } finally {
    clearTimeout(deadlineTimer);
  }
  const parts = settled;
  const header =
    dropped > 0
      ? `note: ${dedup.length} queries received, ${queries.length} processed, ${dropped} dropped (cap ${QUERIES_CAP})\n\n`
      : '';
  return { text: header + parts.join('\n\n') };
}
