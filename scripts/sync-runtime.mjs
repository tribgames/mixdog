#!/usr/bin/env node
/**
 * sync-runtime.mjs — re-vendor the mixdog brain into mixdog-cli.
 *
 * mixdog-cli treats the mixdog source like a vendored dependency (option B in
 * the port-plan discussion): 137 of 141 ported files are PURE copies of
 * mixdog/src, so we re-copy the whole agentLoop closure from upstream and then
 * re-apply a tiny set of standalone patches on top.
 *
 * Run after pulling mixdog changes:
 *     node scripts/sync-runtime.mjs            # copy + patch
 *     node scripts/sync-runtime.mjs --check    # report drift only, no writes
 *
 * The closure is recomputed live from the entry modules, so new upstream files
 * are picked up automatically. Standalone patches are anchor-based and
 * idempotent: if an anchor is missing (upstream moved it) the script FAILS LOUD
 * rather than silently shipping an unpatched file.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..');
const MIXDOG = join(CLI, '..', 'mixdog');
const MIXDOG_SRC = join(MIXDOG, 'src');
const RUNTIME = join(CLI, 'src', 'runtime');
const STATUS_VENDOR = join(CLI, 'src', 'vendor', 'statusline');

const CHECK = process.argv.includes('--check');

// Entry modules whose import closure defines the ported runtime.
const ENTRIES = [
  'agent/orchestrator/session/loop.mjs',
  'agent/orchestrator/session/manager.mjs',
  // Worker-thread modules referenced via new URL(...) are invisible to the
  // static import closure, so keep them as explicit sync roots.
  'agent/orchestrator/session/save-session-worker.mjs',
  'agent/orchestrator/providers/registry.mjs',
];

// ---------------------------------------------------------------------------
// 1. Compute the import closure from mixdog/src
// ---------------------------------------------------------------------------
const IMPORT_RE = /(?:from\s+'([^']+)'|require\('([^']+)'\))/g;

function closure(entries, baseDir) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = join(baseDir, rel);
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, 'utf8');
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[1] || m[2];
      if (spec && spec.startsWith('.')) {
        const tgt = normalizeRel(join(dirname(rel), spec));
        queue.push(tgt);
      }
    }
  }
  return [...seen].filter((rel) => existsSync(join(baseDir, rel)));
}

function normalizeRel(p) {
  return relative(MIXDOG_SRC, join(MIXDOG_SRC, p)).split('\\').join('/');
}

// ---------------------------------------------------------------------------
// 2. Standalone patches — anchor-based, idempotent, fail-loud
// ---------------------------------------------------------------------------
const PATCHES = [
  {
    file: join(RUNTIME, 'shared', 'llm', 'http-agent.mjs'),
    name: 'undici global dispatcher (D7)',
    apply: patchHttpAgent,
  },
  {
    file: join(RUNTIME, 'shared', 'plugin-paths.mjs'),
    name: 'standalone data dir fallback (D12, mjs)',
    apply: (s) => patchPluginPaths(s, 'mjs'),
  },
  {
    file: join(CLI, 'src', 'lib', 'plugin-paths.cjs'),
    name: 'standalone data dir fallback (D12, cjs)',
    apply: (s) => patchPluginPaths(s, 'cjs'),
  },
  // D14 — providers write catalog-refresh diagnostics straight to stderr, which
  // tears through the pi-tui raw-mode screen. Gate them behind an env var that
  // the TUI sets, so interactive runs stay clean while --plain/debug keep logs.
  {
    file: join(RUNTIME, 'agent', 'orchestrator', 'providers', 'anthropic-oauth.mjs'),
    name: 'quiet provider stderr (D14, anthropic-oauth)',
    apply: (s) => patchProviderLog(s, 'anthropic-oauth'),
  },
  {
    file: join(RUNTIME, 'agent', 'orchestrator', 'providers', 'grok-oauth.mjs'),
    name: 'quiet provider stderr (D14, grok-oauth)',
    apply: (s) => patchProviderLog(s, 'grok-oauth'),
  },
  {
    file: join(RUNTIME, 'agent', 'orchestrator', 'providers', 'gemini.mjs'),
    name: 'quiet provider stderr (D14, gemini)',
    apply: (s) => patchProviderLog(s, 'gemini'),
  },
  {
    file: join(RUNTIME, 'agent', 'orchestrator', 'providers', 'openai-oauth.mjs'),
    name: 'quiet provider stderr (D14, openai-oauth)',
    apply: (s) => patchProviderLog(s, 'openai-oauth'),
  },
  // D15 — standalone CLI consumes mixdog's session manager as the runtime
  // boundary. askSession still owns persistence/compaction/tool lifecycle, but
  // the TUI needs streamed text/usage/stage callbacks to render like an app.
  {
    file: join(RUNTIME, 'agent', 'orchestrator', 'session', 'manager.mjs'),
    name: 'session-manager UI callbacks (D15)',
    apply: patchSessionManagerUiCallbacks,
  },
  // Statusline vendor — route-meta.mjs upstream lives next to claude-current in
  // mixdog/src/gateway and pulls sibling runtime modules via ../shared/** and
  // ../agent/**. Vendored under src/vendor/statusline/src/gateway, those
  // relatives must re-point into the synced runtime tree (src/runtime/**).
  {
    file: join(STATUS_VENDOR, 'src', 'gateway', 'route-meta.mjs'),
    name: 'statusline route-meta runtime imports (vendor re-point)',
    apply: patchStatuslineGatewayRuntimeImports,
  },
  {
    file: join(STATUS_VENDOR, 'src', 'gateway', 'session-routes.mjs'),
    name: 'statusline session-routes runtime imports (vendor re-point)',
    apply: patchStatuslineGatewayRuntimeImports,
  },
];

/**
 * D14 — wrap provider catalog-refresh stderr writes in an env gate so the TUI
 * can silence them. Idempotent (skips if already gated) and fail-loud (throws
 * if neither anchor line is present, so an upstream rename is surfaced).
 *
 * Targets both `[provider] catalog refreshed (...)` and `... refresh failed`.
 */
