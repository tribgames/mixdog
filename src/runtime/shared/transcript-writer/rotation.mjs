/**
 * transcript-writer/rotation.mjs — size-based rotation of the JSONL transcript
 * (one prior generation, `<path>.1`) with a local byte counter so the sync
 * stat runs once per ~64KB of growth instead of on every appended line.
 */
import { existsSync, renameSync, statSync } from 'node:fs';
import { drainPathSync, hasInFlightWrite } from '../buffered-appender.mjs';

// Rotate the JSONL transcript once it exceeds this size, keeping one prior
// generation (`<path>.1`). Checked on each append; the check itself is a
// cheap statSync so no extra timer/interval is needed.
const TRANSCRIPT_ROTATE_BYTES = 10 * 1024 * 1024;

// After this many appended bytes since the last rotation stat, re-check
// disk size via statSync. Bounds the sync-fs cost per append to roughly
// once every ~64KB of transcript growth instead of on every single line,
// while still catching rotation promptly (a JSONL line is typically well
// under 1KB, so this is on the order of dozens of appends between stats).
const ROTATE_CHECK_BYTE_STRIDE = 64 * 1024;

export function createRotationTracker({ transcriptPath, logOnce }) {
  // Growth since the last real statSync, so rotateIfNeeded's fs work is O(1)
  // per append instead of an existsSync+statSync pair on every single JSONL
  // line (this fires on every assistant chunk / tool call, i.e. per
  // token-stream event, not per turn). We only hit disk again once the
  // locally-tracked size estimate could plausibly have crossed the rotate
  // threshold, or a full check hasn't happened yet.
  const state = { sizeChecked: false, lastKnownSize: 0, bytesSinceCheck: 0 };

  function statAndMaybeRotate() {
    try {
      if (!existsSync(transcriptPath)) {
        state.sizeChecked = true;
        state.lastKnownSize = 0;
        state.bytesSinceCheck = 0;
        return;
      }
      const { size } = statSync(transcriptPath);
      state.sizeChecked = true;
      state.lastKnownSize = size;
      state.bytesSinceCheck = 0;
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
        state.lastKnownSize = 0;
      } catch (err) {
        logOnce(err);
      }
    } catch (err) {
      logOnce(err);
    }
  }

  function rotateIfNeeded() {
    // Real stat only when: no check has happened yet, the locally-tracked
    // growth alone could have crossed the rotate threshold, or the last
    // known size plus tracked growth is already at/over the threshold
    // (catches a file that was already large when this process attached).
    if (
      !state.sizeChecked ||
      state.bytesSinceCheck >= ROTATE_CHECK_BYTE_STRIDE ||
      state.lastKnownSize + state.bytesSinceCheck >= TRANSCRIPT_ROTATE_BYTES
    ) {
      statAndMaybeRotate();
    }
  }

  /** A line of `bytes` was queued for append. */
  function noteAppended(bytes) {
    state.bytesSinceCheck += bytes;
  }

  /** The file was rewritten whole and is now exactly `size` bytes. */
  function noteRewritten(size) {
    state.sizeChecked = true;
    state.lastKnownSize = size;
    state.bytesSinceCheck = 0;
  }

  return { rotateIfNeeded, noteAppended, noteRewritten };
}
