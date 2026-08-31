// Old-space caps for Mixdog's long-lived Node processes.
//
// V8 sizes its heap against the limit it was given, not against the working
// set it actually needs. Under the default 4GB ceiling a daemon whose live set
// sits at 110-270MB has no reason to hand pages back, so the process stays
// resident far above its own heap — measured here at RSS 672MB against a
// heapTotal of 214MB.
//
// Capping old space makes V8 pace its major GCs against a realistic size. On
// this exact runtime, one identical workload settled at RSS 401MB uncapped
// versus 245MB under a 768MB cap (39% lower) while the live set was unchanged;
// the gap between heapTotal and RSS fell from 274MB to 100MB. The desktop
// renderer already banks the same win from its own cap — see the note above
// `rendererHeapMb` in apps/desktop/src/main/index.ts, which reached this
// conclusion first and named forced collection as the path that does NOT work.
//
// Every cap sits well above its role's measured peak, so the ceiling shapes GC
// pacing and never becomes an allocation failure. `<ROLE>_HEAP_MB=0` restores
// V8's own sizing, mirroring the MIXDOG_RENDERER_HEAP_MB escape hatch.

const OLD_SPACE_FLAG = '--max-old-space-size';

const ROLES = {
  // Peak heapUsed measured on a daemon hosting six live sessions: 268MB.
  daemon: { env: 'MIXDOG_DAEMON_HEAP_MB', defaultMb: 768 },
  // Memory runtime observed resident at 259MB with the embedding model cold.
  memory: { env: 'MIXDOG_MEMORY_HEAP_MB', defaultMb: 512 },
  // Shard-mode session runtime holds the same transcripts the daemon would.
  'session-runtime': { env: 'MIXDOG_SESSION_RUNTIME_HEAP_MB', defaultMb: 768 },
};

/** Cap in MB for a role; 0 means "leave V8's own sizing alone". */
export function heapCapMb(role, env = process.env) {
  const spec = ROLES[role];
  if (!spec) return 0;
  const raw = env[spec.env];
  if (raw != null && String(raw).trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return spec.defaultMb;
}

/**
 * execArgv for a forked role, preserving whatever flags the caller already
 * needs. A cap the caller passed in explicitly wins: a launcher that already
 * sized its child knows something this table does not.
 */
export function withHeapCap(role, execArgv = [], env = process.env) {
  const argv = Array.isArray(execArgv) ? [...execArgv] : [];
  if (argv.some((arg) => String(arg).startsWith(OLD_SPACE_FLAG))) return argv;
  const mb = heapCapMb(role, env);
  if (!(mb > 0)) return argv;
  argv.push(`${OLD_SPACE_FLAG}=${mb}`);
  return argv;
}
