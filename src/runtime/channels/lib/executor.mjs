import { spawn } from "child_process";
import { existsSync, mkdirSync, appendFileSync, appendFile as _appendFileAsync } from "fs";
import { join, normalize, extname, sep } from "path";
import { tmpdir } from "os";
import { DATA_DIR } from "./config.mjs";
const SCRIPTS_DIR = join(DATA_DIR, "scripts");
const NOPLUGIN_DIR = join(tmpdir(), "mixdog-noplugin");
const EVENT_LOG = join(DATA_DIR, "event.log");
// Buffered async logger — coalesces per-line appends into batched writes.
let _eventLogBuf = [];
let _eventLogTimer = null;
function _flushEventLog() {
  _eventLogTimer = null;
  if (_eventLogBuf.length === 0) return;
  const lines = _eventLogBuf.join("");
  _eventLogBuf = [];
  _appendFileAsync(EVENT_LOG, lines, () => {});
}
function _flushEventLogSync() {
  if (_eventLogBuf.length === 0) return;
  const lines = _eventLogBuf.join("");
  _eventLogBuf = [];
  try { appendFileSync(EVENT_LOG, lines); } catch {}
}
process.on('exit', _flushEventLogSync);
function logEvent(msg) {
  try { process.stderr.write(`mixdog event: ${msg}\n`); } catch {}
  _eventLogBuf.push(`[${new Date().toISOString()}] ${msg}\n`);
  if (!_eventLogTimer) _eventLogTimer = setTimeout(_flushEventLog, 2000);
}
function parseGithub(body, headers) {
  const event = headers["x-github-event"] || "";
  const action = body.action || "";
  const pr = body.pull_request || body.issue || {};
  return {
    event,
    action,
    title: pr.title || body.head_commit?.message || "",
    author: pr.user?.login || body.sender?.login || "",
    repo: body.repository?.full_name || "",
    url: pr.html_url || body.compare || "",
    branch: body.ref || pr.head?.ref || "",
    message: body.head_commit?.message || ""
  };
}
function parseSentry(body) {
  const data = body.data || {};
  const evt = data.event || data.issue || {};
  return {
    title: evt.title || body.message || "",
    level: evt.level || body.level || "",
    project: body.project_name || body.project || "",
    url: evt.web_url || body.url || ""
  };
}
function parseGeneric(body) {
  const result = {};
  const keys = Object.keys(body).slice(0, 5);
  for (const k of keys) {
    result[k] = typeof body[k] === "string" ? body[k] : JSON.stringify(body[k]);
  }
  return result;
}
function applyParser(parser, body, headers) {
  switch (parser) {
    case "github":
      return parseGithub(body, headers);
    case "sentry":
      return parseSentry(body);
    case "generic":
      return parseGeneric(body);
    default:
      return { raw: JSON.stringify(body) };
  }
}
function evaluateFilter(expr, data) {
  const orParts = expr.split("||").map((s) => s.trim());
  for (const orPart of orParts) {
    const andParts = orPart.split("&&").map((s) => s.trim());
    let andResult = true;
    for (const condition of andParts) {
      const match = condition.match(/^(\w+)\s*==\s*['"](.*)['"]$/);
      if (!match) {
        const neqMatch = condition.match(/^(\w+)\s*!=\s*['"](.*)['"]$/);
        if (neqMatch) {
          const [, field2, value2] = neqMatch;
          if ((data[field2] ?? "") === value2) {
            andResult = false;
            break;
          }
        } else {
          andResult = false;
          break;
        }
        continue;
      }
      const [, field, value] = match;
      if ((data[field] ?? "") !== value) {
        andResult = false;
        break;
      }
    }
    if (andResult) return true;
  }
  return false;
}
function applyTemplate(template, data) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] ?? "");
}
function ensureNopluginDir() {
  mkdirSync(NOPLUGIN_DIR, { recursive: true });
}
function runScript(name, scriptName, onResult) {
  if (!existsSync(SCRIPTS_DIR)) {
    mkdirSync(SCRIPTS_DIR, { recursive: true });
  }
  const scriptPath = normalize(join(SCRIPTS_DIR, scriptName));
  // Boundary-correct containment: startsWith(SCRIPTS_DIR) by itself accepts
  // sibling roots like `<SCRIPTS_DIR>2/...`. Require either an exact match
  // OR the path-separator-prefixed form.
  const SCRIPTS_PREFIX = SCRIPTS_DIR.endsWith(sep) ? SCRIPTS_DIR : SCRIPTS_DIR + sep;
  if (scriptPath !== SCRIPTS_DIR && !scriptPath.startsWith(SCRIPTS_PREFIX)) {
    logEvent(`${name}: script path escapes directory: ${scriptName}`);
    onResult("", null);
    return;
  }
  if (!existsSync(scriptPath)) {
    logEvent(`${name}: script not found: ${scriptPath}`);
    onResult("", null);
    return;
  }
  const ext = extname(scriptName).toLowerCase();
  // Pick interpreter candidates. `python3` does not exist on a default
  // Windows install — the Python launcher `py` (and often `python`) does —
  // so on win32 try py → python → python3, falling through on ENOENT.
  // POSIX keeps python3 → python.
  let candidates;
  if (ext === ".py") {
    candidates = process.platform === "win32"
      ? ["py", "python", "python3"]
      : ["python3", "python"];
  } else {
    candidates = ["node"];
  }
  // onResult MUST fire exactly once across the whole candidate chain. A failed
  // ENOENT spawn emits BOTH 'error' (→ we advance) AND 'close', so guard the
  // final callback at the chain level and mark each attempt that advanced so
  // its own 'close' is ignored.
  let resultSent = false;
  const finish = (out, code) => {
    if (resultSent) return;
    resultSent = true;
    onResult(out, code);
  };
  const trySpawn = (idx) => {
    const cmd = candidates[idx];
    let advanced = false;
    const proc = spawn(cmd, [scriptPath], {
      timeout: 3e4,
      env: { ...process.env },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    if (proc.stdout) proc.stdout.on("data", (d) => {
      stdout += d;
    });
    if (proc.stderr) proc.stderr.on("data", (d) => {
      stderr += d;
    });
    proc.on("close", (code) => {
      // This attempt ENOENT'd and handed off to the next candidate — its
      // 'close' is spurious and must not report a result.
      if (advanced) return;
      if (code !== 0) {
        logEvent(`${name}: script exited ${code}: ${stderr.substring(0, 500)}`);
      }
      finish(stdout.substring(0, 2e3), code);
    });
    proc.on("error", (err) => {
      // Interpreter not found → try the next candidate before giving up.
      if (err.code === "ENOENT" && idx + 1 < candidates.length) {
        advanced = true;
        trySpawn(idx + 1);
        return;
      }
      logEvent(`${name}: script spawn error: ${err.message}`);
      finish("", null);
    });
  };
  trySpawn(0);
}
export {
  applyParser,
  applyTemplate,
  ensureNopluginDir,
  evaluateFilter,
  logEvent,
  parseGeneric,
  parseGithub,
  parseSentry,
  runScript
};
