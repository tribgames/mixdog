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
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

  function appendLine(entry) {
    ensureProjectDir();
    try {
      appendFileSync(transcriptPath, `${JSON.stringify(entry)}\n`);
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