function patchProviderLog(src, provider) {
  const GATE = 'if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(';
  if (src.includes('MIXDOG_QUIET_PROVIDER_LOG')) return { text: src, already: true };
  // Match the bare `process.stderr.write(` immediately preceding a
  // `[provider] catalog refresh` literal, regardless of refreshed/failed.
  const re = new RegExp(
    `process\\.stderr\\.write\\((\`\\[${provider}\\] catalog refresh)`,
    'g',
  );
  if (!re.test(src)) {
    throw new Error(`[sync] provider-log anchor not found in ${provider} — upstream changed the catalog-refresh log; reconcile patch manually.`);
  }
  re.lastIndex = 0;
  const text = src.replace(re, (_m, lit) => `${GATE}${lit}`);
  return { text, already: false };
}

function patchSessionManagerUiCallbacks(src) {
  if (
    src.includes('askOpts = {}') &&
    src.includes('askOpts?.onTextDelta') &&
    src.includes('askOpts?.onReasoningDelta') &&
    src.includes('MIXDOG_QUIET_SESSION_LOG') &&
    src.includes('opts.skipSkills ? []')
  ) {
    return { text: src, already: true };
  }
  let s = src;
  const sig = 'export async function askSession(sessionId, prompt, context, onToolCall, cwdOverride, explicitPrefetch) {';
  if (!s.includes(sig)) {
    throw new Error('[sync] session-manager askSession signature anchor not found — reconcile UI callback patch manually.');
  }
  s = s.replace(
    sig,
    'export async function askSession(sessionId, prompt, context, onToolCall, cwdOverride, explicitPrefetch, askOpts = {}) {',
  );

  const usageAnchor = '                    onUsageDelta: (d) => persistIterationMetrics(d).catch(() => {}),';
  if (!s.includes(usageAnchor)) {
    throw new Error('[sync] session-manager onUsageDelta anchor not found — reconcile UI callback patch manually.');
  }
  s = s.replace(
    usageAnchor,
    `                    onTextDelta: typeof askOpts?.onTextDelta === 'function' ? askOpts.onTextDelta : undefined,
                    onReasoningDelta: typeof askOpts?.onReasoningDelta === 'function' ? askOpts.onReasoningDelta : undefined,
                    onUsageDelta: (d) => {
                        persistIterationMetrics(d).catch(() => {});
                        try { askOpts?.onUsageDelta?.(d); } catch {}
                    },`,
  );

  const stageAnchor = `                    onStageChange: (stage) => updateSessionStage(sessionId, stage),
                    onStreamDelta: () => markSessionStreamDelta(sessionId).catch(() => {}),`;
  if (!s.includes(stageAnchor)) {
    throw new Error('[sync] session-manager stage/stream anchors not found — reconcile UI callback patch manually.');
  }
  s = s.replace(
    stageAnchor,
    `                    onStageChange: (stage) => {
                        updateSessionStage(sessionId, stage);
                        try { askOpts?.onStageChange?.(stage); } catch {}
                    },
                    onStreamDelta: () => {
                        markSessionStreamDelta(sessionId).catch(() => {});
                        try { askOpts?.onStreamDelta?.(); } catch {}
                    },`,
  );

  const skillsAnchor = '    const skills = collectSkillsCached(opts.cwd);';
  if (!s.includes(skillsAnchor)) {
    throw new Error('[sync] session-manager skills anchor not found — reconcile CLI skipSkills patch manually.');
  }
  s = s.replace(skillsAnchor, '    const skills = opts.skipSkills ? [] : collectSkillsCached(opts.cwd);');

  const quietReplacements = [
    [
      'if (tools.length !== before) {\n            process.stderr.write(`[session] schemaAllowedTools=${callerAllow.join(\',\')} kept ${tools.length}/${before} tools\\n`);\n        }',
      'if (tools.length !== before && !process.env.MIXDOG_QUIET_SESSION_LOG) {\n            process.stderr.write(`[session] schemaAllowedTools=${callerAllow.join(\',\')} kept ${tools.length}/${before} tools\\n`);\n        }',
      'schemaAllowedTools quiet-log anchor',
    ],
    [
      'if (tools.length !== before) {\n            process.stderr.write(`[session] disallowedTools=${callerDeny.join(\',\')} stripped ${before - tools.length} tools\\n`);\n        }',
      'if (tools.length !== before && !process.env.MIXDOG_QUIET_SESSION_LOG) {\n            process.stderr.write(`[session] disallowedTools=${callerDeny.join(\',\')} stripped ${before - tools.length} tools\\n`);\n        }',
      'disallowedTools quiet-log anchor',
    ],
    [
      'if (tools.length !== before) {\n            process.stderr.write(`[session] bridgeHidden stripped ${before - tools.length} tools\\n`);\n        }',
      'if (tools.length !== before && !process.env.MIXDOG_QUIET_SESSION_LOG) {\n            process.stderr.write(`[session] bridgeHidden stripped ${before - tools.length} tools\\n`);\n        }',
      'bridgeHidden quiet-log anchor',
    ],
    [
      'if (resolvedRole) {\n        process.stderr.write(`[session] role=${resolvedRole} permission=${permission || \'full\'} toolPermission=${toolPermission || \'full\'} tools=${tools.length}\\n`);\n    }',
      'if (resolvedRole && !process.env.MIXDOG_QUIET_SESSION_LOG) {\n        process.stderr.write(`[session] role=${resolvedRole} permission=${permission || \'full\'} toolPermission=${toolPermission || \'full\'} tools=${tools.length}\\n`);\n    }',
      'role quiet-log anchor',
    ],
    [
      'process.stderr.write(`[bridge-close] ${parts.join(\' \')}\\n`);',
      'if (!process.env.MIXDOG_QUIET_SESSION_LOG) process.stderr.write(`[bridge-close] ${parts.join(\' \')}\\n`);',
      'bridge-close quiet-log anchor',
    ],
  ];
  for (const [from, to, label] of quietReplacements) {
    if (!s.includes(from)) {
      throw new Error(`[sync] session-manager ${label} not found — reconcile quiet-log patch manually.`);
    }
    s = s.replace(from, to);
  }
  return { text: s, already: false };
}

