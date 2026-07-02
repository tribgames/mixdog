/**
 * Transcript writer for remote (Discord) mode.
 *
 * The channel worker's OutputForwarder tails a newline-delimited JSON
 * transcript and forwards the "surface" view (assistant text + one-line tool
 * summaries) to Discord. Nothing wrote that file for standalone sessions, so
 * remote outbound never worked. This module writes the JSONL in the exact
 * schema the forwarder parses (see channels/lib/output-forwarder.mjs
 * extractNewText) plus a session record the forwarder's discovery reads
 * (channels/lib/session-discovery.mjs readSessionRecord).
 *
 * All writes are best-effort: a failure must never break the ask() turn. We
 * log the FIRST occurrence of each distinct failure string to stderr (prefix
 * `mixdog: transcript-writer: `) and suppress duplicates so a broken path
 * cannot spam the terminal.
 */
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { appendBuffered, drainPathSync, hasInFlightWrite } from './buffered-appender.mjs';

// Rotate the JSONL transcript once it exceeds this size, keeping one prior
// generation (`<path>.1`). Checked on each append; the check itself is a
// cheap statSync so no extra timer/interval is needed.
const TRANSCRIPT_ROTATE_BYTES = 10 * 1024 * 1024;

// Byte-identical to cwdToProjectSlug() in
// src/runtime/channels/lib/session-discovery.mjs. Inlined to avoid a
// shared -> channels import coupling; keep the two in sync if either changes.
function cwdToProjectSlug(cwd) {
  return resolve(cwd).replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1-').replace(/\//g, '-');
}

export function createTranscriptWriter({ mixdogHome, sessionId, cwd, pid } = {}) {
  if (!mixdogHome) throw new Error('transcript-writer: mixdogHome is required');
  if (!sessionId) throw new Error('transcript-writer: sessionId is required');
  if (!cwd) throw new Error('transcript-writer: cwd is required');

  const resolvedCwd = resolve(cwd);
  const projectDir = join(mixdogHome, 'projects', cwdToProjectSlug(resolvedCwd));
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
  const sessionRecordPath = join(mixdogHome, 'sessions', `${pid ?? process.pid}.json`);
  const startedAt = Date.now();

  // Repeated-failure guard: log the first time each distinct message is seen,
  // then stay quiet so a persistently-broken path does not flood stderr.
  const seenErrors = new Set();
  function logOnce(err) {
    const msg = err && err.message ? err.message : String(err);
    if (seenErrors.has(msg)) return;
    seenErrors.add(msg);
    try { process.stderr.write(`mixdog: transcript-writer: ${msg}\n`); } catch { /* stderr broken */ }
  }

  let projectDirReady = false;
  function ensureProjectDir() {
    if (projectDirReady) return;
    try {
      mkdirSync(projectDir, { recursive: true });
      projectDirReady = true;
    } catch (err) {
      logOnce(err);
    }
  }

  function rotateIfNeeded() {
    try {
      if (!existsSync(transcriptPath)) return;
      const { size } = statSync(transcriptPath);
      if (size < TRANSCRIPT_ROTATE_BYTES) return;
      // An async appendFile may be in flight for this path; renaming out
      // from under it races the write on Windows. Skip this round and
      // retry rotation on the next append instead.
      if (hasInFlightWrite(transcriptPath)) return;
      // Force any still-buffered bytes onto disk before renaming, so the
      // rotated-out file ends with everything queued for it and the fresh
      // file post-rename doesn't inherit stale in-memory chunks.
      drainPathSync(transcriptPath);
      const rotatedPath = `${transcriptPath}.1`;
      try { renameSync(transcriptPath, rotatedPath); } catch (err) { logOnce(err); }
    } catch (err) {
      logOnce(err);
    }
  }

  function appendLine(entry) {
    ensureProjectDir();
    rotateIfNeeded();
    try {
      appendBuffered(transcriptPath, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      logOnce(err);
    }
  }

  function writeSessionRecord() {
    try {
      mkdirSync(dirname(sessionRecordPath), { recursive: true });
      writeFileSync(sessionRecordPath, JSON.stringify({
        sessionId,
        cwd: resolvedCwd,
        transcriptPath,
        startedAt,
        updatedAt: Date.now(),
        kind: 'interactive',
        entrypoint: 'cli',
      }));
    } catch (err) {
      logOnce(err);
    }
  }

  // Refresh only the session record's updatedAt so discovery keeps ranking
  // this session as live across long-lived remote sessions.
  function refresh() {
    writeSessionRecord();
  }

  function appendAssistant(text) {
    const value = typeof text === 'string' ? text : (text == null ? '' : String(text));
    if (!value.trim()) return;
    appendLine({
      type: 'assistant',
      sessionId,
      message: { content: [{ type: 'text', text: value }] },
    });
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
    writeSessionRecord,
    refresh,
    appendAssistant,
    appendToolUse,
    appendToolResult,
  };
}
