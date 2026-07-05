import * as http from "http";
import { join } from "path";
import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { DATA_DIR } from "../config.mjs";
import { logWebhook } from "./log.mjs";

function _readNgrokBinFromRegistry() {
  if (process.platform !== "win32") return null;
  try {
    const r = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "NGROK_BIN"], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status === 0 && r.stdout) {
      const m = r.stdout.match(/NGROK_BIN\s+REG_(?:EXPAND_)?SZ\s+(.+?)\r?\n/);
      if (m && m[1]) return m[1].trim();
    }
  } catch { /* missing reg.exe is non-fatal */ }
  return null;
}
function resolveNgrokBin() {
  // Invariant on Windows: BOTH process.env.NGROK_BIN AND HKCU\Environment\NGROK_BIN
  // are candidate sources. process.env is the shell-start snapshot; registry
  // is the live user definition. Each candidate is tried in order and the
  // first that resolves to an existing file wins. This recovers two distinct
  // post-setx cases without a host-agent restart:
  //   (a) env unset, registry set    — fresh install + setx after process start
  //   (b) env set to stale old path, registry set to new — user moved or
  //       re-installed ngrok and setx'd the new path; the old env value would
  //       otherwise dead-end at existsSync=false.
  // POSIX has no registry; process.env is the sole candidate.
  const candidates = [];
  if (process.env.NGROK_BIN) candidates.push(process.env.NGROK_BIN);
  const fromReg = _readNgrokBinFromRegistry();
  if (fromReg && !candidates.includes(fromReg)) candidates.push(fromReg);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  if (candidates.length > 0) {
    throw new Error(`NGROK_BIN candidates (${candidates.join(", ")}) do not exist on disk. Set NGROK_BIN to the correct ngrok binary path.`);
  }
  throw new Error('NGROK_BIN env var is not set. Set NGROK_BIN to the path of the ngrok binary (e.g. NGROK_BIN=/usr/local/bin/ngrok).');
}
const NGROK_META_FILE = join(DATA_DIR, "ngrok-meta.json");
const NGROK_OLD_PID_FILE = join(DATA_DIR, "ngrok.pid");
const NGROK_MAX_AGE_MS = 24 * 60 * 60 * 1e3; // 24 hours

function normalizeDomain(d) {
  if (!d) return '';
  const url = new URL(d.includes('://') ? d : 'https://' + d);
  if (!url.hostname) throw new Error(`[webhook] invalid host: ${d}`);
  return url.hostname.toLowerCase();
}

function readNgrokMeta() {
  try { return JSON.parse(readFileSync(NGROK_META_FILE, 'utf8')) } catch {}
  // Migration: read old pid file if meta doesn't exist
  try {
    const pid = parseInt(readFileSync(NGROK_OLD_PID_FILE, 'utf8').trim());
    if (pid > 0) {
      logWebhook(`migrating ngrok.pid (PID ${pid}) to ngrok-meta.json`);
      const meta = { pid, domain: '', port: 0, startedAt: new Date().toISOString() };
      writeNgrokMeta(meta);
      try { unlinkSync(NGROK_OLD_PID_FILE) } catch {}
      return meta;
    }
  } catch {}
  return null;
}
function writeNgrokMeta(meta) {
  try { writeFileSync(NGROK_META_FILE, JSON.stringify(meta, null, 2)) } catch {}
}
function clearNgrokMeta() {
  try { unlinkSync(NGROK_META_FILE) } catch {}
}
// Recycled-PID guard: a stale ngrok-meta.json may name a PID that ngrok
// long ago freed and the OS reassigned to an unrelated process (commonly
// another mixdog server). Verify the PID is actually an ngrok process
// before sending a kill signal, so a live peer's server is never taken
// down. Returns false (skip kill) when the check is inconclusive.
function isLikelyNgrok(pid) {
  if (!pid || pid <= 0) return false;
  try {
    if (process.platform === "win32") {
      const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 5000, windowsHide: true });
      return /ngrok/i.test(r.stdout || "");
    }
    const r = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 5000, windowsHide: true });
    return /ngrok/i.test(r.stdout || "");
  } catch { return false; }
}

function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Strict PID extraction: the first non-empty output line must be decimal-only.
// `123junk` / any non-numeric noise → null, so a malformed shell result can
// never be coerced into a real PID we might later signal or kill.
function parseStrictPidLine(out) {
  const line = String(out || "").split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
  if (!line || !/^\d+$/.test(line)) return null;
  const n = parseInt(line, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function resolvePortOwnerPid(port) {
  // Coerce + range-validate the port BEFORE any spawn so it can never inject
  // into a command, and use spawnSync argv (no shell) for defense in depth.
  // Invalid port → null (treated as "no owner", never an exec).
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  try {
    if (process.platform === "win32") {
      const r = spawnSync(
        "powershell",
        ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`],
        { encoding: "utf8", timeout: 3000, windowsHide: true },
      );
      return r.status === 0 ? parseStrictPidLine(r.stdout) : null;
    }
    const r = spawnSync("lsof", ["-ti", `:${p}`, "-sTCP:LISTEN"], { encoding: "utf8", timeout: 3000, windowsHide: true });
    return r.status === 0 ? parseStrictPidLine(r.stdout) : null;
  } catch {
    return null;
  }
}

async function handleWebhookPortInUse(basePort, expectedDomain) {
  const ownerPid = resolvePortOwnerPid(basePort);
  const ownerAlive = ownerPid != null && isProcessAlive(ownerPid);
  const ownerIsNgrok = ownerAlive && isLikelyNgrok(ownerPid);
  logWebhook(
    `port ${basePort} EADDRINUSE — not reclaiming external PID ${ownerPid ?? "unknown"} (alive=${ownerAlive}, ngrok=${ownerIsNgrok}); trying next port`,
  );
  return { ok: false, bump: true, ownerPid };
}

function checkNgrokHealth(expectedDomain, expectedPort = null) {
  try {
    return new Promise((resolve) => {
      const req = http.get("http://localhost:4040/api/tunnels", { timeout: 2000 }, (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            const tunnels = JSON.parse(data).tunnels || [];
            const expected = normalizeDomain(expectedDomain);
            const match = tunnels.some(t => {
              if (normalizeDomain(t.public_url) !== expected) return false;
              if (!expectedPort) return true;
              const addr = String(t.config?.addr || '');
              return addr === `http://localhost:${expectedPort}`
                || addr === `https://localhost:${expectedPort}`
                || addr.endsWith(`:${expectedPort}`);
            });
            resolve(match);
          } catch { resolve(false); }
        });
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
    });
  } catch { return Promise.resolve(false); }
}

export {
  NGROK_MAX_AGE_MS,
  resolveNgrokBin,
  normalizeDomain,
  readNgrokMeta,
  writeNgrokMeta,
  clearNgrokMeta,
  isLikelyNgrok,
  isProcessAlive,
  parseStrictPidLine,
  resolvePortOwnerPid,
  handleWebhookPortInUse,
  checkNgrokHealth,
};
