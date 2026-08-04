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

// After this many appended bytes since the last rotation stat, re-check
// disk size via statSync. Bounds the sync-fs cost per append to roughly
// once every ~64KB of transcript growth instead of on every single line,
// while still catching rotation promptly (a JSONL line is typically well
// under 1KB, so this is on the order of dozens of appends between stats).
const ROTATE_CHECK_BYTE_STRIDE = 64 * 1024;
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

  // Local byte counter tracking growth since the last real statSync, so
  // rotateIfNeeded's fs work is O(1) per append instead of an existsSync+
  // statSync pair on every single JSONL line (this fires on every assistant
  // chunk / tool call, i.e. per token-stream event, not per turn). We only
  // hit disk again once the locally-tracked size estimate could plausibly
  // have crossed the rotate threshold, or a full check hasn't happened yet.
  let sizeChecked = false;
  let lastKnownSize = 0;
  let bytesSinceCheck = 0;

  function statAndMaybeRotate() {
    try {
      if (!existsSync(transcriptPath)) {
        sizeChecked = true;
        lastKnownSize = 0;
        bytesSinceCheck = 0;
        return;
      }
      const { size } = statSync(transcriptPath);
      sizeChecked = true;
      lastKnownSize = size;
      bytesSinceCheck = 0;
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
      try {
        renameSync(transcriptPath, rotatedPath);
        lastKnownSize = 0;
      } catch (err) { logOnce(err); }
    } catch (err) {
      logOnce(err);
    }
  }

  function rotateIfNeeded() {
    // Real stat only when: no check has happened yet, the locally-tracked
    // growth alone could have crossed the rotate threshold, or the last
    // known size plus tracked growth is already at/over the threshold
    // (catches a file that was already large when this process attached).
    if (!sizeChecked
      || bytesSinceCheck >= ROTATE_CHECK_BYTE_STRIDE
      || lastKnownSize + bytesSinceCheck >= TRANSCRIPT_ROTATE_BYTES) {
      statAndMaybeRotate();
    }
  }

  function appendLine(entry) {
    ensureProjectDir();
    rotateIfNeeded();
    try {
      const line = `${JSON.stringify(entry)}\n`;
      appendBuffered(transcriptPath, line);
      bytesSinceCheck += Buffer.byteLength(line);
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

  // User prompt row. The channel forwarder ignores plain user text rows
  // (output-forwarder extractNewText only surfaces assistant rows and
  // user rows carrying tool_result), so this never echoes back to the
  // channel — it exists so the memory transcript watcher ingests BOTH
  // sides of the conversation (user rows were previously never written,
  // leaving recall unable to reconstruct recent sessions).
  function appendUser(text) {
    const value = typeof text === 'string' ? text : (text == null ? '' : String(text));
    if (!value.trim()) return;
    appendLine({
      type: 'user',
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

  // Idempotently create the transcript file as an empty 0-byte file if it
  // does not already exist. Called on every remote turn (before the first
  // append) so the channel worker's fs.watch can attach to the path right
  // away instead of waiting on schedulePendingTranscriptRearm(). Never
  // truncates an existing transcript: guarded by existsSync + the 'wx'
  // (exclusive-create) flag, and any EEXIST/other error is swallowed via
  // logOnce like the other writers.
  function ensureTranscriptFile() {
    try {
      ensureProjectDir();
      if (existsSync(transcriptPath)) return;
      try {
        // mode 0o600 restricts the remote transcript to the owning user;
        // best-effort on Windows, where fs mode bits are largely ignored.
        writeFileSync(transcriptPath, '', { flag: 'wx', mode: 0o600 });
      } catch (err) {
        if (err && err.code === 'EEXIST') return;
        logOnce(err);
      }
    } catch (err) {
      logOnce(err);
    }
  }

  return {
    transcriptPath,
    sessionRecordPath,
    writeSessionRecord,
    ensureTranscriptFile,
    refresh,
    appendAssistant,
    appendUser,
    appendToolUse,
    appendToolResult,
  };
}
