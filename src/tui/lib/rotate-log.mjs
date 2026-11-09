import fs from 'node:fs';

/** Keeps the tail of `filePath` when it grew past `maxBytes`; a missing file is fine. */
export function rotateBoundedLog(filePath, maxBytes, keepBytes) {
  try {
    const st = fs.statSync(filePath);
    if (st.size > maxBytes) {
      const buf = fs.readFileSync(filePath);
      fs.writeFileSync(filePath, buf.subarray(Math.max(0, buf.length - keepBytes)));
    }
  } catch {
    /* missing file ok */
  }
}

// Bound shared by the per-writer logs (10 MB cap, a 2 MB tail survives a rotation).
export const PLUGIN_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const PLUGIN_LOG_KEEP_BYTES = 2 * 1024 * 1024;
