// cwd-plugins/cwd-apply.mjs — resolving a requested cwd and retargeting the
// live session to it (project selection persistence, code-graph prewarm,
// CwdChanged hook) without recreating the session.
export function createCwdApply({
  getCurrentCwd,
  setCurrentCwd,
  getSession,
  getDesktopSession,
  setDesktopSession,
  isCodeGraphPrewarmLazy,
  isCodeGraphFirstTurnPrewarmDone,
  getCodeGraphPrewarmDelayMs,
  scheduleCodeGraphPrewarm,
  hooks,
  hookCommonPayload,
  bootProfile,
  writeLastSessionCwd,
  updateCurrentCwdOverride,
  persistSession,
  clean,
  resolve,
  statSync,
}) {
  function resolveCwdPath(value) {
    const raw = clean(value);
    if (!raw) throw new Error('cwd: path is required for action=set');
    const next = resolve(getCurrentCwd() || process.cwd(), raw);
    const stat = statSync(next);
    if (!stat.isDirectory()) throw new Error(`cwd: not a directory: ${next}`);
    return next;
  }

  function persistProjectSelection(session, currentCwd) {
    const desktop = getDesktopSession?.() || session?.desktopSession;
    if (desktop && typeof desktop === 'object') {
      const nextDesktop = { classification: 'project', projectPath: currentCwd };
      setDesktopSession?.(nextDesktop);
      if (session) session.desktopSession = nextDesktop;
    }
    if (session) {
      session.updatedAt = Date.now();
      persistSession(session);
    }
  }

  // cwd changes NEVER recreate the session and never reload MCP or Skills
  // (extension settings are global): a mid-conversation cwd switch must
  // preserve the full message history. The live execution cwd is retargeted in
  // place; the BP3 session snapshot remains the session-start environment.
  function applyResolvedCwd(nextCwd, { persistProjectSelection: persist = false } = {}) {
    const resolved = resolve(nextCwd);
    const stat = statSync(resolved);
    if (!stat.isDirectory()) throw new Error(`cwd: not a directory: ${resolved}`);
    const changed = resolve(getCurrentCwd()) !== resolved;
    setCurrentCwd(resolved);
    const currentCwd = resolved;
    const session = getSession();
    if (session) session.cwd = currentCwd;
    updateCurrentCwdOverride?.(currentCwd);
    writeLastSessionCwd(currentCwd, session?.clientHostPid);
    if (persist) persistProjectSelection(session, currentCwd);
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
    // CwdChanged: bridge an effective cwd switch to the standard hook bus.
    // No matcher event — payload is minimal { cwd }. Fire-and-forget.
    if (changed) {
      try {
        void hooks.dispatch('CwdChanged', hookCommonPayload({ cwd: currentCwd }));
      } catch {}
    }
    return currentCwd;
  }

  return { resolveCwdPath, applyResolvedCwd };
}
