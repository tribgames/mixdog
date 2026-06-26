'use strict';
/**
 * permission-evaluator.cjs
 * Reusable permission evaluation extracted from pre-mcp-sandbox.cjs.
 *
 * Permission priority (pi-like practical model):
 *   deny > allow > (ask neutralized) > mode-default
 *
 * Practical pi-like behavior:
 *   - Hard-deny path checks (OS system dirs, UNC, etc.) always enforced.
 *   - Credential/token paths are non-write-protected, but writes stay allowed so
 *     the user can ask the agent to install/update tokens explicitly.
 *   - Explicit deny rules from settings always enforced.
 *   - Explicit ask rules from settings are treated as no-match (no prompts).
 *   - Default mode is trust/allow — no cwd-sandbox prompts.
 *   - Permission modes and ask rules are config-compatible no-ops for the
 *     runtime gate; the evaluator now returns only allow/deny. The 'ask'
 *     return type remains for external API compatibility.
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
const os   = require('os');

const { loadPermissions }               = require('./settings-loader.cjs');
const { evaluateRules } = require('./permission-rules.cjs');
const { mixdogRoot }                    = require('../../lib/plugin-paths.cjs');

// ── constants ─────────────────────────────────────────────────────────────────

const MCP_PREFIXES = [
  'mcp__plugin_mixdog_mixdog__',
  'mcp__plugin_mixdog_trib-plugin__',
];

// ── hard-deny patterns (bypass-proof) ────────────────────────────────────────
// These patterns are evaluated BEFORE mode checks, including bypassPermissions.
// They cover UNC paths and dangerous OS locations. This is intentionally not a
// full sandbox; it is the small hard-stop layer that remains in the pi-like
// trust model.

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
  /^\/root\//i,
  /^\/root$/i,
  /^\/run\//i,
  /^\/run$/i,
  /^\/var\/run\//i,
  /^\/var\/run$/i,
  /^\/var\/lib\//i,
  /^\/var\/lib$/i,
  /^\/var\/db\//i,
  /^\/var\/db$/i,
  /^\/bin\//i,
  /^\/bin$/i,
  /^\/sbin\//i,
  /^\/sbin$/i,
  /^\/usr\/bin\//i,
  /^\/usr\/bin$/i,
  /^\/usr\/sbin\//i,
  /^\/usr\/sbin$/i,
  /^\/usr\/lib\//i,
  /^\/usr\/lib$/i,
  /^\/usr\/lib64\//i,
  /^\/usr\/lib64$/i,
  // macOS system locations
  /^\/system\//i,
  /^\/system$/i,
  /^\/library\//i,
  /^\/library$/i,
  /^\/private\/etc\//i,
  /^\/private\/etc$/i,
  /^\/private\/var\/db\//i,
  /^\/private\/var\/db$/i,
  /^\/private\/var\/run\//i,
  /^\/private\/var\/run$/i,
  /^\/volumes\//i,
  /^\/volumes$/i,
  // Windows system dirs (various drive letters)
  /^[a-z]:[/\\]windows[/\\]/i,
  /^[a-z]:[/\\]windows$/i,
  /^[a-z]:[/\\]program files[/\\]/i,
  /^[a-z]:[/\\]program files$/i,
  /^[a-z]:[/\\]program files \(x86\)[/\\]/i,
  /^[a-z]:[/\\]program files \(x86\)$/i,
  /^[a-z]:[/\\]system32/i,
  /^[a-z]:[/\\]programdata[/\\]/i,
  /^[a-z]:[/\\]programdata$/i,
  /^[a-z]:[/\\]programdata[/\\]microsoft[/\\]/i,
  /^[a-z]:[/\\]programdata[/\\]microsoft$/i,
  /^[a-z]:[/\\]programdata[/\\]ssh[/\\]/i,
  /^[a-z]:[/\\]programdata[/\\]ssh$/i,
  /^[a-z]:[/\\]programdata[/\\]docker[/\\]/i,
  /^[a-z]:[/\\]programdata[/\\]docker$/i,
  /^[a-z]:[/\\]recovery[/\\]/i,
  /^[a-z]:[/\\]recovery$/i,
  /^[a-z]:[/\\]boot[/\\]/i,
  /^[a-z]:[/\\]boot$/i,
  /^[a-z]:[/\\]efi[/\\]/i,
  /^[a-z]:[/\\]efi$/i,
  /^[a-z]:[/\\]system volume information[/\\]/i,
  /^[a-z]:[/\\]system volume information$/i,
  /^[a-z]:[/\\]\$recycle\.bin[/\\]/i,
  /^[a-z]:[/\\]\$recycle\.bin$/i,
  /^[a-z]:[/\\](pagefile|hiberfil|swapfile)\.sys$/i,
  /^[a-z]:[/\\]documents and settings[/\\]/i,
  /^[a-z]:[/\\]documents and settings$/i,
  /^[a-z]:[/\\]users[/\\]all users[/\\]/i,
  /^[a-z]:[/\\]users[/\\]all users$/i,
];

// Credential/token locations are different from OS system paths: reading,
// searching, or delegating them through free-form prompts is a common
// exfiltration footgun, but writing them is a normal
// user-requested setup task. Keep them out of HARD_DENY so `write`/`edit` can
// still install tokens when the user explicitly provides the value.
const SECRET_READ_DENY_PATH_PATTERNS = [
  // Cross-platform user credential stores and token files
  /^\/home\/[^/\\]+[/\\]\.(ssh|gnupg|aws|azure|docker|kube)([/\\]|$)/i,
  /^\/home\/[^/\\]+[/\\]\.config[/\\]gcloud([/\\]|$)/i,
  /^\/home\/[^/\\]+[/\\]\.(npmrc|netrc|pypirc|git-credentials)$/i,
  /^\/users\/[^/\\]+[/\\]\.(ssh|gnupg|aws|azure|docker|kube)([/\\]|$)/i,
  /^\/users\/[^/\\]+[/\\]\.config[/\\]gcloud([/\\]|$)/i,
  /^\/users\/[^/\\]+[/\\]\.(npmrc|netrc|pypirc|git-credentials)$/i,
  /^\/users\/[^/\\]+[/\\]library[/\\]keychains([/\\]|$)/i,
  /^\/users\/[^/\\]+[/\\]library[/\\]application support[/\\](google[/\\]chrome|microsoft edge|bravesoftware|firefox|mozilla)([/\\]|$)/i,
  /^[a-z]:[/\\]users[/\\][^/\\]+[/\\]\.(ssh|gnupg|aws|azure|docker|kube)([/\\]|$)/i,
  /^[a-z]:[/\\]users[/\\][^/\\]+[/\\]\.config[/\\]gcloud([/\\]|$)/i,
  /^[a-z]:[/\\]users[/\\][^/\\]+[/\\]\.(npmrc|netrc|pypirc|git-credentials)$/i,
  /^[a-z]:[/\\]users[/\\][^/\\]+[/\\]appdata[/\\](roaming|local)[/\\]microsoft[/\\](credentials|protect)([/\\]|$)/i,
  /^[a-z]:[/\\]users[/\\][^/\\]+[/\\]appdata[/\\]roaming[/\\]gnupg([/\\]|$)/i,
  /^[a-z]:[/\\]users[/\\][^/\\]+[/\\]appdata[/\\]local[/\\](google[/\\]chrome|microsoft[/\\]edge|bravesoftware|mozilla|firefox)([/\\]|$)/i,
  /^[a-z]:[/\\]users[/\\][^/\\]+[/\\]appdata[/\\]roaming[/\\](mozilla[/\\]firefox|mozilla|firefox)([/\\]|$)/i,
];

const SECRET_WRITE_TOOLS = new Set([
  'write', 'edit', 'apply_patch', 'multi_edit', 'multiedit',
]);

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
function shortToolName(toolName) {
  const name = typeof toolName === 'string' ? toolName : '';
  const prefix = MCP_PREFIXES.find(p => name.startsWith(p));
  if (prefix) return name.slice(prefix.length);
  if (name.startsWith('mcp__')) return name.split('__').pop() || name;
  return name;
}

function isSecretWriteTool(toolName) {
  return SECRET_WRITE_TOOLS.has(shortToolName(toolName).toLowerCase());
}

function extractPathLiteralsFromText(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const addMatches = (re, group = 0) => {
    for (const m of text.matchAll(re)) {
      const value = (m[group] || '').trim().replace(/[),.;:]+$/g, '');
      if (value) out.push(value);
    }
  };
  // Capture path-looking spans until punctuation/quotes, or a whitespace that
  // is not followed by another path segment. This keeps paths with spaces such
  // as `Google/Chrome/User Data`, but stops before prose like `.npmrc please`.
  addMatches(/[a-zA-Z]:[/\\](?:[^\s"'`<>|),;:]+|\s+(?=[^\s"'`<>|),;:]+[/\\][^\s"'`<>|),;:]*))*/g);
  addMatches(/\\\\(?:[^\s"'`<>|),;:]+|\s+(?=[^\s"'`<>|),;:]+[/\\][^\s"'`<>|),;:]*))*/g);
  addMatches(/~[/\\][^\s"'`<>|]*/g);
  addMatches(/\/(?:etc|proc|sys|boot|dev|root|run|var|bin|sbin|usr|System|Library|private|Volumes|home|Users|users)(?:[^\s"'`<>|),;:]+|\s+(?=[^\s"'`<>|),;:]+[/\\][^\s"'`<>|),;:]*))*/g);
  return out;
}

function matchesProtectedPath(rawPaths, opts, patterns) {
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
    // Normalize for platform-independent matching. Relative paths must resolve
    // against the user cwd supplied by the hook payload, not the hook server's
    // process.cwd(), or `..\\Windows\\System32` can miss the hard-deny check.
    let resolved;
    try { resolved = resolveCandidate(p, baseCwd); } catch { resolved = null; }
    let norm = (resolved || p).replace(/\\/g, '/');
    for (const re of patterns) {
      if (re.test(p) || re.test(norm)) return true;
    }
    // NTFS trailing-char strip: `C:\Windows \foo` resolves to `C:\Windows\foo`
    // at the filesystem layer. Re-test both the surface and resolved forms
    // with trailing dots/spaces stripped from every segment.
    const stripped = _stripNtfsTrailingChars(p);
    const strippedNorm = _stripNtfsTrailingChars(norm);
    if (stripped !== p || strippedNorm !== norm) {
      for (const re of patterns) {
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
    try { real = fs.realpathSync(resolved || p); }
    catch { real = null; }
    if (real && real !== p && real !== norm.replace(/\//g, path.sep)) {
      const realNorm = real.replace(/\\/g, '/');
      for (const re of patterns) {
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

function isHardDenyPath(rawPaths, opts) {
  return matchesProtectedPath(rawPaths, opts, HARD_DENY_PATH_PATTERNS);
}

function isSecretReadDenyPath(rawPaths, opts) {
  return matchesProtectedPath(rawPaths, opts, SECRET_READ_DENY_PATH_PATTERNS);
}

module.exports._isHardDenyPath = isHardDenyPath; // exported for tests

// ── path helpers ──────────────────────────────────────────────────────────────

function normalizePath(p) {
  if (!p || typeof p !== 'string') return null;
  if (/^\\\\/.test(p)) return p;

  // Shell-style home shorthand is common in user prompts/settings. Expand it
  // before absolute/relative resolution so `~/.npmrc` is treated as the real
  // home token file, not as a harmless repo-relative path named `~`.
  if (p === '~') p = os.homedir();
  else if (/^~[/\\]/.test(p)) p = path.join(os.homedir(), p.slice(2));

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

function extractPaths(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];

  const prefix = MCP_PREFIXES.find(p => toolName.startsWith(p));
  const tool = prefix ? toolName.slice(prefix.length) : toolName;
  const candidates = [];

  const push = (...vals) => {
    for (const v of vals) { if (v && typeof v === 'string') candidates.push(v); }
  };
  const pushTextPaths = (...vals) => {
    for (const v of vals) push(...extractPathLiteralsFromText(v));
  };
  const pushPatchTarget = (target) => {
    if (!target || typeof target !== 'string') return;
    const cleaned = target.trim();
    if (!cleaned) return;
    push(cleaned);
    if (toolInput.base_path && typeof toolInput.base_path === 'string') {
      try {
        const normalized = normalizePath(cleaned);
        if (!(normalized !== null && path.isAbsolute(normalized))) {
          push(path.join(toolInput.base_path, cleaned));
        }
      } catch {}
    }
  };

  switch (tool) {
    case 'bash':
    case 'bash_session':
      push(toolInput.cwd);
      pushTextPaths(toolInput.command);
      break;
    case 'bridge':
      push(toolInput.cwd);
      push(toolInput.file);
      pushTextPaths(toolInput.prompt, toolInput.message, toolInput.context);
      break;
    case 'apply_patch': {
      push(toolInput.base_path);
      const patch = toolInput.patch;
      if (typeof patch === 'string') {
        for (const m of patch.matchAll(/^\+\+\+\s+b\/(.+)$/gm)) pushPatchTarget(m[1]);
        for (const m of patch.matchAll(/^---\s+a\/(.+)$/gm)) pushPatchTarget(m[1]);
        for (const m of patch.matchAll(/^\*\*\*\s+(?:Add|Update|Delete) File:\s+(.+)$/gm)) pushPatchTarget(m[1]);
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
      pushTextPaths(toolInput.command, toolInput.query, toolInput.prompt, toolInput.message, toolInput.context);
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

  // Single extractPaths call — reused for hard-deny, secret-read, and explicit deny checks.
  const rawPaths = extractPaths(name, input);

  // Trusted-root set powers the hard-deny realpath fast-path.
  const root = mixdogRoot();
  const trustedRoots = [cwd];
  if (root) trustedRoots.push(root);
  if (projectDir && projectDir !== cwd) trustedRoots.push(projectDir);

  // 0. Hard-deny: bypass-proof path check (UNC, dangerous system paths).
  //    Evaluated before any mode check — even bypassPermissions cannot override.
  if (isHardDenyPath(rawPaths, { trustedRoots, cwd })) {
    return { decision: 'deny', reason: `Tool '${name}' targets a protected system path.` };
  }

  if (isSecretReadDenyPath(rawPaths, { trustedRoots, cwd }) && !isSecretWriteTool(name)) {
    return { decision: 'deny', reason: `Tool '${name}' targets a protected credential path without a write-class tool.` };
  }

  // 1. Use caller-supplied settings when available; otherwise load.
  const { allow, deny, defaultMode } = (permissions && typeof permissions === 'object')
    ? permissions
    : loadPermissions(projectDir || cwd);

  // 2. Explicit rules. Pi-like practical keeps deny as the only user rule that
  // blocks at runtime. Ask rules are ignored by passing an empty ask list.
  const listResult = evaluateRules(name, input, allow, deny, []);

  if (listResult === 'deny') {
    return { decision: 'deny', reason: `Tool '${name}' blocked by deny rule.` };
  }
  if (listResult === 'allow') {
    return { decision: 'allow', reason: 'Matched allow rule.' };
  }

  // 3. Permission modes are accepted for compatibility only. They no longer
  // implement a sandbox policy; runtime safety is hard-deny + secret-read deny + explicit deny.
  const mode = permissionMode || defaultMode || 'default';
  return { decision: 'allow', reason: `${mode} mode: trust/allow (pi-like).` };
}

module.exports.evaluatePermission = evaluatePermission;
