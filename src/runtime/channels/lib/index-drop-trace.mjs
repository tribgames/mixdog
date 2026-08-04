import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "./config.mjs";

// Drop-trace instrumentation for channels/index.mjs.
// Extracted verbatim (behavior-preserving). Distinct from lib/drop-trace.mjs
// (which the output-forwarder uses): this instance is owned by index.mjs and
// keeps its own buffered writer + `preview` helper so the two trace streams
// stay byte-identical to the pre-split behavior.
const _dropTraceLog = path.join(DATA_DIR, "drop-trace.log");
const DROP_TRACE_ENABLED =
  process.env.MIXDOG_DROP_TRACE === "1" ||
  process.env.MIXDOG_DROP_TRACE === "true" ||
  process.env.MIXDOG_DEBUG_CHANNELS === "1" ||
  process.env.MIXDOG_DEBUG_CHANNELS === "true";
// One-shot rotation for drop-trace.log at worker boot.
if (DROP_TRACE_ENABLED) {
  try { if (fs.statSync(_dropTraceLog).size > 10 * 1024 * 1024) fs.renameSync(_dropTraceLog, _dropTraceLog + '.1') } catch {}
}

// ── Buffered drop-trace writer (channels/index) ──────────────────────────────
// Flushes every 1 s OR when buffer reaches 64 KB — whichever fires first.
// Drains on process exit so no log lines are lost.
let _dtIdxBuf = "";
let _dtIdxBytes = 0;
let _dtIdxFlushTimer = null;
let _dtIdxStream = null;
function _dtIdxGetStream() {
  if (!_dtIdxStream) _dtIdxStream = fs.createWriteStream(_dropTraceLog, { flags: "a" });
  return _dtIdxStream;
}
async function _dtIdxFlush() {
  if (_dtIdxFlushTimer) { clearTimeout(_dtIdxFlushTimer); _dtIdxFlushTimer = null; }
  if (!_dtIdxBuf) return;
  const stream = _dtIdxGetStream();
  const buf = _dtIdxBuf;
  _dtIdxBuf = "";
  _dtIdxBytes = 0;
  try {
    const ok = stream.write(buf);
    if (!ok) { const { once } = await import("node:events"); await once(stream, "drain").catch(() => {}); }
  } catch {}
}
function _dtIdxScheduleFlush() {
  if (_dtIdxFlushTimer) return;
  _dtIdxFlushTimer = setTimeout(() => { void _dtIdxFlush(); }, 1000);
  if (_dtIdxFlushTimer.unref) _dtIdxFlushTimer.unref();
}
function _dtIdxAppend(line) {
  _dtIdxBuf += line;
  _dtIdxBytes += Buffer.byteLength(line);
  if (_dtIdxBytes >= 65536) { void _dtIdxFlush(); return; }
  _dtIdxScheduleFlush();
}
process.on("exit", () => { void _dtIdxFlush(); });

function preview(text) {
  if (!text) return "";
  const s = String(text).replace(/\n/g, "\\n");
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}
function dropTrace(event, fields) {
  if (!DROP_TRACE_ENABLED) return;
  try {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const loc = `[${ts}][pid=${process.pid}] ${event}`;
    const kv = fields ? " " + Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ") : "";
    _dtIdxAppend(loc + kv + "\n");
  } catch {}
}

export { DROP_TRACE_ENABLED, dropTrace, preview, _dtIdxFlush };
