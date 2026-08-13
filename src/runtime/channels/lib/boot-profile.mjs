import { performance } from "perf_hooks";
import { formatUtcTimestamp } from "../../shared/time-format.mjs";

// Boot-timing instrumentation + shared UTC timestamp helper.
// Extracted verbatim from channels/index.mjs (behavior-preserving).
const BOOT_PROFILE_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_BOOT_PROFILE || ""));
const BOOT_PROFILE_START = globalThis.__mixdogBootProfileStart || (globalThis.__mixdogBootProfileStart = performance.now());

function bootProfile(event, fields = {}) {
  if (!BOOT_PROFILE_ENABLED) return;
  const elapsedMs = performance.now() - BOOT_PROFILE_START;
  const parts = [`[mixdog-boot] +${elapsedMs.toFixed(1)}ms`, `channels:${event}`];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key}=${String(value).replace(/\s+/g, "_")}`);
  }
  try { process.stderr.write(`${parts.join(" ")}\n`); } catch {}
}

function utcTimestamp() {
  return formatUtcTimestamp();
}

export { BOOT_PROFILE_ENABLED, BOOT_PROFILE_START, bootProfile, utcTimestamp };
