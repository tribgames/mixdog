// The three start calls (`startTask`, `startProject`, `startProjectTask`) create no thread: they answer Node's blank snapshot, the
// folder the next task starts in (session-host-lifecycle.ts blankSnapshot/startProject/startProjectTask), composed from the
// core's project methods. The desktop's service lane and the phone's chat adapter both compose it here, so there is one copy.
// No Node imports: the phone's web build includes this file.
import type { SessionSnapshot } from './contract';

/** One core request; the caller's `send` runs it and throws what its transport throws (the desktop: `coreErrorForWindow`). */
export type StartSend = (request: { method: string; params: Record<string, unknown> }) => Promise<unknown>;

export type StartCall = 'startTask' | 'startProject' | 'startProjectTask';

export const START_CALLS: ReadonlySet<string> = new Set<StartCall>(['startTask', 'startProject', 'startProjectTask']);

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** `applyRemoteSessionState`: the id of the one session the remote channel serves, as the snapshots carry it. Node accepted
 *  an id of at most 256 characters that is a session id; the core's `hostState` key `remoteSession` is `{ enabled, sessionId, cwd }`, its id null while off. */
export function remoteSessionIdOf(state: unknown): string {
  const record = state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
  const candidate = String(record.sessionId || '');
  return candidate.length <= 256 && SESSION_ID.test(candidate) ? candidate : '';
}

/** `snapshotWithRemoteSession`: every snapshot the host hands out says whether the remote channel is on and for which session. */
export function withRemoteSession<T>(snapshot: T, remoteSessionId: string): T {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  return { ...snapshot, remoteEnabled: Boolean(remoteSessionId), remoteSessionId: remoteSessionId || null };
}

/** Node's `blankSnapshot`: no session yet, the folder the next task starts in. */
export function blankSnapshot(cwd: string, projectPath: string | null, remoteSessionId: string): SessionSnapshot {
  return withRemoteSession(
    {
      sessionId: '',
      items: [],
      queued: [],
      busy: false,
      commandBusy: false,
      cwd,
      currentProject: projectPath,
      desktopSession: { classification: projectPath ? 'project' : 'task', projectPath },
    },
    remoteSessionId
  ) as unknown as SessionSnapshot;
}

const reasonOf = (error: unknown): unknown =>
  (error as { detail?: { data?: { reason?: unknown } } } | null)?.detail?.data?.reason;

/** The error Node's `canonicalDirectory` / `knownProject` threw, from the core's coded failure (project/create, directory, touch):
 *  `pathMissing` carries the path `realpath` named, `notADirectory` Node's text, a refused (unregistered) Project is the
 *  core's `permissionDenied`. Any other failure is returned as it came. */
export function nodeStartError(error: unknown): unknown {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (code === 'pathMissing' && typeof message === 'string') {
    return Object.assign(new Error(`ENOENT: no such file or directory, realpath '${message}'`), { code: 'ENOENT', syscall: 'realpath', path: message });
  }
  if (code === 'notADirectory' && typeof message === 'string') return new TypeError(message);
  if (reasonOf(error) === 'permissionDenied') return new Error('Project is not available.');
  return error;
}

/** The folder a start call begins in, and the Project it names (null for a task), in Node's order: the folder is resolved
 *  first, then the Project is registered (`startProject`) and marked used. A touch that fails changes nothing for the caller. */
export async function startFolder(
  send: StartSend,
  call: StartCall,
  projectPath?: string
): Promise<{ cwd: string; projectPath: string | null }> {
  const ask = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try {
      return (await send({ method, params })) as Record<string, unknown>;
    } catch (error) {
      throw nodeStartError(error);
    }
  };
  const touch = (path: string): Promise<unknown> => send({ method: 'project/touch', params: { path } }).catch(() => undefined);
  if (call === 'startTask') return { cwd: String((await ask('project/taskWorkspace', {})).path), projectPath: null };
  const path = String(projectPath);
  if (call === 'startProject') {
    const folder = String(((await ask('project/create', { path })).project as Record<string, unknown>).path);
    await touch(folder);
    return { cwd: folder, projectPath: folder };
  }
  const folder = String((await ask('project/directory', { path, owner: true })).path);
  await touch(path);
  return { cwd: folder, projectPath: folder };
}
