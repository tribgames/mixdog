/**
 * transcript-writer/transcript-file.mjs — the transcript file itself: the
 * project directory, exclusive empty creation for watchers, and the one-time
 * conversation backfill that seeds an empty file from existing history.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Canonical project-slug mapping for `<mixdogHome>/projects/<slug>` transcript
// dirs (originally shared with the retired channel session-discovery).
export function cwdToProjectSlug(cwd) {
  return resolve(cwd)
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, '$1-')
    .replace(/\//g, '-');
}

// The prose of a message content field: a string, or the string and text
// blocks of a block array (images and other media carry no transcript text).
export function conversationText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function createTranscriptFile({ projectDir, transcriptPath, sessionId, resolvedCwd, logOnce, rotation }) {
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

  // Idempotently create the transcript file as an empty 0-byte file if it
  // does not already exist. Called on every remote turn (before the first
  // append) so watchers can attach to the path right away. Never
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

  // A local Desktop/TUI session may already contain substantial history when
  // its per-session JSONL is created for the first time (resume, upgrade, or a
  // session that predates always-on transcript persistence). Seed an EMPTY
  // transcript once so the memory watcher receives that existing conversation
  // before later turns append incrementally. A non-empty file is authoritative
  // and is never rewritten, which keeps this idempotent across runtime reloads.
  function ensureConversationBackfill(messages) {
    try {
      ensureProjectDir();
      if (existsSync(transcriptPath) && statSync(transcriptPath).size > 0) return false;
      const entries = [];
      for (const message of Array.isArray(messages) ? messages : []) {
        const role = message?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const text = conversationText(message?.content);
        if (!text.trim()) continue;
        const entry = { type: role, sessionId, cwd: resolvedCwd };
        if (message?.timestamp != null) entry.timestamp = message.timestamp;
        else if (message?.ts != null) entry.ts = message.ts;
        entry.message = { content: [{ type: 'text', text }] };
        entries.push(entry);
      }
      if (entries.length === 0) {
        ensureTranscriptFile();
        return false;
      }
      const payload = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
      // The size check and write are synchronous in the owning runtime, so no
      // local append can interleave between them. Cross-runtime ownership is
      // already serialized by the session service.
      writeFileSync(transcriptPath, payload, { flag: 'w', mode: 0o600 });
      rotation.noteRewritten(Buffer.byteLength(payload));
      return true;
    } catch (err) {
      logOnce(err);
      return false;
    }
  }

  return { ensureProjectDir, ensureTranscriptFile, ensureConversationBackfill };
}
