import { readFileSync, readdirSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { basename, join, resolve } from "path";
import { mixdogHome } from "../../shared/plugin-paths.mjs";

function cwdToProjectSlug(cwd) {
  return resolve(cwd).replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1-").replace(/\//g, "-");
}
// Parent of a live pid never changes for the lifetime of that pid, so a
// resolved (non-null) parent is cached forever. A null result (pid gone /
// lookup failed) is cached briefly so a burst of calls during process exit
// doesn't re-spawn powershell.exe on every tick, but still allows retry.
// A cached null is only trusted while the pid itself is DEAD: if the pid is
// still alive, a null parent was a transient lookup failure (e.g. powershell
// hiccup), and serving it from cache would make every retry inside the
// first-inbound steal poll (50ms x 500ms window) reuse the failure and time
// out to the stale binding. Live pid + cached null = treat as cache miss.
const parentPidCache = new Map(); // pid -> { value: number|null, expiresAt: number|null }
const NULL_PARENT_TTL_MS = 30_000;

function _pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function getParentPidCached(pid, fresh = false) {
  const cached = parentPidCache.get(pid);
  if (!fresh && cached && (cached.expiresAt === null || cached.expiresAt > Date.now())) {
    if (cached.value !== null || !_pidAlive(pid)) return cached.value;
    // fall through: live pid with cached-null parent → retry fresh lookup
  }
  if (fresh && cached && cached.expiresAt === null) return cached.value; // resolved parent never changes
  const value = getParentPid(pid);
  parentPidCache.set(pid, {
    value,
    expiresAt: value === null ? Date.now() + NULL_PARENT_TTL_MS : null
  });
  return value;
}
function getParentPid(pid) {
  try {
    if (process.platform === "win32") {
      // windowsHide + stdio:['ignore','pipe','ignore'] suppresses the
      // conhost flash that otherwise appears on every call. This routine
      // runs inside the parent-PID walk of discoverCurrentClaudeSession,
      // which fires per transcript watchDebounce tick, so without these flags users
      // see a powershell.exe console window pop in/out repeatedly during
      // any chat activity — including while the config UI is loading.
      // NO `-WindowStyle Hidden` CLI switch: windowsHide already covers it,
      // and the token triggers Defender's PowhidSubExec false positive.
      const out2 = execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`
      ], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      const parsed2 = parseInt(out2, 10);
      return Number.isFinite(parsed2) ? parsed2 : null;
    }
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }).trim();
    const parsed = parseInt(out, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function readSessionRecord(pid) {
  const sessionFile = join(mixdogHome(), "sessions", `${pid}.json`);
  try {
    const sessionFileStat = statSync(sessionFile);
    const session = JSON.parse(readFileSync(sessionFile, "utf8"));
    if (!session.sessionId) return null;
    return {
      pid,
      sessionId: session.sessionId,
      cwd: resolve(session.cwd ?? process.cwd()),
      transcriptPath: typeof session.transcriptPath === "string" && session.transcriptPath
        ? resolve(session.transcriptPath)
        : "",
      startedAt: typeof session.startedAt === "number" ? session.startedAt : 0,
      updatedAt: typeof session.updatedAt === "number" ? session.updatedAt : sessionFileStat.mtimeMs,
      kind: typeof session.kind === "string" ? session.kind : "",
      entrypoint: typeof session.entrypoint === "string" ? session.entrypoint : "",
      sessionFile
    };
  } catch {
    return null;
  }
}
function isInteractiveSession(session) {
  if (!session) return false;
  return session.kind === "interactive" || !session.kind && session.entrypoint === "cli";
}
// Full parent-PID walk result cached per process.ppid for a short TTL so
// rapid-fire inbound messages / watchDebounce ticks don't repeat the walk.
// A cache hit still re-verifies the session file exists (cheap fs read)
// before being trusted, so staleness is bounded by readSessionRecord truth,
// not just the TTL. Null (no session found) is intentionally NOT cached:
// right after channel activate the parent session record may not exist yet,
// and negative-caching would delay the first transcript steal by up to the
// TTL. Re-walking on miss is cheap because parentPidCache makes the walk
// spawn-free.
const sessionWalkCache = new Map(); // ppid -> { session, expiresAt }
const SESSION_WALK_TTL_MS = 10_000;

function discoverCurrentClaudeSession(options = {}) {
  const fresh = options.fresh === true;
  const rootPid = process.ppid;
  const cached = fresh ? undefined : sessionWalkCache.get(rootPid);
  if (cached && cached.expiresAt > Date.now()) {
    const reverified = readSessionRecord(cached.session.pid);
    if (reverified) return reverified;
    sessionWalkCache.delete(rootPid);
  }
  let pid = rootPid;
  for (let depth = 0; pid && pid > 1 && depth < 6; depth += 1) {
    const session = readSessionRecord(pid);
    if (session) {
      sessionWalkCache.set(rootPid, { session, expiresAt: Date.now() + SESSION_WALK_TTL_MS });
      return session;
    }
    pid = getParentPidCached(pid, fresh);
  }
  return null;
}
function listInteractiveClaudeSessions() {
  const sessionsDir = join(mixdogHome(), "sessions");
  try {
    return readdirSync(sessionsDir).filter((file) => file.endsWith(".json")).map((file) => parseInt(basename(file, ".json"), 10)).filter((pid) => Number.isFinite(pid)).map((pid) => readSessionRecord(pid)).filter(isInteractiveSession).sort((a, b) => {
      if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
      return b.pid - a.pid;
    });
  } catch {
    return [];
  }
}
function getLatestInteractiveClaudeSession() {
  return listInteractiveClaudeSessions()[0] ?? null;
}

export {
  cwdToProjectSlug,
  discoverCurrentClaudeSession,
  listInteractiveClaudeSessions,
  getLatestInteractiveClaudeSession
};
