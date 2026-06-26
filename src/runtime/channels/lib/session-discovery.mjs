import { readFileSync, readdirSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { basename, join, resolve } from "path";
import { homedir } from "os";

function cwdToProjectSlug(cwd) {
  return resolve(cwd).replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1-").replace(/\//g, "-");
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
      const out2 = execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle", "Hidden",
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
  const sessionFile = join(homedir(), ".mixdog", "sessions", `${pid}.json`);
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
function discoverCurrentClaudeSession() {
  let pid = process.ppid;
  for (let depth = 0; pid && pid > 1 && depth < 6; depth += 1) {
    const session = readSessionRecord(pid);
    if (session) return session;
    pid = getParentPid(pid);
  }
  return null;
}
function listInteractiveClaudeSessions() {
  const sessionsDir = join(homedir(), ".mixdog", "sessions");
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
  getParentPid,
  readSessionRecord,
  isInteractiveSession,
  discoverCurrentClaudeSession,
  listInteractiveClaudeSessions,
  getLatestInteractiveClaudeSession
};
