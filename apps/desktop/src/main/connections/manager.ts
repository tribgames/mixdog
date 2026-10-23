import { RemoteBootstrapError } from '../ssh/remote-bootstrap';
import { SshError, SshTargetError, parseSshTarget } from '../ssh/ssh-command';
import type { SshModelLogin } from '../ssh/ssh-context';
import {
  LOCAL_CONNECTION_ID,
  type ConnectionManager,
  type ConnectionOpenOptions,
  type ConnectionProgress,
  type SshConnectionSpec,
} from './contract';
import { ConnectionError } from './errors';
import type { ConnectionPool, PooledConnection } from './pool';

export interface ManagedConnection extends PooledConnection {
  start(): Promise<void>;
  dispose(): Promise<void>;
  /** A terminal failure stopped the attached connection (its window stays). */
  stopped?(): boolean;
  /** Opens a stopped connection again behind the same window. */
  reconnect?(): Promise<void>;
  /** Restarts the server's daemon in the saved model login mode. */
  applyModelLogin?(modelLogin: SshModelLogin): Promise<void>;
}

export interface ConnectionManagerDependencies<T extends ManagedConnection> {
  pool: ConnectionPool<T>;
  createConnection(
    spec: SshConnectionSpec,
    onProgress?: (progress: ConnectionProgress) => void,
    options?: ConnectionOpenOptions
  ): T;
  /** Opens the connection's window, or focuses the one already open. */
  showWindow(connection: T): Promise<void> | void;
  /** Closes every window of the connection (they detach on close). */
  closeWindows(connectionId: string): void;
}

/** The ssh failure itself, not the transport exit that carried it. */
function connectionFailure(error: unknown): unknown {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof RemoteBootstrapError || cause instanceof SshError || cause instanceof SshTargetError
    ? cause
    : error;
}

function closedError(spec: SshConnectionSpec): ConnectionError {
  return new ConnectionError('connection-closed', `The connection to ${spec.name} was closed.`);
}

function requiredSpec(spec: SshConnectionSpec): SshConnectionSpec {
  const id = typeof spec?.id === 'string' ? spec.id.trim() : '';
  if (!id || id.length > 128) throw new TypeError('An ssh connection needs an id.');
  if (id === LOCAL_CONNECTION_ID) throw new TypeError(`"${LOCAL_CONNECTION_ID}" is this PC, not an ssh server.`);
  // A malformed destination will never connect: refuse it before any retry.
  parseSshTarget(spec.target);
  return {
    id,
    name: typeof spec.name === 'string' && spec.name.trim() ? spec.name.trim() : spec.target,
    target: spec.target,
  };
}

/** The attached connections and the attempts to attach: one attempt per id,
 *  shared by everyone who asks while it runs. */
function createAttachments<T extends ManagedConnection>(deps: ConnectionManagerDependencies<T>) {
  const pending = new Map<string, { connection: T; attached: Promise<T> }>();

  const attach = (
    spec: SshConnectionSpec,
    onProgress?: (progress: ConnectionProgress) => void,
    options?: ConnectionOpenOptions
  ): Promise<T> => {
    const open = deps.pool.get(spec.id);
    if (open) {
      // A server window whose connection stopped (a refused login, a changed
      // key): the user's connect opens it again in place, with this
      // attempt's ssh context (and its prompts).
      if (open.stopped?.() && open.reconnect) {
        return open.reconnect().then(
          () => open,
          (error: unknown) => {
            throw connectionFailure(error);
          }
        );
      }
      return Promise.resolve(open);
    }
    const inflight = pending.get(spec.id);
    if (inflight) return inflight.attached;
    const connection = deps.createConnection(spec, onProgress, options);
    const attached = (async () => {
      let failure: unknown = null;
      try {
        await connection.start();
      } catch (error) {
        failure = error;
      }
      // close() drops the entry first when it cancels the attempt.
      const cancelled = pending.get(spec.id)?.connection !== connection;
      if (!cancelled) pending.delete(spec.id);
      if (failure || cancelled) {
        await connection.dispose().catch(() => {});
        throw cancelled ? closedError(spec) : connectionFailure(failure);
      }
      deps.pool.add(connection);
      return connection;
    })();
    pending.set(spec.id, { connection, attached });
    return attached;
  };

  /** Drops the attachment and windows without cancelling queued opens. */
  const detach = async (id: string): Promise<void> => {
    const inflight = pending.get(id);
    if (inflight) {
      pending.delete(id);
      await inflight.connection.dispose();
    }
    const connection = deps.pool.remove(id);
    if (!connection) return;
    deps.closeWindows(id);
    await connection.dispose();
  };

  return { pending, attach, detach };
}

