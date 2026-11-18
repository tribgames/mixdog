/**
 * The endpoint a relayed command runs under, from its dispatch to every worker request it makes: the scope's `commit` and signal
 * admit each request right before it is sent, and `track` counts it until it settled (`worker-pool.ts` `fenced`). The dispatch chain
 * (`answerAdmittedCommand` → `answerPublicCommand` → `dispatchBridgeCommand`) takes the endpoint as a required argument and runs the
 * command inside it, so every request the command's queue, router, sequence runner or secret typing sends, however many awaits
 * later, is admitted through it: once a scope's endpoint is supplied, nothing of its command reaches a worker unfenced.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** What a relayed command is admitted through (a scope's `ScopeContext` is one). */
export interface CommandEndpoint {
  /** Aborts when the command may no longer act. */
  readonly signal: AbortSignal;
  /** Throws unless the command may still submit: called right before each request. */
  commit(): void;
  /** Counts one submitted request until it settled. */
  track(reply: Promise<unknown>): void;
}

const fence = new AsyncLocalStorage<CommandEndpoint>();

/** Runs `run` with `endpoint` as the endpoint of everything it sends. */
export function underEndpoint<T>(endpoint: CommandEndpoint, run: () => Promise<T>): Promise<T> {
  return fence.run(endpoint, run);
}

/** The endpoint the caller runs under, if any. */
export function currentEndpoint(): CommandEndpoint | undefined {
  return fence.getStore();
}

/** Runs `run` under no endpoint: what it starts (a worker, its timers and listeners) outlives the command and is not its own. */
export function outsideEndpoint<T>(run: () => T): T {
  return fence.exit(run);
}

/** The endpoint of a command no automation scope relays (the loopback HTTP bridge, a capture): its caller's signal, and the
 *  desktop's Computer Use switch (`enabled`) as its admission; its requests are not counted for any scope. */
export function switchEndpoint(signal: AbortSignal, enabled: () => boolean): CommandEndpoint {
  return {
    signal,
    commit() {
      if (!enabled()) throw new Error('computer use is unavailable; open the Mixdog desktop app and enable Computer Use in settings');
    },
    track() {},
  };
}
