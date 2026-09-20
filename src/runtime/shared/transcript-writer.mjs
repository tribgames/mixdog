/**
 * Session transcript writer (JSONL).
 *
 * Writes the newline-delimited JSON transcript consumed by the memory
 * transcript watcher and session tooling. (The channel forwarder that
 * originally tailed this file is retired; the JSONL schema and the
 * `<mixdogHome>/sessions/<pid>.json` session record it established are
 * kept as-is for those remaining consumers.)
 *
 * All writes are best-effort: a failure must never break the ask() turn. We
 * log the FIRST occurrence of each distinct failure string to stderr (prefix
 * `mixdog: transcript-writer: `) and suppress duplicates so a broken path
 * cannot spam the terminal.
 *
 * transcript-writer/: rotation (size-based generations), transcript-file
 * (directory, exclusive create, conversation backfill), session-record.
 */
import { join, resolve } from 'node:path';
import { appendBuffered } from './buffered-appender.mjs';
import { formatUtcTimestamp } from './time-format.mjs';
import { createRotationTracker } from './transcript-writer/rotation.mjs';
import { createTranscriptFile, cwdToProjectSlug } from './transcript-writer/transcript-file.mjs';
import { createFailureLog, createSessionRecord } from './transcript-writer/session-record.mjs';

const textOrEmpty = (text) => {
  if (typeof text === 'string') return text;
  return text == null ? '' : String(text);
};

export function createTranscriptWriter({ mixdogHome, sessionId, cwd, pid } = {}) {
  if (!mixdogHome) throw new Error('transcript-writer: mixdogHome is required');
  if (!sessionId) throw new Error('transcript-writer: sessionId is required');
  if (!cwd) throw new Error('transcript-writer: cwd is required');

  const resolvedCwd = resolve(cwd);
  const projectDir = join(mixdogHome, 'projects', cwdToProjectSlug(resolvedCwd));
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
  const sessionRecordPath = join(mixdogHome, 'sessions', `${pid ?? process.pid}.json`);

  const logOnce = createFailureLog();
  const rotation = createRotationTracker({ transcriptPath, logOnce });
  const file = createTranscriptFile({ projectDir, transcriptPath, sessionId, resolvedCwd, logOnce, rotation });
  const record = createSessionRecord({ sessionRecordPath, sessionId, resolvedCwd, transcriptPath, logOnce });

  function appendLine(entry) {
    file.ensureProjectDir();
    rotation.rotateIfNeeded();
    try {
      // Every row carries the session cwd: the memory watcher and backfill
      // read it from the first rows to scope entries to a project.
      const stampedEntry =
        entry?.timestamp != null || entry?.ts != null
          ? { ...entry, cwd: resolvedCwd }
          : { ...entry, cwd: resolvedCwd, timestamp: formatUtcTimestamp() };
      const line = `${JSON.stringify(stampedEntry)}\n`;
      appendBuffered(transcriptPath, line);
      rotation.noteAppended(Buffer.byteLength(line));
    } catch (err) {
      logOnce(err);
    }
  }

  function appendText(type, text) {
    const value = textOrEmpty(text);
    if (!value.trim()) return;
    appendLine({ type, sessionId, message: { content: [{ type: 'text', text: value }] } });
  }

  function appendToolUse(name, input) {
    if (!name) return;
    appendLine({
      type: 'assistant',
      sessionId,
      message: { content: [{ type: 'tool_use', name, input: input || {} }] },
    });
  }

  function appendToolResult(toolUseResult) {
    if (!toolUseResult) return;
    appendLine({
      type: 'user',
      sessionId,
      message: { content: [{ type: 'tool_result' }] },
      toolUseResult,
    });
  }

  return {
    transcriptPath,
    sessionRecordPath,
    writeSessionRecord: record.write,
    ensureConversationBackfill: file.ensureConversationBackfill,
    ensureTranscriptFile: file.ensureTranscriptFile,
    // Refresh only the session record's updatedAt so discovery keeps ranking
    // this session as live across long-lived remote sessions.
    refresh: record.write,
    appendAssistant: (text) => appendText('assistant', text),
    // User prompt row. It exists so the memory transcript watcher ingests BOTH
    // sides of the conversation (user rows were previously never written,
    // leaving recall unable to reconstruct recent sessions).
    appendUser: (text) => appendText('user', text),
    appendToolUse,
    appendToolResult,
  };
}