function patchHttpAgent(src) {
  if (src.includes('_globalInstalled')) return { text: src, already: true };
  let s = src;
  s = s.replace(
    "import { Agent, getGlobalDispatcher, request as undiciRequest } from 'undici'",
    "import { Agent, getGlobalDispatcher, setGlobalDispatcher, request as undiciRequest } from 'undici'",
  );
  s = s.replace('let _agent = null', 'let _agent = null\nlet _globalInstalled = false');
  const anchor = `  if (proxyConfigured()) return undefined
  if (_agent) return _agent
  _agent = new Agent({
    keepAliveTimeout: envInt('MIXDOG_LLM_KEEPALIVE_MS', 60_000),
    // Cap the idle keep-alive bump the server may request, so a generous
    // upstream Keep-Alive header can't pin sockets open far longer than us.
    keepAliveMaxTimeout: envInt('MIXDOG_LLM_KEEPALIVE_MAX_MS', 90_000),
    connections: envInt('MIXDOG_LLM_CONNECTIONS', 16),
  })
  return _agent`;
  const replacement = `  if (proxyConfigured()) return undefined
  if (!_agent) {
    _agent = new Agent({
      keepAliveTimeout: envInt('MIXDOG_LLM_KEEPALIVE_MS', 60_000),
      keepAliveMaxTimeout: envInt('MIXDOG_LLM_KEEPALIVE_MAX_MS', 90_000),
      connections: envInt('MIXDOG_LLM_CONNECTIONS', 16),
    })
  }
  // mixdog-cli standalone: separate undici instance from Node's fetch undici, so
  // a per-request dispatcher throws UND_ERR_INVALID_ARG. Install globally once
  // and omit the per-request dispatcher. See port-plan D7.
  if (!_globalInstalled) {
    try { setGlobalDispatcher(_agent); _globalInstalled = true } catch { /* fall back */ }
  }
  return _globalInstalled ? undefined : _agent`;
  if (!s.includes(anchor)) {
    throw new Error('[sync] http-agent anchor not found — upstream changed getLlmDispatcher(); reconcile patch manually.');
  }
  return { text: s.replace(anchor, replacement), already: false };
}

