/** Local user input on a page outranks the agent: a takeover aborts the agent
 *  commands queued on that page and keeps new ones out until the user has
 *  been quiet for a moment. */
import type { BrowserCommand } from './command';

const LOCAL_INPUT_QUIET_MS = 1_000;
const LOCAL_INPUT_TAKEOVER =
  'Browser command interrupted by local user input. An earlier action may have completed; do not replay it. Wait until the user is idle, then observe the page again.';

interface LocalInput {
  pending: number;
  held: boolean;
  until: number;
}

export interface LocalInputQueueHost {
  /** Agent command controllers per queue key, aborted by a takeover. */
  agents: Map<string, Set<AbortController>>;
  keyFor(command: BrowserCommand): string;
  executeSerialized<T>(
    command: BrowserCommand,
    requestSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
    maxWaitMs?: number
  ): Promise<T>;
}

export function createLocalInputQueue(host: LocalInputQueueHost) {
  const localInput = new Map<string, LocalInput>();
  const { agents, keyFor, executeSerialized } = host;

  /** The error an agent command on this key is refused with right now; a
   *  quiet, released entry is forgotten instead. */
  function takeoverError(key: string, now: number): Error | undefined {
    const local = localInput.get(key);
    if (!local) return undefined;
    if (local.pending || local.held || now < local.until) return new Error(LOCAL_INPUT_TAKEOVER);
    localInput.delete(key);
    return undefined;
  }

  function abortAgents(key: string): void {
    for (const agent of agents.get(key) ?? []) agent.abort(new Error(LOCAL_INPUT_TAKEOVER));
  }

  /** The key's local-input record, with its quiet period restarted. */
  function touch(key: string): LocalInput {
    const local = localInput.get(key) ?? { pending: 0, held: false, until: 0 };
    local.until = performance.now() + LOCAL_INPUT_QUIET_MS;
    localInput.set(key, local);
    return local;
  }

  function interrupt(key: string): LocalInput {
    const local = touch(key);
    local.held = false;
    abortAgents(key);
    return local;
  }

  function executeLocal<T>(
    command: BrowserCommand,
    operation: (signal: AbortSignal) => Promise<T>,
    options: { takeover: boolean; dropIfBusy?: boolean; held?: boolean; maxWaitMs?: number }
  ): Promise<T | undefined> {
    const key = keyFor(command);
    const group = agents.get(key);
    // Hover is expendable and must not cancel automation or build a backlog.
    if (options.dropIfBusy && group?.size) return Promise.resolve(undefined);
    if (!options.takeover) return executeSerialized(command, undefined, operation, options.maxWaitMs);
    const local = touch(key);
    local.pending += 1;
    abortAgents(key);
    return executeSerialized(command, undefined, operation, options.maxWaitMs)
      .then((result) => {
        if (options.held !== undefined) local.held = options.held;
        return result;
      })
      .finally(() => {
        if (options.held === false) local.held = false;
        local.pending -= 1;
        local.until = performance.now() + LOCAL_INPUT_QUIET_MS;
      });
  }

  function releaseLocal(command: BrowserCommand): void {
    localInput.delete(keyFor(command));
  }

  function interruptForLocal(command: BrowserCommand): void {
    interrupt(keyFor(command));
  }

  function holdLocal(command: BrowserCommand): () => void {
    const local = interrupt(keyFor(command));
    local.pending += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      local.pending -= 1;
      local.until = performance.now() + LOCAL_INPUT_QUIET_MS;
    };
  }

  return { takeoverError, executeLocal, releaseLocal, interruptForLocal, holdLocal };
}
