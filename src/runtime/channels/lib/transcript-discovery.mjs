import { readdirSync, existsSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import {
  cwdToProjectSlug,
  discoverCurrentClaudeSession,
  listInteractiveClaudeSessions
} from "./session-discovery.mjs";
import { mixdogHome } from "../../shared/plugin-paths.mjs";

function resolveTranscriptForSession(session) {
  const projectsDir = join(mixdogHome(), "projects");
  const projectSlug = cwdToProjectSlug(process.cwd());
  const directTranscript = session.transcriptPath ? resolve(session.transcriptPath) : "";
  if (directTranscript && existsSync(directTranscript)) {
    return {
      claudePid: session.pid,
      sessionId: session.sessionId,
      sessionCwd: session.cwd,
      transcriptPath: directTranscript,
      exists: true
    };
  }
  const preferred = join(projectsDir, cwdToProjectSlug(session.cwd), `${session.sessionId}.jsonl`);
  if (existsSync(preferred)) {
    return {
      claudePid: session.pid,
      sessionId: session.sessionId,
      sessionCwd: session.cwd,
      transcriptPath: preferred,
      exists: true
    };
  }
  const fallback = join(projectsDir, projectSlug, `${session.sessionId}.jsonl`);
  if (existsSync(fallback)) {
    return {
      claudePid: session.pid,
      sessionId: session.sessionId,
      sessionCwd: session.cwd,
      transcriptPath: fallback,
      exists: true
    };
  }
  return {
    claudePid: session.pid,
    sessionId: session.sessionId,
    sessionCwd: session.cwd,
    transcriptPath: directTranscript || preferred,
    exists: false
  };
}
function findLatestTranscriptByMtime(cwd) {
  const projectsDir = join(mixdogHome(), "projects");
  const slug = cwdToProjectSlug(cwd ?? process.cwd());
  const projectDir = join(projectsDir, slug);
  try {
    const files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl")).map((f) => {
      const full = join(projectDir, f);
      try {
        return { path: full, mtime: statSync(full).mtimeMs };
      } catch {
        return null;
      }
    }).filter((f) => f !== null).sort((a, b) => b.mtime - a.mtime);
    return files[0]?.path ?? null;
  } catch {
    return null;
  }
}
function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function sameResolvedPath(left, right) {
  if (!left || !right) return false;
  try {
    const normalizedLeft = resolve(left);
    const normalizedRight = resolve(right);
    return process.platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  } catch {
    return false;
  }
}
function transcriptStat(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    return statSync(transcriptPath);
  } catch {
    return null;
  }
}
function sessionTranscriptCandidate(session, source) {
  if (!session) return null;
  const bound = resolveTranscriptForSession(session);
  if (!bound?.transcriptPath) return null;
  const stat = bound.exists ? transcriptStat(bound.transcriptPath) : null;
  const active = isPidAlive(session.pid);
  const cwdMatches = sameResolvedPath(session.cwd, process.cwd());
  return {
    ...bound,
    source,
    active,
    cwdMatches,
    parentChain: source === "parent-chain",
    transcriptMtime: stat?.mtimeMs ?? 0,
    sessionUpdatedAt: session.updatedAt ?? 0,
    startedAt: session.startedAt ?? 0
  };
}
function latestMtimeTranscriptCandidate() {
  const transcriptPath = findLatestTranscriptByMtime(process.cwd());
  if (!transcriptPath) return null;
  const stat = transcriptStat(transcriptPath);
  return {
    claudePid: null,
    sessionId: basename(transcriptPath, ".jsonl"),
    sessionCwd: process.cwd(),
    transcriptPath,
    exists: true,
    source: "latest-mtime",
    active: false,
    cwdMatches: true,
    parentChain: false,
    transcriptMtime: stat?.mtimeMs ?? 0,
    sessionUpdatedAt: stat?.mtimeMs ?? 0,
    startedAt: 0
  };
}
function candidateAffinity(candidate) {
  if (candidate.active && candidate.cwdMatches) return 4;
  if (candidate.active && candidate.parentChain && candidate.exists) return 3;
  if (candidate.active) return 2;
  if (candidate.cwdMatches) return 1;
  return 0;
}
const TRANSCRIPT_MTIME_DECISIVE_MS = 30_000;
function compareTranscriptCandidates(left, right) {
  // Identity beats recency. A live "parent-chain" candidate is the session
  // that actually forked THIS owner worker (process.ppid walk) — it is the
  // same session that receives injected input. When another co-located
  // session (same cwd) writes its transcript more recently, the mtime rule
  // below would otherwise hand the output-forwarder the wrong session's
  // transcript: input lands in our window while output tails the sibling.
  // Anchoring on the parent-chain session keeps forward output pinned to the
  // owning session and lets it "steal back" the binding from a busier
  // neighbour. Only decisive when exactly one side is the live self session;
  // standalone remote (no parent session) falls through to the heuristics.
  const leftSelf = Boolean(left.active && left.parentChain);
  const rightSelf = Boolean(right.active && right.parentChain);
  if (leftSelf !== rightSelf) return rightSelf ? 1 : -1;
  // A live same-cwd session is a stronger ownership signal than an older
  // transcript's mtime. The previous ordering let a stale-but-recent transcript
  // keep winning after a remote runtime restart, so the output forwarder stayed
  // bound to the old JSONL while inbound was delivered to the live session.
  const affinityDiff = candidateAffinity(right) - candidateAffinity(left);
  if (affinityDiff !== 0 && (left.active || right.active)) return affinityDiff;
  const leftMtime = Number(left.transcriptMtime) || 0;
  const rightMtime = Number(right.transcriptMtime) || 0;
  if (leftMtime > 0 && rightMtime > 0) {
    const mtimeDelta = rightMtime - leftMtime;
    if (mtimeDelta >= TRANSCRIPT_MTIME_DECISIVE_MS) return 1;
    if (-mtimeDelta >= TRANSCRIPT_MTIME_DECISIVE_MS) return -1;
  }
  if (affinityDiff !== 0) return affinityDiff;
  if (Number(right.exists) !== Number(left.exists)) return Number(right.exists) - Number(left.exists);
  if (right.transcriptMtime !== left.transcriptMtime) return right.transcriptMtime - left.transcriptMtime;
  if (right.sessionUpdatedAt !== left.sessionUpdatedAt) return right.sessionUpdatedAt - left.sessionUpdatedAt;
  if (right.startedAt !== left.startedAt) return right.startedAt - left.startedAt;
  return (right.claudePid ?? 0) - (left.claudePid ?? 0);
}
function detectCurrentSessionTranscript(options = {}) {
  const candidates = [];
  const seen = new Set();
  const addCandidate = (candidate) => {
    if (!candidate?.transcriptPath) return;
    const keyPath = resolve(candidate.transcriptPath);
    const key = `${candidate.sessionId || ""}:${process.platform === "win32" ? keyPath.toLowerCase() : keyPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };
  addCandidate(sessionTranscriptCandidate(discoverCurrentClaudeSession(options), "parent-chain"));
  for (const session of listInteractiveClaudeSessions()) {
    addCandidate(sessionTranscriptCandidate(session, "sessions-dir"));
  }
  addCandidate(latestMtimeTranscriptCandidate());
  candidates.sort(compareTranscriptCandidates);
  return candidates[0] ?? null;
}
function discoverSessionBoundTranscript(options = {}) {
  return detectCurrentSessionTranscript(options);
}

export {
  findLatestTranscriptByMtime,
  sameResolvedPath,
  detectCurrentSessionTranscript,
  discoverSessionBoundTranscript
};
