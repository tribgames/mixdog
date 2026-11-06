// Records `purge_order.json`: the order in which a booted 1.4.5 daemon registers its session
// purge hooks (`registerSessionPurgeHook`, a Set run in insertion order by
// `_runSessionPurgeHooks`). Run from this folder: `node record_purge_order.mjs <repo root>`.
//
// The daemon's own boot cannot run beside a live daemon (its owner lock is per machine), so this
// replays its load order: the daemon module graph (main() disabled), main's
// `registerMemoryRuntimeLazy` (the transcript hook), the session runtime graph the inline host
// loads, then a runtime's agent tool, whose `createSpawnFlow` (worker turns, `agent-tool.mjs:109`)
// runs before its status sources (`agent-tool.mjs:347`).
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const order = [];
globalThis.__purgeRec = (stack) => {
  const caller = stack.split('\n').slice(1).map((l) => l.trim()).find((f) => !f.includes('session-observers.mjs')) || '';
  const m = caller.match(/(src[\\/][^)]*?):(\d+):\d+\)?$/);
  order.push(m ? `${m[1].replace(/\\/g, '/')}:${m[2]}` : caller);
};
const hooks = `data:text/javascript,${encodeURIComponent(`
export async function load(url, context, next) {
  const result = await next(url, context);
  if (url.endsWith('/session/store/session-observers.mjs')) {
    return { ...result, source: String(result.source).replace('_sessionPurgeHooks.add(hook);', '_sessionPurgeHooks.add(hook); globalThis.__purgeRec?.(new Error().stack);') };
  }
  if (url.endsWith('/standalone/daemon.mjs')) {
    return { ...result, source: String(result.source).replace(/\\nmain\\(\\)\\.catch\\(/, '\\nif (false) main().catch(') };
  }
  return result;
}`)}`;
register(hooks, import.meta.url);
const at = (p) => pathToFileURL(`${process.argv[2]}/${p}`).href;
await import(at('src/standalone/daemon.mjs'));
(await import(at('src/session-runtime/session-transcript-purge.mjs'))).registerTranscriptPurgeHook({});
await import(at('src/standalone/local-session-runtime.mjs'));
await import(at('src/session-runtime/runtime-core.mjs'));
await import(at('src/session-runtime/services/agent-tool.mjs'));
order.push('src/session-runtime/services/agent-tool/worker-turns.mjs:208', 'src/session-runtime/services/agent-tool.mjs:347');
process.stdout.write(`${JSON.stringify(order, null, 2)}\n`);
process.exit(0);
