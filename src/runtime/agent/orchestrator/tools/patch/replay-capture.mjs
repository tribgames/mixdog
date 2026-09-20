// Patch replay capture: every apply_patch failure is frozen (args + target
// file snapshots) for `npm run patch:replay`. Best-effort throughout — a
// capture problem never changes the tool result.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve as pathResolve, isAbsolute, join as pathJoin } from 'node:path';
import { getPluginData } from '../../config.mjs';
import { isResolvedPathOutsideBase } from './paths.mjs';

function patchReplayDir() {
  const base = process.env.MIXDOG_PATCH_REPLAY_DIR || pathJoin(getPluginDataDir(), 'history', 'patch-replays');
  return base;
}

function getPluginDataDir() {
  try {
    return getPluginData();
  } catch {
    /* fall through */
  }
  return process.env.MIXDOG_DATA_DIR || pathJoin(process.env.USERPROFILE || process.env.HOME || '.', '.mixdog', 'data');
}

function patchTargetPaths(patchStr, _basePath) {
  const text = String(patchStr || '');
  const out = [];
  for (const m of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) {
    const rel = m[1].trim();
    if (rel) out.push(rel);
  }
  // A rename WRITES its destination, so the destination is a target too — the
  // write-root gate and the replay snapshot both need it.
  for (const m of text.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) {
    const rel = m[1].trim();
    if (rel) out.push(rel);
  }
  for (const m of text.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)) {
    const rel = m[1].trim();
    if (rel && rel !== '/dev/null') out.push(rel);
  }
  return [...new Set(out)];
}

const PATCH_REPLAY_ERROR_MAX_CHARS = 64 * 1024;

function patchReplayCaptureEnabled() {
  const flag = String(process.env.MIXDOG_PATCH_REPLAY_CAPTURE ?? '1')
    .trim()
    .toLowerCase();
  return flag !== '0' && flag !== 'false' && flag !== 'off';
}

export function preparePatchReplayCapture(args, cwd, options = {}) {
  if (!patchReplayCaptureEnabled()) return null;
  try {
    const patchStr = typeof args?.patch === 'string' ? args.patch : '';
    const basePath = pathResolve(String(args?.base_path || cwd || process.cwd()));
    return {
      patchStr,
      basePath,
      args: {
        patch: patchStr,
        base_path: args?.base_path ?? null,
        format: args?.format ?? null,
        dry_run: args?.dry_run ?? null,
        fuzzy: args?.fuzzy ?? null,
        reject_partial: args?.reject_partial ?? null,
      },
      targets: patchTargetPaths(patchStr, basePath),
      fileSnapshots: null,
      snapshotPhase: null,
      sessionId: options?.sessionId || null,
      toolCallId: options?.toolCallId || null,
    };
  } catch {
    return null;
  }
}

function snapshotPatchReplayTargets(capture) {
  const files = {};
  for (const rel of capture?.targets || []) {
    try {
      const abs = isAbsolute(rel) ? rel : pathResolve(capture.basePath, rel);
      // Never persist snapshots for targets outside basePath — a malicious
      // or malformed patch could otherwise exfiltrate arbitrary files.
      if (isResolvedPathOutsideBase(abs, capture.basePath)) {
        files[rel] = null;
        continue;
      }
      files[rel] = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    } catch {
      files[rel] = null;
    }
  }
  return files;
}

export function setPatchReplayPreSnapshots(capture, snapshots) {
  if (!capture || capture.snapshotPhase === 'pre') return;
  const byPath = new Map((snapshots || []).map((snapshot) => [pathResolve(snapshot.fullPath), snapshot]));
  const files = {};
  for (const rel of capture.targets || []) {
    try {
      const abs = pathResolve(isAbsolute(rel) ? rel : pathResolve(capture.basePath, rel));
      const snapshot = byPath.get(abs);
      if (!snapshot?.existed) {
        files[rel] = null;
      } else if (Buffer.isBuffer(snapshot.content)) {
        files[rel] = snapshot.content.toString('utf8');
      } else {
        files[rel] = String(snapshot.content ?? '');
      }
    } catch {
      files[rel] = null;
    }
  }
  capture.fileSnapshots = files;
  capture.snapshotPhase = 'pre';
}

function patchReplayOutcome(errorText) {
  const text = String(errorText || '');
  const partial =
    /apply_patch file-level partial:\s*(\d+)\/(\d+) file\(s\) applied to disk \(committed\);\s*(\d+) file\(s\) rejected/i.exec(
      text
    );
  if (!partial) return { kind: 'error' };
  return {
    kind: 'partial',
    applied: Number(partial[1]),
    total: Number(partial[2]),
    rejected: Number(partial[3]),
    rejectedTargets: [...text.matchAll(/^--- rejected file \d+\/\d+:\s*(.+?)\s*---$/gm)].map((match) => match[1]),
  };
}

export function maybeCapturePatchReplay(capture, errorText) {
  // Default ON: every apply_patch failure is frozen for `npm run patch:replay`
  // (args + target-file snapshots). Set MIXDOG_PATCH_REPLAY_CAPTURE=0 to
  // disable. Retention is bounded below to the newest records.
  if (!capture || !patchReplayCaptureEnabled()) return;
  try {
    const dir = patchReplayDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!capture.fileSnapshots) {
      capture.fileSnapshots = snapshotPatchReplayTargets(capture);
      capture.snapshotPhase = 'post-no-prestate';
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const fullError = String(errorText || '');
    const record = {
      id,
      ts: Date.now(),
      tool: 'apply_patch',
      args: capture.args,
      cwd: capture.basePath,
      session_id: capture.sessionId,
      tool_call_id: capture.toolCallId,
      snapshot_phase: capture.snapshotPhase,
      outcome: patchReplayOutcome(fullError),
      error_first_line: fullError.split('\n')[0].slice(0, 400),
      error_text: fullError.slice(0, PATCH_REPLAY_ERROR_MAX_CHARS),
      error_truncated: fullError.length > PATCH_REPLAY_ERROR_MAX_CHARS,
      targets: capture.targets,
      file_snapshots: capture.fileSnapshots,
    };
    writeFileSync(pathJoin(dir, `${id}.json`), JSON.stringify(record, null, 2), { mode: 0o600 });
    // Retention: keep the newest 40 captures. The id prefix is Date.now() in
    // base36 (fixed width until ~2059), so a lexicographic sort is
    // chronological and the oldest records sort first.
    const _kept = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const stale of _kept.slice(0, Math.max(0, _kept.length - 40))) {
      try {
        rmSync(pathJoin(dir, stale), { force: true });
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* capture is best-effort; never affect the tool result */
  }
}
