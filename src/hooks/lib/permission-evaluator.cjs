'use strict';
/**
 * permission-evaluator.cjs
 * Reusable permission evaluation extracted from pre-mcp-sandbox.cjs.
 *
 * Permission priority: deny > ask > allow > mode-default
 *
 * Exported function:
 *   evaluatePermission({ toolName, toolInput, permissionMode, projectDir, userCwd, permissions })
 *   → { decision: 'allow'|'deny'|'ask', reason: string }
 *
 *   `permissions` (optional): pre-loaded `{ allow, deny, ask, defaultMode }` from
 *   settings-loader. When provided, evaluator skips its own loadPermissions call.
 *   The PreToolUse hook / hook-pipe-server already loads settings to gate the
 *   bypass fast-path; passing it through avoids a second 3-tier merge + stat round.
 */

const fs   = require('fs');
const path = require('path');

const { loadPermissions }               = require('./settings-loader.cjs');
const { evaluateRules, isReadOnlyTool } = require('./permission-rules.cjs');

// ── constants ─────────────────────────────────────────────────────────────────

const MCP_PREFIXES = [
  'mcp__plugin_mixdog_mixdog__',
  'mcp__plugin_mixdog_trib-plugin__',
];

// edit/write-class tools allowed under acceptEdits mode
const EDIT_WRITE_TOOLS = new Set([
  'edit', 'write', 'apply_patch',
]);

// ── hard-deny patterns (bypass-proof) ────────────────────────────────────────
// These patterns are evaluated BEFORE mode checks, including bypassPermissions.
// They cover UNC paths and dangerous absolute system locations.

const HARD_DENY_PATH_PATTERNS = [
  // UNC network paths (\\server\share)
  /^\\\\/,
  // Unix system sensitive dirs
  /^\/etc\//i,
  /^\/etc$/i,
  /^\/proc\//i,
  /^\/proc$/i,
  /^\/sys\//i,
  /^\/sys$/i,
  /^\/boot\//i,
  /^\/boot$/i,
  /^\/dev\//i,
  /^\/dev$/i,
  // Windows system dirs (various drive letters)
  /^[a-z]:[/\\]windows[/\\]/i,
  /^[a-z]:[/\\]windows$/i,
  /^[a-z]:[/\\]program files[/\\]/i,
  /^[a-z]:[/\\]program files$/i,
  /^[a-z]:[/\\]program files \(x86\)[/\\]/i,
  /^[a-z]:[/\\]program files \(x86\)$/i,
  /^[a-z]:[/\\]system32/i,
];

/**
 * Returns true if any extracted path matches a hard-deny pattern.
 * Called before mode checks — bypass-proof.
 *
 * Symlink/junction-resilient: also probes the realpath of each candidate so
 * a symlink (or NTFS junction) pointing into a forbidden directory cannot
 * smuggle access. Without this, `read({ path: <tmp>/safe })` where
 * <tmp>/safe is a junction to C:/Windows would slip past the literal
 * pattern match against the surface path and access protected content at
 * runtime via fs.readFile's transparent link resolution.
 */