/**
 * Statusline vendor — re-point route-meta.mjs's runtime imports.
 *
 * Upstream route-meta.mjs sits in mixdog/src/gateway and reaches its sibling
 * runtime modules with `../shared/**` and `../agent/**`. Mirrored verbatim
 * under src/vendor/statusline/src/gateway, those bare relatives would resolve
 * to non-existent vendor-local paths, so they are rewritten to climb out of the
 * statusline vendor tree into the synced runtime closure (src/runtime/**).
 * `./claude-current.mjs` is left untouched — it is vendored alongside.
 * Idempotent (skips once re-pointed) and fail-loud (throws if neither import
 * root is present, surfacing an upstream move).
 */
function patchStatuslineGatewayRuntimeImports(src) {
  if (src.includes('../../../../runtime/shared/') || src.includes('../../../../runtime/agent/')) {
    return { text: src, already: true };
  }
  if (!src.includes("'../shared/") && !src.includes("'../agent/")) {
    throw new Error('[sync] route-meta import anchors not found — upstream moved gateway/route-meta runtime imports; reconcile patch manually.');
  }
  const text = src
    .split("'../shared/").join("'../../../../runtime/shared/")
    .split("'../agent/").join("'../../../../runtime/agent/");
  return { text, already: false };
}

function patchPluginPaths(src, kind) {
  if (src.includes('MIXDOG_DATA_DIR')) return { text: src, already: true };
  const throwLine =
    "throw new Error('[plugin-paths] CLAUDE_PLUGIN_DATA and CLAUDE_PLUGIN_ROOT are both unset — cannot resolve plugin data dir outside of Claude Code.');";
  if (!src.includes(throwLine)) {
    throw new Error(`[sync] plugin-paths(${kind}) throw anchor not found — reconcile patch manually.`);
  }
  const fallback =
    kind === 'mjs'
      ? `// Standalone mixdog-cli: own a private data dir (override with MIXDOG_DATA_DIR).
  return process.env.MIXDOG_DATA_DIR || join(homedir(), '.mixdog', 'data');`
      : `// Standalone mixdog-cli: own a private data dir (override with MIXDOG_DATA_DIR).
  return process.env.MIXDOG_DATA_DIR || path.join(require('os').homedir(), '.mixdog', 'data');`;
  return { text: src.replace(throwLine, fallback), already: false };
}

// ---------------------------------------------------------------------------
// 3. Run
// ---------------------------------------------------------------------------

// Map a destination file path to the patch that gets re-applied on top of the
// upstream copy. In --check we must compare the *patched* upstream against the
// vendored file, otherwise the 3 standalone-patched files always read as drift
// (they differ from raw upstream by design — that's the patch, not real drift).
const PATCH_BY_DEST = new Map(PATCHES.map((p) => [p.file, p.apply]));

// Expected vendored bytes for a destination: upstream source with the matching
// standalone patch applied in-memory. Returns null if the patch anchor is gone
// (upstream moved it) so --check can surface it as a real drift to reconcile.
function expectedBytes(from, to) {
  const raw = readFileSync(from, 'utf8');
  const patch = PATCH_BY_DEST.get(to);
  if (!patch) return raw;
  try {
    return patch(raw).text;
  } catch {
    return null; // anchor missing — treat as drift, surface to the user
  }
}

