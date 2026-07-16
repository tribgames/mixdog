import { discoverPluginMcp } from './plugin-mcp.mjs';

// cwd-plugins.mjs — cwd resolution/apply + plugins-status + core-memory context,
// extracted from mixdog-session-runtime.mjs. Dependency-injected factory that
// closes over the facade's mutable cwd/config/session state via getter/setter
// injection (getCurrentCwd/setCurrentCwd/getConfig/getSession/...) plus the MCP
// glue + prewarm callbacks. The facade keeps ownership of the mutable locals;
// this module owns the pure logic that was previously inline.

export function createCwdPlugins({
  // mutable-state injection
  getCurrentCwd,
  setCurrentCwd,
  getConfig,
  getSession,
  getRoute,
  getLastProjectMcpKey,
  setLastProjectMcpKey,
  isCodeGraphPrewarmLazy,
  isCodeGraphFirstTurnPrewarmDone,
  getCodeGraphPrewarmDelayMs,
  setSessionNeedsCwdRefresh,
  // callbacks / deps
  connectConfiguredMcp,
  invalidatePreSessionToolSurface,
  scheduleCodeGraphPrewarm,
  hooks,
  hookCommonPayload,
  bootProfile,
  getMemoryModule,
  // channel-admin / registry helpers
  listRegisteredPlugins,
  pluginAdminStatus,
  pluginManifest,
  pluginMcpServerName,
  mcpScriptForPlugin,
  countSkillFiles,
  readProjectMcpServers,
  writeLastSessionCwd,
  // shared utils
  clean,
  resolve,
  statSync,
  existsSync,
  cfgMod,
  STANDALONE_DATA_DIR,
}) {
  // Per-plugin-root caches for pluginsStatus(): manifest + MCP discovery keyed
  // by root path + manifest mtime (invalidated on manifest edit); recursive
  // skill-file count keyed by root with a ~5s TTL fallback (the walk has no
  // single mtime to key on).
  const pluginRootCache = new Map();
  const skillCountCache = new Map();
  const mcpDiscoveryCache = new Map();
  function manifestMtimeKey(root) {
    let key = '';
    for (const rel of ['.codex-plugin/plugin.json', 'plugin.json']) {
      try { key += `${statSync(resolve(root, rel)).mtimeMs}:`; } catch { key += '0:'; }
    }
    return key;
  }
  function cachedPluginData(root) {
    const key = manifestMtimeKey(root);
    const hit = pluginRootCache.get(root);
    if (hit && hit.key === key) return hit;
    const entry = { key, manifest: pluginManifest(root) };
    pluginRootCache.set(root, entry);
    return entry;
  }
  // MCP discovery probes candidate script files (.mcp.json, scripts/run-mcp.mjs,
  // ...) whose add/remove is NOT reflected in the manifest mtime, so key it on a
  // short TTL instead (~5s, like the skill-file count).
  function cachedMcpDiscovery(root) {
    const now = Date.now();
    const hit = mcpDiscoveryCache.get(root);
    if (hit && (now - hit.at) < 5000) return hit.mcp;
    const mcp = discoverPluginMcp(root);
    mcpDiscoveryCache.set(root, { at: now, mcp });
    return mcp;
  }
  function cachedSkillCount(root) {
    const now = Date.now();
    const hit = skillCountCache.get(root);
    if (hit && (now - hit.at) < 5000) return hit.count;
    const count = countSkillFiles(root);
    skillCountCache.set(root, { at: now, count });
    return count;
  }

  function resolveCwdPath(value) {
    const raw = clean(value);
    if (!raw) throw new Error('cwd: path is required for action=set');
    const next = resolve(getCurrentCwd() || process.cwd(), raw);
    const stat = statSync(next);
    if (!stat.isDirectory()) throw new Error(`cwd: not a directory: ${next}`);
    return next;
  }

  function applyResolvedCwd(nextCwd, { markRefresh = true, waitForMcpReset = false } = {}) {
    const resolved = resolve(nextCwd);
    const stat = statSync(resolved);
    if (!stat.isDirectory()) throw new Error(`cwd: not a directory: ${resolved}`);
    const changed = resolve(getCurrentCwd()) !== resolved;
    setCurrentCwd(resolved);
    const currentCwd = resolved;
    process.env.MIXDOG_SESSION_CWD = currentCwd;
    writeLastSessionCwd(currentCwd);
    const session = getSession();
    if (session) session.cwd = currentCwd;
    // cwd changes NEVER recreate the session: a mid-conversation cwd switch must
    // preserve the full message history (and the BP1–BP3 prompt cache). We only
    // retarget the live session's cwd in place; tool execution already reads the
    // current cwd per turn. `cwd` is intentionally absent from the prompt
    // context (see composeSystemPrompt), so there is nothing prompt-side to
    // refresh either. `markRefresh`/`changed` are kept only for signature
    // compatibility with existing callers.
    void markRefresh;
    // Lazy mode: before the first turn (e.g. the initial project-selection
    // cwd set), do NOT prewarm — that is exactly the post-first-frame freeze
    // we are avoiding. Once a turn has run, an in-session cwd switch DOES
    // prewarm the new dir, since a lookup there is now likely.
    if (isCodeGraphPrewarmLazy() && !isCodeGraphFirstTurnPrewarmDone()) {
      bootProfile('code-graph:prewarm-lazy', { reason: 'cwd-deferred-to-first-turn' });
    } else {
      const delay = getCodeGraphPrewarmDelayMs();
      scheduleCodeGraphPrewarm(changed ? 0 : delay, changed ? 'cwd-change' : 'cwd');
    }
    // Project-local `.mcp.json` follows the cwd. Ordinary in-session cwd changes
    // reconnect in the background, while desktop context replacement requests
    // an awaitable reset so the next session/turn cannot observe the old registry.
    let mcpReset = null;
    if (changed) {
      try {
        const nextKey = resolved + '\u0000' + JSON.stringify(readProjectMcpServers(resolved));
        if (nextKey !== getLastProjectMcpKey()) {
          setLastProjectMcpKey(nextKey);
          mcpReset = Promise.resolve(connectConfiguredMcp({ reset: true }))
            .then(() => invalidatePreSessionToolSurface())
            .catch(() => {});
        }
      } catch {}
    }
    // CwdChanged: bridge an effective cwd switch to the standard hook bus.
    // No matcher event — payload is minimal { cwd }. Fire-and-forget.
    if (changed) {
      try { void hooks.dispatch('CwdChanged', hookCommonPayload({ cwd: currentCwd })); } catch {}
    }
    return waitForMcpReset
      ? Promise.resolve(mcpReset).then(() => currentCwd)
      : currentCwd;
  }

  async function refreshSessionForCwdIfNeeded(reason = 'cwd-change') {
    // No-op: cwd changes are applied in place by applyResolvedCwd and never
    // tear down the session. Retained as a stable hook for ask()'s pre-turn
    // call so the surrounding turn flow is unchanged.
    void reason;
    setSessionNeedsCwdRefresh(false);
    return getSession();
  }

  function pluginsStatus() {
    const config = getConfig();
    const dataDir = cfgMod.getPluginData?.();
    const configuredMcp = config?.mcpServers && typeof config.mcpServers === 'object'
      ? config.mcpServers
      : {};
    const plugins = [];
    const addRegisteredPlugin = (entry) => {
      const root = clean(entry.root);
      if (!root || !existsSync(root)) return;
      const cached = cachedPluginData(root);
      const manifest = cached.manifest;
      const name = clean(manifest.name) || clean(manifest.id) || clean(entry.name) || root.split(/[\\/]/).pop() || root;
      const plugin = {
        id: clean(entry.id) || name,
        name,
        title: clean(manifest.title) || clean(manifest.displayName) || clean(entry.title) || name,
        version: clean(manifest.version) || clean(entry.version) || null,
        description: clean(manifest.description) || clean(entry.description),
        marketplace: null,
        source: clean(entry.sourceType) === 'local' ? 'local' : 'registry',
        sourceUrl: clean(entry.source),
        sourceType: clean(entry.sourceType) || 'git',
        managed: entry.managed !== false,
        root,
        installedAt: entry.installedAt || null,
        updatedAt: entry.updatedAt || null,
        skillCount: cachedSkillCount(root),
        ...(() => {
          const { mcpScript, mcpInline } = cachedMcpDiscovery(root);
          return { mcpScript, mcpInline };
        })(),
      };
      plugin.mcpServerName = pluginMcpServerName(plugin);
      plugin.mcpEnabled = Object.prototype.hasOwnProperty.call(configuredMcp, plugin.mcpServerName)
        || Object.keys(configuredMcp).some((k) => k.startsWith(`${plugin.mcpServerName}--`));
      plugins.push(plugin);
    };

    for (const entry of listRegisteredPlugins({ dataDir })) addRegisteredPlugin(entry);

    plugins.sort((a, b) => {
      if (a.source !== b.source) return a.source.localeCompare(b.source);
      return a.name.localeCompare(b.name);
    });
    const admin = pluginAdminStatus({ dataDir });
    return {
      count: plugins.length,
      plugins,
      roots: {
        registry: admin.registryPath,
        installed: admin.installRoot,
      },
    };
  }

  function formatCoreMemoryLines(payload = {}) {
    const seen = new Set();
    const lines = [];
    for (const value of [
      ...(Array.isArray(payload.userLines) ? payload.userLines : []),
      ...(Array.isArray(payload.dbLines) ? payload.dbLines : []),
    ]) {
      const text = clean(value).replace(/\s+/g, ' ');
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${text}`);
      if (lines.length >= 40) break;
    }
    const out = lines.join('\n');
    const maxChars = 6000;
    return out.length > maxChars ? `${out.slice(0, maxChars).replace(/\s+\S*$/, '')}\n- ...` : out;
  }

  async function loadCoreMemoryContext() {
    // User-curated core memory injects into new sessions by default.
    // Explicit opt-out (MIXDOG_BOOT_CORE_MEMORY=0/false/no/off) skips the
    // memory/PG startup cost; recall and memory tools still initialize the
    // memory service on first use.
    const bootFlag = String(process.env.MIXDOG_BOOT_CORE_MEMORY ?? '').trim().toLowerCase();
    if (bootFlag === '0' || bootFlag === 'false' || bootFlag === 'no' || bootFlag === 'off') {
      bootProfile('core-memory:skipped');
      return '';
    }
    const startedAt = performance.now();
    let timer = null;
    const timeout = new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(''), 2000);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        (async () => {
          const memoryMod = await getMemoryModule();
          if (typeof memoryMod?.buildSessionCoreMemoryPayload !== 'function') return '';
          return formatCoreMemoryLines(await memoryMod.buildSessionCoreMemoryPayload(getCurrentCwd()));
        })(),
        timeout,
      ]);
    } catch {
      return '';
    } finally {
      if (timer) clearTimeout(timer);
      bootProfile('core-memory:done', { ms: (performance.now() - startedAt).toFixed(1) });
    }
  }

  return {
    resolveCwdPath,
    applyResolvedCwd,
    refreshSessionForCwdIfNeeded,
    pluginsStatus,
    formatCoreMemoryLines,
    loadCoreMemoryContext,
  };
}
