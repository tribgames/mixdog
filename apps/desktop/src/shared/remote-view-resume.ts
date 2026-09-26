/** Resuming a phone's delta lanes across a short reconnect.
 *
 * The desktop parks a departed phone's encoders under a random token that
 * only ever travelled inside that phone's E2EE channel. On reconnect the
 * phone names the token and, per lane, the revision it last applied plus a
 * digest of what its decoder holds; the desktop adopts a parked encoder only
 * when both equal what that encoder last emitted. Any frame lost in flight
 * leaves the revision or the content behind, so that lane falls back to a
 * full baseline instead of patching the wrong state.
 *
 * Wire (the optional third `synchronizeViews` parameter):
 *   { version: 1, token?, state?: [rev, digest], sessions?: [rev, digest],
 *     agentPool?: [rev, digest], sessionStates?: [[sessionId, rev, digest]] }
 * Answer: `{ resume: token }` from a desktop that parks this phone's lanes;
 * a desktop that predates it answers `true` and ignores the parameter. */
export const VIEW_RESUME_VERSION = 1;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_RESUME_SESSIONS = 128;

/** What a receiver that applied every emitted frame holds right now. */
export interface ViewResumePoint {
  revision: number;
  held: unknown;
}

export interface ViewResumeLane {
  revision: number;
  digest: string;
}

export interface ViewResumeRequest {
  token: string | null;
  state: ViewResumeLane | null;
  sessions: ViewResumeLane | null;
  agentPool: ViewResumeLane | null;
  sessionStates: Map<string, ViewResumeLane>;
}

type WireLane = [number, string];

/** Object keys sorted at every depth: both ends must hash the same JSON even
 * where a decoder merged fields into a different key order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = record[key];
    return sorted;
  }) ?? 'null';
}

export async function viewResumeDigest(held: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(held));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export async function viewResumeLane(point: ViewResumePoint | null): Promise<ViewResumeLane | null> {
  return point ? { revision: point.revision, digest: await viewResumeDigest(point.held) } : null;
}

/** The encoder's last emission is exactly what the phone says it holds. */
export async function viewResumeLaneMatches(
  point: ViewResumePoint | null,
  lane: ViewResumeLane | null | undefined
): Promise<boolean> {
  return (
    !!point && !!lane && point.revision === lane.revision && (await viewResumeDigest(point.held)) === lane.digest
  );
}

/** The phone's request. Without a token it only announces that it can resume
 * a LATER reconnect; claims travel only while its decoders are intact. */
export async function createViewResumeRequest(
  token: string | null,
  points: {
    state: ViewResumePoint | null;
    sessions: ViewResumePoint | null;
    agentPool: ViewResumePoint | null;
    sessionStates: Array<[string, ViewResumePoint | null]>;
  } | null
): Promise<Record<string, unknown>> {
  if (!token || !points) return { version: VIEW_RESUME_VERSION };
  const wire = async (point: ViewResumePoint | null): Promise<WireLane | undefined> => {
    const lane = await viewResumeLane(point);
    return lane ? [lane.revision, lane.digest] : undefined;
  };
  const sessionStates: Array<[string, number, string]> = [];
  for (const [sessionId, point] of points.sessionStates.slice(0, MAX_RESUME_SESSIONS)) {
    const lane = await viewResumeLane(point);
    if (lane) sessionStates.push([sessionId, lane.revision, lane.digest]);
  }
  return {
    version: VIEW_RESUME_VERSION,
    token,
    state: await wire(points.state),
    sessions: await wire(points.sessions),
    agentPool: await wire(points.agentPool),
    sessionStates,
  };
}

function readLane(value: unknown): ViewResumeLane | null | false {
  if (value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isSafeInteger(value[0]) ||
    value[0] < 0 ||
    typeof value[1] !== 'string' ||
    !DIGEST_PATTERN.test(value[1])
  )
    return false;
  return { revision: value[0], digest: value[1] };
}

/** Null for a phone that predates resumption. A malformed claim is ignored
 * rather than rejected: the phone still gets today's full recovery. */
export function readViewResumeRequest(value: unknown): ViewResumeRequest | null {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== VIEW_RESUME_VERSION) {
    return null;
  }
  const request = value as Record<string, unknown>;
  const none: ViewResumeRequest = {
    token: null,
    state: null,
    sessions: null,
    agentPool: null,
    sessionStates: new Map(),
  };
  if (request.token === undefined) return none;
  if (typeof request.token !== 'string' || !TOKEN_PATTERN.test(request.token)) return none;
  const state = readLane(request.state);
  const sessions = readLane(request.sessions);
  const agentPool = readLane(request.agentPool);
  if (state === false || sessions === false || agentPool === false) return none;
  const sessionStates = new Map<string, ViewResumeLane>();
  if (request.sessionStates !== undefined) {
    if (!Array.isArray(request.sessionStates) || request.sessionStates.length > MAX_RESUME_SESSIONS) return none;
    for (const entry of request.sessionStates) {
      if (!Array.isArray(entry) || entry.length !== 3 || typeof entry[0] !== 'string' || entry[0].length > 128) {
        return none;
      }
      const lane = readLane(entry.slice(1));
      if (!lane) return none;
      sessionStates.set(entry[0], lane);
    }
  }
  return { token: request.token, state, sessions, agentPool, sessionStates };
}

/** The token a synchronizeViews answer carries, if the desktop issued one. */
export function readViewResumeGrant(value: unknown): string | null {
  const token = value && typeof value === 'object' ? (value as { resume?: unknown }).resume : undefined;
  return typeof token === 'string' && TOKEN_PATTERN.test(token) ? token : null;
}