function copyInto(relFiles, srcBase, dstBase, label) {
  let copied = 0;
  for (const rel of relFiles) {
    const from = join(srcBase, rel);
    const to = join(dstBase, rel);
    if (!existsSync(from)) continue;
    if (CHECK) {
      const want = expectedBytes(from, to);
      const have = existsSync(to) ? readFileSync(to, 'utf8') : null;
      if (want === null) { console.log(`  drift (patch anchor lost): ${label}/${rel}`); copied++; continue; }
      if (want !== have) { console.log(`  drift: ${label}/${rel}`); copied++; }
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied++;
  }
  return copied;
}

function main() {
  if (!existsSync(MIXDOG_SRC)) {
    console.error(`[sync] mixdog source not found at ${MIXDOG_SRC}`);
    process.exit(1);
  }

  console.log(CHECK ? '== sync --check (no writes) ==' : '== sync-runtime ==');

  // 3a. runtime closure
  const files = closure(ENTRIES, MIXDOG_SRC);
  const n = copyInto(files, MIXDOG_SRC, RUNTIME, 'runtime');
  console.log(`runtime closure: ${files.length} files, ${CHECK ? n + ' drifted' : n + ' copied'}`);

  // 3b. lib + hooks/lib cjs + defaults (data files & cjs siblings)
  const libFiles = ['keychain-cjs.cjs', 'plugin-paths.cjs'];
  copyInto(libFiles, join(MIXDOG, 'lib'), join(CLI, 'src', 'lib'), 'lib');
  const hookFiles = ['permission-evaluator.cjs', 'permission-rules.cjs', 'settings-loader.cjs'];
  copyInto(hookFiles, join(MIXDOG, 'hooks', 'lib'), join(CLI, 'src', 'hooks', 'lib'), 'hooks/lib');
  const defaultFiles = ['hidden-roles.json', 'user-workflow.json', 'user-workflow.md',
    'mixdog-config.template.json', 'memory-chunk-prompt.md', 'memory-promote-prompt.md',
    'cycle3-review-prompt.md'];
  copyInto(defaultFiles, join(MIXDOG, 'defaults'), join(CLI, 'src', 'defaults'), 'defaults');

  // 3b'. statusline vendor — PURE verbatim copies of the plugin's L1/L2
  // renderer + its gateway deps, mirrored under src/vendor/statusline so the
  // original relative imports (`./statusline-route.mjs`,
  // `../src/gateway/claude-current.mjs`) keep resolving unchanged. No patches.
  const statusBinFiles = ['statusline-lib.mjs', 'statusline-route.mjs'];
  copyInto(statusBinFiles, join(MIXDOG, 'bin'), join(STATUS_VENDOR, 'bin'), 'vendor/statusline/bin');
  const statusGatewayFiles = ['claude-current.mjs', 'route-meta.mjs', 'session-routes.mjs'];
  copyInto(statusGatewayFiles, join(MIXDOG, 'src', 'gateway'), join(STATUS_VENDOR, 'src', 'gateway'), 'vendor/statusline/src/gateway');
  // statusline-lib also imports `../scripts/lib/gateway-settings.mjs` (node-only,
  // self-contained — no plugin deps), mirrored under the vendor tree verbatim.
  const statusScriptLibFiles = ['gateway-settings.mjs'];
  copyInto(statusScriptLibFiles, join(MIXDOG, 'scripts', 'lib'), join(STATUS_VENDOR, 'scripts', 'lib'), 'vendor/statusline/scripts/lib');

  // 3c. re-apply standalone patches
  if (CHECK) {
    console.log('patches: (skipped in --check)');
  } else {
    for (const p of PATCHES) {
      if (!existsSync(p.file)) { console.error(`  PATCH TARGET MISSING: ${p.file}`); process.exit(1); }
      const src = readFileSync(p.file, 'utf8');
      const { text, already } = p.apply(src);
      if (already) { console.log(`  patch ok (already): ${p.name}`); continue; }
      writeFileSync(p.file, text);
      console.log(`  patch applied: ${p.name}`);
    }
  }

  console.log(CHECK ? '== check done ==' : '== sync complete ==');
}

main();