export function createConnectionManager<T extends ManagedConnection>(
  deps: ConnectionManagerDependencies<T>
): ConnectionManager & { closeAll(): Promise<void> } {
  const { pending, attach, detach } = createAttachments(deps);

  // Every close starts a new generation of its connection id: an open taken
  // under an older one is cancelled — it neither attaches nor shows a window.
  const generations = new Map<string, number>();
  const generationOf = (id: string): number => generations.get(id) ?? 0;

  const close = async (id: string): Promise<void> => {
    if (id === LOCAL_CONNECTION_ID) throw new Error('This PC cannot be disconnected.');
    generations.set(id, generationOf(id) + 1);
    await detach(id);
  };

  const openAndShow = async (
    spec: SshConnectionSpec,
    generation: number,
    onProgress?: (progress: ConnectionProgress) => void,
    options?: ConnectionOpenOptions
  ): Promise<void> => {
    const assertCurrent = () => {
      if (generationOf(spec.id) !== generation) throw closedError(spec);
    };
    assertCurrent();
    const attachedBefore = deps.pool.has(spec.id);
    // A close during the attach cancels it (attach disposes and rejects).
    const connection = await attach(spec, onProgress, options);
    assertCurrent();
    try {
      await deps.showWindow(connection);
      // Closed while its window was being built: that window opened after
      // close() swept the windows, so it goes too.
      if (generationOf(spec.id) !== generation) {
        deps.closeWindows(spec.id);
        throw closedError(spec);
      }
    } catch (error) {
      // A connection nobody can see is not left attached.
      if (!attachedBefore && deps.pool.get(spec.id) === connection) await detach(spec.id).catch(() => {});
      throw error;
    }
  };

  // One open-and-show at a time per connection: a second open waits for the
  // first to attach and show, then only focuses that window.
  const opening = new Map<string, Promise<void>>();

  return {
    open(spec, onProgress, options) {
      let checked: SshConnectionSpec;
      try {
        checked = requiredSpec(spec);
      } catch (error) {
        return Promise.reject(error);
      }
      const generation = generationOf(checked.id);
      const previous = opening.get(checked.id);
      const run = (previous ?? Promise.resolve())
        .catch(() => {})
        .then(() => openAndShow(checked, generation, onProgress, options));
      opening.set(checked.id, run);
      const settle = () => {
        if (opening.get(checked.id) === run) opening.delete(checked.id);
      };
      run.then(settle, settle);
      return run;
    },
    isOpen: (id) => id !== LOCAL_CONNECTION_ID && deps.pool.has(id),
    async applyModelLogin(id, modelLogin) {
      if (id === LOCAL_CONNECTION_ID) return;
      await deps.pool.get(id)?.applyModelLogin?.(modelLogin);
    },
    close,
    async closeAll() {
      // Queued opens too: they are cancelled before they attach.
      const ids = new Set([
        ...opening.keys(),
        ...pending.keys(),
        ...deps.pool.list().map((connection) => connection.id),
      ]);
      ids.delete(LOCAL_CONNECTION_ID);
      await Promise.all([...ids].map((id) => close(id).catch(() => {})));
    },
  };
}
