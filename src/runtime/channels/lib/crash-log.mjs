import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "./config.mjs";
import { localTimestamp } from "./boot-profile.mjs";

// Crash logging + degraded-state tracking for the channels worker.
// Extracted verbatim from channels/index.mjs (behavior-preserving).
//
// Degraded/stderr-broken state is module-scoped here; index.mjs reads it via
// isChannelsDegraded() and installs the process-level unhandledRejection/
// uncaughtException handlers (which need the worker's stop()).
let crashLogging = false;
let _channelsDegraded = false;
let _stderrBroken = false;
function isChannelsDegraded() { return _channelsDegraded; }

// stderr can break when the parent stdio pipe closes. Node then emits an
// async 'error' on process.stderr, which sync try/catch around write() does
// not catch — without a listener, that error becomes uncaughtException and
// re-enters logCrash, looping until the disk fills. Register a suppressor
// once at load time and stop writing to stderr after the first EPIPE so the
// loop cannot start.
try {
  process.stderr.on('error', (e) => {
    if (e && (e.code === 'EPIPE' || /EPIPE/.test(String(e.message || '')))) {
      // Parent stdio pipe loss stops stderr writes only. It is NOT runtime
      // corruption, so it must not degrade tool dispatch (_channelsDegraded).
      _stderrBroken = true;
    }
  });
} catch {}

// Crash log guards: dedup repeated identical errors (a single broken handler
// can fire thousands of times per minute) and rotate at a 10 MB cap so the
// file cannot grow unbounded. One .old generation is kept; older rolls drop.
const CRASH_LOG_MAX_BYTES = 10 * 1024 * 1024;
let _lastCrashSig = "";
let _crashRepeatCount = 0;

function _writeCrashLine(crashLog, line) {
  try {
    let size = 0;
    try { size = fs.statSync(crashLog).size; } catch {}
    if (size + line.length > CRASH_LOG_MAX_BYTES) {
      try { fs.renameSync(crashLog, crashLog + ".old"); } catch {}
    }
    fs.appendFileSync(crashLog, line);
  } catch {}
}

function logCrash(label, err) {
  if (crashLogging) return;
  crashLogging = true;
  const msg = `[${localTimestamp()}] mixdog: ${label}: ${err}
${err instanceof Error ? err.stack : ""}
`;
  if (!_stderrBroken) {
    try { process.stderr.write(msg); } catch (e) {
      if (e && (e.code === 'EPIPE' || /EPIPE/.test(String(e.message || '')))) {
        _stderrBroken = true;
      }
    }
  }
  const sig = `${label}|${err && err.message ? err.message : String(err)}`;
  const crashLog = path.join(DATA_DIR, "crash.log");
  if (sig === _lastCrashSig) {
    // Same error repeating — count it but skip the disk write. The next
    // distinct error (or EPIPE branch below) flushes the suppressed total.
    _crashRepeatCount += 1;
  } else {
    if (_crashRepeatCount > 0) {
      _writeCrashLine(crashLog, `[${localTimestamp()}] mixdog: previous error repeated ${_crashRepeatCount} more time(s)\n`);
      _crashRepeatCount = 0;
    }
    _lastCrashSig = sig;
    _writeCrashLine(crashLog, msg);
  }
  if (err instanceof Error && err.message.includes("EPIPE")) {
    // EPIPE = a broken pipe (parent stdio/IPC gone), not corrupted runtime
    // state. Stop writing to the dead pipe but keep serving tool calls.
    _stderrBroken = true;
  }
  crashLogging = false;
}

// Benign whitelist: transient EPERM/EACCES/EBUSY on the active-instance
// rename path is expected under Windows file-lock contention and is
// already retried elsewhere (atomic-file.mjs RETRY_CODES) — a single
// occurrence must NOT be fatal, only a run of 3+ in a row without an
// intervening distinct/successful event.
const BENIGN_CRASH_CODES = new Set([
  "EPERM", "EACCES", "EBUSY",
  // Transient transport blips: a raw http/https ClientRequest (or an
  // undici socket) can emit these when a keep-alive connection is torn
  // down mid-flight (Discord gateway flapping, proxy resets). One blip
  // must NOT kill the worker — it is benign; only a repeat storm within
  // the streak window force-exits (see _fatalCrash).
  "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EHOSTUNREACH",
  "ENETUNREACH", "ENETDOWN", "EAI_AGAIN", "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_ABORTED",
]);
// Some transient socket errors arrive with no `.code` (notably the classic
// "socket hang up" thrown by node:_http_client socketOnEnd — the exact crash
// this guard exists for). Match those by message so they classify benign too.
const BENIGN_CRASH_MESSAGE_RE = /socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_/i;
const BENIGN_CRASH_FATAL_THRESHOLD = 3;
// "In a row" needs a time dimension: benign errors minutes/hours apart are
// independent contention events, not a corrupted-state run. Only count a
// streak when hits land within this window of the previous one.
const BENIGN_CRASH_STREAK_WINDOW_MS = 60_000;
function _isBenignCrash(err) {
  const msg = String(err?.message || err);
  const code = err?.code
    || (/\b(EPERM|EACCES|EBUSY|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EAI_AGAIN|UND_ERR_[A-Z_]+)\b/.exec(msg) || [])[0];
  if (BENIGN_CRASH_CODES.has(code)) return true;
  return BENIGN_CRASH_MESSAGE_RE.test(msg);
}

export {
  isChannelsDegraded,
  logCrash,
  _isBenignCrash,
  BENIGN_CRASH_FATAL_THRESHOLD,
  BENIGN_CRASH_STREAK_WINDOW_MS,
};