// NTFS strips trailing dots and spaces from every path component at the
// filesystem layer, so `C:\Windows \foo` and `C:\Windows.\foo` actually
// resolve to `C:\Windows\foo` even though the surface string keeps the
// trailing chars. Without this normalisation a deny rule on /Windows/
// could be bypassed by appending a stray space/dot before the next
// separator. Applies to each `\` and `/` separated segment; safe on
// POSIX too (the segments simply don't contain trailing spaces and the
// transform is a no-op).
function _stripNtfsTrailingChars(p) {
  return String(p).replace(/[. ]+(?=[\\/]|$)/g, '');
}
function isHardDenyPath(rawPaths, opts) {
  const trustedRootsRaw = (opts && Array.isArray(opts.trustedRoots)) ? opts.trustedRoots : [];
  const baseCwd = (opts && typeof opts.cwd === 'string' && opts.cwd) ? opts.cwd : process.cwd();
  // Pre-normalize trusted roots once per call (windows: case-insensitive).
  const trustedRoots = [];
  for (const r of trustedRootsRaw) {
    if (!r || typeof r !== 'string') continue;
    let n;
    try { n = path.resolve(r); } catch { n = r; }
    n = n.replace(/[\\/]+$/, '');
    if (path.sep === '\\') n = n.toLowerCase();
    if (n) trustedRoots.push(n);
  }

  for (const p of rawPaths) {
    if (!p || typeof p !== 'string') continue;
    // UNC check on raw value (before normalization strips leading slashes)
    if (/^\\\\/.test(p)) return true;
    // Normalize for platform-independent matching
    let norm;
    try { norm = path.resolve(p); } catch { norm = p; }
    norm = norm.replace(/\\/g, '/');
    for (const re of HARD_DENY_PATH_PATTERNS) {
      if (re.test(p) || re.test(norm)) return true;
    }
    // NTFS trailing-char strip: `C:\Windows \foo` resolves to `C:\Windows\foo`
    // at the filesystem layer. Re-test both the surface and resolved forms
    // with trailing dots/spaces stripped from every segment.
    const stripped = _stripNtfsTrailingChars(p);
    const strippedNorm = _stripNtfsTrailingChars(norm);
    if (stripped !== p || strippedNorm !== norm) {
      for (const re of HARD_DENY_PATH_PATTERNS) {
        if (re.test(stripped) || re.test(strippedNorm)) return true;
      }
    }
    // Fast-path: skip realpath when the resolved path lives under a trusted
    // root (cwd / plugin root / project dir). Junction-to-system-dir attacks
    // inside user-owned trees are not part of this threat model — the surface
    // pattern checks above still catch any path that literally names a
    // protected system dir, and realpath() on every read is the dominant
    // syscall cost on the hot path. Paths outside the trusted set (writes
    // against absolute system paths, untrusted external roots) still fall
    // through to the realpath check below.
    if (trustedRoots.length > 0) {
      let resolved;
      try { resolved = path.isAbsolute(p) ? path.normalize(p) : path.resolve(baseCwd, p); }
      catch { resolved = null; }
      if (resolved) {
        let cmp = resolved.replace(/[\\/]+$/, '');
        if (path.sep === '\\') cmp = cmp.toLowerCase();
        let inTrusted = false;
        for (const root of trustedRoots) {
          if (cmp === root || cmp.startsWith(root + '\\') || cmp.startsWith(root + '/')) {
            inTrusted = true;
            break;
          }
        }
        if (inTrusted) continue;
      }
    }
    // Resolve symlinks / junctions and re-test. realpathSync throws ENOENT
    // for paths that don't exist yet (legitimate for write/create flows),
    // so missing paths fall through with no extra check — only the literal
    // surface form is enforced for those.
    let real;
    try { real = fs.realpathSync(p); }
    catch { real = null; }
    if (real && real !== p && real !== norm.replace(/\//g, path.sep)) {
      const realNorm = real.replace(/\\/g, '/');
      for (const re of HARD_DENY_PATH_PATTERNS) {
        if (re.test(real) || re.test(realNorm)) return true;
      }
      // Re-test UNC after symlink resolve too: a local-looking path could
      // realpath to a network share and would otherwise dodge the surface
      // UNC test above.
      if (/^\\\\/.test(real)) return true;
    }
  }
  return false;
}

module.exports._isHardDenyPath = isHardDenyPath; // exported for tests

// ── path helpers ──────────────────────────────────────────────────────────────

function normalizePath(p) {
  if (!p || typeof p !== 'string') return null;
  if (/^\\\\/.test(p)) return p;

  if (path.sep === '\\') {
    const posixDriveMatch = p.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (posixDriveMatch) {
      const drive = posixDriveMatch[1].toUpperCase();
      const rest = (posixDriveMatch[2] || '').replace(/\//g, '\\');
      p = drive + ':' + (rest || '\\');
    }
  }

  try {
    return path.isAbsolute(p) ? path.normalize(p) : null;
  } catch {
    return null;
  }
}

function resolveCandidate(p, baseCwd) {
  if (!p || typeof p !== 'string') return null;
  if (/^\\\\/.test(p)) return p;
  try {
    const normalized = normalizePath(p);
    if (normalized !== null && path.isAbsolute(normalized)) return normalized;
    return path.resolve(baseCwd, p);
  } catch {
    return null;
  }
}

function isInside(child, parent) {
  const norm = p => p.replace(/[/\\]+$/, '');
  let c = norm(child);
  let p2 = norm(parent);
  if (path.sep === '\\') { c = c.toLowerCase(); p2 = p2.toLowerCase(); }
  return c === p2 || c.startsWith(p2 + '\\') || c.startsWith(p2 + '/');
}

function deepestExistingAncestor(p) {
  let cur = p;
  while (cur) {
    try { if (fs.existsSync(cur) && fs.statSync(cur).isDirectory()) return cur; } catch { /* walk */ }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.dirname(p);
}

function extractPaths(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];

  const prefix = MCP_PREFIXES.find(p => toolName.startsWith(p));
  const tool = prefix ? toolName.slice(prefix.length) : toolName;
  const candidates = [];

  const push = (...vals) => {
    for (const v of vals) { if (v && typeof v === 'string') candidates.push(v); }
  };

  switch (tool) {
    case 'bash':
    case 'bash_session':
      push(toolInput.cwd);
      break;
    case 'bridge':
      push(toolInput.cwd);
      push(toolInput.file);
      break;
    case 'apply_patch': {
      push(toolInput.base_path);
      const patch = toolInput.patch;
      if (typeof patch === 'string') {
        for (const m of patch.matchAll(/^\+\+\+\s+b\/(.+)$/gm)) push(m[1]);
        for (const m of patch.matchAll(/^---\s+a\/(.+)$/gm)) push(m[1]);
      }
      break;
    }
    case 'read': {
      if (toolInput.path && typeof toolInput.path === 'string') push(toolInput.path);
      // CC `file_path` alias: builtin.mjs:3835 maps args.file_path → args.path
      // before execution, so the permission gate must inspect it too or a
      // deny rule on /Windows can be bypassed by sending file_path:.../Windows/...
      push(toolInput.file_path);
      push(toolInput.cwd);
      if (Array.isArray(toolInput.reads)) toolInput.reads.forEach(r => push(r?.path));
      if (Array.isArray(toolInput.path))  toolInput.path.forEach(p => {
        if (p && typeof p === 'string') push(p);
        else if (p && typeof p === 'object' && p.path) push(p.path);
      });
      break;
    }
    default:
      if (toolInput.path && typeof toolInput.path === 'string') push(toolInput.path);
      // CC `file_path` alias: builtin.mjs:4282/4439 map args.file_path →
      // args.path before execution. Without it edit/write deny rules on a
      // forbidden directory can be bypassed by sending file_path:.../forbidden/...
      push(toolInput.file, toolInput.file_path, toolInput.cwd, toolInput.base_path);
      if (Array.isArray(toolInput.path))  toolInput.path.forEach(p => push(p));
      if (Array.isArray(toolInput.reads)) toolInput.reads.forEach(r => push(r?.path));
      // Per-edit / per-write file_path alias mirrors builtin.mjs:4440 — each
      // item in edits[]/writes[] can carry file_path that overrides the top-level
      // path; collect both forms so deny rules apply uniformly.
      if (Array.isArray(toolInput.edits)) toolInput.edits.forEach(e => push(e?.path, e?.file_path));
      if (Array.isArray(toolInput.writes)) toolInput.writes.forEach(w => push(w?.path, w?.file_path));
      break;
  }

  return [...new Set(candidates)];
}

// ── main evaluator ────────────────────────────────────────────────────────────

/**
 * Evaluate whether a tool call should be allowed, denied, or asked.
 *
 * @param {object} opts
 * @param {string}  opts.toolName       — full tool name (mcp__ prefix expected for mixdog tools)
 * @param {object}  opts.toolInput      — tool arguments object
 * @param {string}  [opts.permissionMode] — override mode ('bypassPermissions', 'acceptEdits',
 *                                         'plan', 'dontAsk', 'default'). Falls back to
 *                                         settings defaultMode.
 * @param {string}  [opts.projectDir]   — project root for settings lookup
 * @param {string}  [opts.userCwd]      — user working directory for path resolution
 * @returns {{ decision: 'allow'|'deny'|'ask', reason: string, updatedInput?: object }}
 */
function evaluatePermission({ toolName, toolInput, permissionMode, projectDir, userCwd, permissions }) {
  const name  = typeof toolName  === 'string' ? toolName  : '';
  const input = (toolInput && typeof toolInput === 'object') ? toolInput : {};
  const cwd   = (typeof userCwd === 'string' && userCwd) ? userCwd : process.cwd();

  // Single extractPaths call — reused for hard-deny, sandbox, and plugin-root checks.
  const rawPaths = extractPaths(name, input);

  // Trusted-root set powers the hard-deny realpath fast-path.
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || '';
  const trustedRoots = [cwd];
  if (pluginRoot) trustedRoots.push(pluginRoot);
  if (projectDir && projectDir !== cwd) trustedRoots.push(projectDir);

  // 0. Hard-deny: bypass-proof path check (UNC, dangerous system paths).
  //    Evaluated before any mode check — even bypassPermissions cannot override.
  if (isHardDenyPath(rawPaths, { trustedRoots, cwd })) {
    return { decision: 'deny', reason: `Tool '${name}' targets a protected system path.` };
  }

  // Plugin source tree: read-only exemption.
  // Paths inside CLAUDE_PLUGIN_ROOT are always allowed for read-class tools.
  if (pluginRoot && isReadOnlyTool(name) && rawPaths.length > 0 &&
      rawPaths.every(p => { const r = resolveCandidate(p, cwd); return r && isInside(r, pluginRoot); })) {
    return { decision: 'allow', reason: 'Plugin source tree read-only access allowed.' };
  }

  // 1. Resolve paths; find first outside-cwd hit
  let firstOutsidePath     = null;
  let firstOutsideResolved = null;

  for (const raw of rawPaths) {
    const resolved = resolveCandidate(raw, cwd);
    if (!resolved) continue;
    if (!isInside(resolved, cwd) && firstOutsidePath === null) {
      firstOutsidePath     = raw;
      firstOutsideResolved = resolved;
    }
  }

  // 2. Use caller-supplied settings when available; otherwise load.
  const { allow, deny, ask, defaultMode } = (permissions && typeof permissions === 'object')
    ? permissions
    : loadPermissions(projectDir || cwd);

  // 4. Permission-list evaluation (deny > ask > allow)
  const listResult = evaluateRules(name, input, allow, deny, ask);

  if (listResult === 'deny') {
    return { decision: 'deny', reason: `Tool '${name}' blocked by deny rule.` };
  }
  if (listResult === 'ask') {
    const outsideReason = firstOutsidePath
      ? `Path '${firstOutsidePath}' is outside project sandbox (${cwd}).`
      : `Tool '${name}' requires explicit approval.`;
    const updatedInput = firstOutsideResolved
      ? { cwd: deepestExistingAncestor(firstOutsideResolved) }
      : undefined;
    return { decision: 'ask', reason: outsideReason, ...(updatedInput ? { updatedInput } : {}) };
  }
  if (listResult === 'allow') {
    return { decision: 'allow', reason: 'Matched allow rule.' };
  }

  // 5. Mode default (no list matched)
  // Settings-derived auto-approval modes take priority over a payload
  // 'default' so that a user-level bypassPermissions is never shadowed.
  const AUTO_MODES = new Set(['bypassPermissions', 'auto']);
  const mode = (AUTO_MODES.has(defaultMode) && !AUTO_MODES.has(permissionMode))
    ? defaultMode
    : (permissionMode || defaultMode || 'default');

  if (AUTO_MODES.has(mode)) {
    return { decision: 'allow', reason: 'bypassPermissions mode.' };
  }

  if (mode === 'acceptEdits') {
    const prefix = MCP_PREFIXES.find(p => name.startsWith(p));
    const shortTool = prefix ? name.slice(prefix.length) : name;
    if (isReadOnlyTool(name) || EDIT_WRITE_TOOLS.has(shortTool)) {
      return { decision: 'allow', reason: 'acceptEdits mode: read-only or edit/write tool.' };
    }
    if (firstOutsideResolved !== null) {
      return { decision: 'ask', reason: `Tool '${name}' is outside project sandbox in acceptEdits mode.` };
    }
    return { decision: 'allow', reason: 'acceptEdits mode: tool is inside project sandbox.' };
  }

  if (mode === 'plan') {
    if (isReadOnlyTool(name)) {
      return { decision: 'allow', reason: 'plan mode: read-only tool.' };
    }
    return { decision: 'ask', reason: `Tool '${name}' is not allowed in plan mode.` };
  }

  if (mode === 'dontAsk') {
    return { decision: 'deny', reason: `Tool '${name}' not matched by any allow rule (dontAsk mode).` };
  }

  // default / unknown mode
  if (firstOutsideResolved !== null) {
    return {
      decision: 'ask',
      reason: `Path '${firstOutsidePath}' is outside project sandbox (${cwd}). Approve to grant mcp access.`,
      updatedInput: { cwd: deepestExistingAncestor(firstOutsideResolved) },
    };
  }

  return { decision: 'allow', reason: 'default mode: tool is inside project sandbox.' };
}

module.exports.evaluatePermission = evaluatePermission;
