import { statSync, renameSync, createWriteStream } from "fs";
import { join } from "path";
import { homedir } from "os";
// ── drop-trace (output-forwarder) ───────────────────────────────────────────
const _dtDataDir = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), ".mixdog-data");
const _dtLog = join(_dtDataDir, "drop-trace.log");
const DROP_TRACE_ENABLED =
  process.env.MIXDOG_DROP_TRACE === "1" ||
  process.env.MIXDOG_DROP_TRACE === "true" ||
  process.env.MIXDOG_DEBUG_CHANNELS === "1" ||
  process.env.MIXDOG_DEBUG_CHANNELS === "true";
// One-shot rotation at module init (10 MB threshold, .1 suffix overwrite).
if (DROP_TRACE_ENABLED) {
  try { if (statSync(_dtLog).size > 10 * 1024 * 1024) renameSync(_dtLog, _dtLog + '.1') } catch {}
}

// ── Buffered drop-trace writer ───────────────────────────────────────────────
// Flushes every 1 s OR when the buffer reaches 64 KB — whichever fires first.
// Drains synchronously on process exit so no log lines are lost.
let _dtBuf = "";
let _dtBufBytes = 0;
let _dtFlushTimer = null;
let _dtStream = null;
function _dtGetStream() {
  if (!_dtStream) _dtStream = createWriteStream(_dtLog, { flags: "a" });
  return _dtStream;
}
function _dtFlush() {
  if (_dtFlushTimer) { clearTimeout(_dtFlushTimer); _dtFlushTimer = null; }
  if (!_dtBuf) return;
  try { _dtGetStream().write(_dtBuf); } catch {}
  _dtBuf = "";
  _dtBufBytes = 0;
}
function _dtScheduleFlush() {
  if (_dtFlushTimer) return;
  _dtFlushTimer = setTimeout(_dtFlush, 1000);
  if (_dtFlushTimer.unref) _dtFlushTimer.unref();
}
function _dtAppend(line) {
  _dtBuf += line;
  _dtBufBytes += Buffer.byteLength(line);
  if (_dtBufBytes >= 65536) { _dtFlush(); return; }
  _dtScheduleFlush();
}
process.on("exit", _dtFlush);
// Note: do not install a module-level SIGTERM handler that calls
// process.exit() here. The channels worker owns shutdown sequencing
// (forwarder drain, queue persist, etc.) and a library-level exit(0)
// preempts that drain. The `exit` listener above still synchronously
// flushes buffered trace bytes when the worker exits on its own terms.

function _dtPreview(text) {
  if (!text) return "";
  const s = String(text).slice(0, 121).replace(/\n/g, "\\n");
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}
function dropTrace(event, fields) {
  if (!DROP_TRACE_ENABLED) return;
  try {
    const ts = new Date().toISOString();
    if (!fields) {
      _dtAppend(`[${ts}][pid=${process.pid}] ${event}\n`);
      return;
    }
    const kv = " " + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ");
    _dtAppend(`[${ts}][pid=${process.pid}] ${event}${kv}\n`);
  } catch {}
}

export { dropTrace, _dtPreview, DROP_TRACE_ENABLED };
