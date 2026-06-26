import { readdirSync, existsSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import { homedir } from "os";
import {
  cwdToProjectSlug,
  discoverCurrentClaudeSession,
  listInteractiveClaudeSessions
} from "./session-discovery.mjs";

function resolveTranscriptForSession(session) {
  const projectsDir = join(homedir(), ".mixdog", "projects");
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
  const projectsDir = join(homedir(), ".mixdog", "projects");
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
  const leftMtime = Number(left.transcriptMtime) || 0;
  const rightMtime = Number(right.transcriptMtime) || 0;
  if (leftMtime > 0 && rightMtime > 0) {
    const mtimeDelta = rightMtime - leftMtime;
    if (mtimeDelta >= TRANSCRIPT_MTIME_DECISIVE_MS) return 1;
    if (-mtimeDelta >= TRANSCRIPT_MTIME_DECISIVE_MS) return -1;
  }
  const affinityDiff = candidateAffinity(right) - candidateAffinity(left);
  if (affinityDiff !== 0) return affinityDiff;
  if (Number(right.exists) !== Number(left.exists)) return Number(right.exists) - Number(left.exists);
  if (right.transcriptMtime !== left.transcriptMtime) return right.transcriptMtime - left.transcriptMtime;
  if (right.sessionUpdatedAt !== left.sessionUpdatedAt) return right.sessionUpdatedAt - left.sessionUpdatedAt;
  if (right.startedAt !== left.startedAt) return right.startedAt - left.startedAt;
  return (right.claudePid ?? 0) - (left.claudePid ?? 0);
}
function detectCurrentSessionTranscript() {
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
  addCandidate(sessionTranscriptCandidate(discoverCurrentClaudeSession(), "parent-chain"));
  for (const session of listInteractiveClaudeSessions()) {
    addCandidate(sessionTranscriptCandidate(session, "sessions-dir"));
  }
  addCandidate(latestMtimeTranscriptCandidate());
  candidates.sort(compareTranscriptCandidates);
  return candidates[0] ?? null;
}
function discoverSessionBoundTranscript() {
  return detectCurrentSessionTranscript();
}

export {
  resolveTranscriptForSession,
  findLatestTranscriptByMtime,
  isPidAlive,
  sameResolvedPath,
  transcriptStat,
  sessionTranscriptCandidate,
  latestMtimeTranscriptCandidate,
  candidateAffinity,
  compareTranscriptCandidates,
  detectCurrentSessionTranscript,
  discoverSessionBoundTranscript,
  TRANSCRIPT_MTIME_DECISIVE_MS
};
