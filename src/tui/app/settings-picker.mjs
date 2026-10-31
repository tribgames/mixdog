/**
 * settings-picker.mjs — the SETTINGS picker cluster.
 *
 * A dependency-injection factory. openSettingsPicker takes a build ticket,
 * claims the surface, reads ONE settings snapshot and paints the rows
 * (settings-picker/settings-rows); ←/→ writes live in settings-toggles and
 * Enter navigation in settings-navigation. openSettingsPicker self-references
 * (for light refresh) via the local const; all other openers it routes to are
 * threaded as lazy getter wrappers so they resolve the live binding at call
 * time.
 */
import { settingsHandoffPanel, createSettingsNavigation } from './settings-picker/settings-navigation.mjs';
import { buildSettingsItems, readSettingsView } from './settings-picker/settings-rows.mjs';
import { createSettingsToggles } from './settings-picker/settings-toggles.mjs';

// The factory is rebuilt every render, so the heavy-read gate lives beside the
// App-owned cache ref it protects: `running` is the one heavy read in flight,
// `queued` the single follow-up owed to changes that arrived meanwhile, and
// `freshWrites` counts heavy reads that wrote the cache.
const heavyGates = new WeakMap();
const heavyGateOf = (cacheRef) => {
  if (!heavyGates.has(cacheRef)) heavyGates.set(cacheRef, { running: false, queued: false, freshWrites: 0 });
  return heavyGates.get(cacheRef);
};

export function createSettingsPicker({
  store,
  state,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  settingsHeavyCacheRef,
  settingsRequestRef,
  settingsLiveRefreshRef,
  formatDuration,
  displayModelName,
  routeModelLabel,
  workflowDisplayName,
  workflowSwitchNotice,
  themeNotice,
  ...openers
}) {
  // Build generation guard. Every open/refresh takes a ticket and Esc bumps it,
  // so a slow snapshot from a superseded (or already closed) build can never
  // re-open Settings. The ref is owned by App so it survives this per-render
  // factory; a missing ref degrades to "always current".
  const nextSettingsRequest = () => {
    if (!settingsRequestRef) return 0;
    settingsRequestRef.current = (Number(settingsRequestRef.current) || 0) + 1;
    return settingsRequestRef.current;
  };
  const isCurrentSettingsRequest = (requestId) => !settingsRequestRef || settingsRequestRef.current === requestId;

  const buildSettingsPicker = async (opts = {}, requestId = 0) => {
    // Surface claim (panel-surface.mjs), taken before the snapshot await. The
    // request ticket above only invalidates builds that Settings' own Esc
    // bumped; a close/handover of ANOTHER surface while this open is pending is
    // caught here instead.
    const own = surface.claim();
    const light = opts.light === true;
    // A full Settings open usually follows another option panel. Paint the
    // destination synchronously before the daemon snapshot so the empty-chat
    // welcome logo cannot appear between the old panel and Settings.
    if (!light && !own.paint(settingsHandoffPanel())) return;
    // `heavy` re-reads MCP/plugin/skill status even on a light (no handoff
    // paint) build: the cached values would otherwise win over a fresh snapshot.
    const heavyCache = light && opts.heavy !== true ? settingsHeavyCacheRef.current : null;
    // ONE round-trip for the whole panel: on a daemon-backed store each getter
    // below is a serialized remote call, and reading them synchronously handed
    // back promises (every row rendered its default). getSettingsSnapshot runs
    // the same getters engine-side and answers once.
    const gate = heavyGateOf(settingsHeavyCacheRef);
    const freshWritesAtStart = gate.freshWrites;
    const snapshot = (await store.getSettingsSnapshot?.({ heavy: !heavyCache })) || {};
    const view = readSettingsView({ snapshot, heavyCache, state }); // A superseded build (newer open/refresh) or one whose panel was already
    // closed with Esc must never paint, clear prompts or write the cache: an
    // older response settling late would otherwise roll the cache back for
    // every later light refresh.
    if (!isCurrentSettingsRequest(requestId)) {
      // Its fresh heavy rows were dropped; unless a newer heavy read already
      // refreshed the cache, owe the still-open panel one follow-up read.
      if (!heavyCache && own.owns() && gate.freshWrites === freshWritesAtStart) gate.queued = true;
      return;
    }
    if (!own.owns()) return;
    // Refresh the cache every build (light or full) so the next light
    // refresh reuses whatever was most recently known.
    settingsHeavyCacheRef.current = { mcp: view.mcp, plugins: view.plugins, skills: view.skills };
    if (!heavyCache) gate.freshWrites += 1;
    const toggles = createSettingsToggles({
      store,
      view,
      formatDuration,
      workflowSwitchNotice,
      themeNotice,
      // Post-write refresh, bound to the claim AT ACTION TIME. Esc only
      // invalidates builds that already exist, so a write settling afterwards
      // would otherwise take a fresh generation and re-open the panel the user
      // just closed. Called while BUILDING each chain, so the binding happens on
      // the user's keypress, not on the ack.
      deferredSettingsRefresh: () => own.defer(() => refreshSettings()),
      refreshSettings,
    });
    const items = buildSettingsItems({
      snapshot,
      view,
      state,
      store,
      formatDuration,
      displayModelName,
      routeModelLabel,
      workflowDisplayName,
    });
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.paint({
      title: 'Settings',
      description: 'Runtime, model, tools, and integrations.',
      help: '↑/↓ Select · ←/→ Change · Enter Open/Toggle · Esc Close',
      indexMode: 'always',
      labelWidth: 18,
      metaWidth: 18,
      items,
      initialIndex: opts.focus
        ? Math.max(
            0,
            items.findIndex((item) => item.value === opts.focus)
          )
        : undefined,
      onLeft: (item) => toggles.cycleRow(item, -1),
      onRight: (item) => toggles.cycleRow(item, 1),
      onSelect: (_value, item) => {
        if (!toggles.toggleRow(item)) navigation.openRow(item, { own, systemShell: view.systemShell });
      },
      onCancel: () => {
        // Invalidate in-flight builds: Esc must win over a slow snapshot.
        nextSettingsRequest();
        own.close();
      },
    });
    // A settings change from elsewhere re-reads this panel while it is still
    // the one on screen (the claim's epoch guards a closed or replaced panel).
    // The change names no section (MCP servers, plugins and skills may have
    // moved), so unlike a post-write refresh it re-reads the heavy rows too.
    if (settingsLiveRefreshRef) settingsLiveRefreshRef.current = own.defer(() => refreshSettings({ heavy: true }));
  };

  // Public entry point. NEVER rejects: callers fire it detached
  // (`void openSettingsPicker({ light: true })`, returnTo/onCancel handlers),
  // so a failed daemon read must surface as a notice, not as a fatal
  // unhandled rejection.
  const openSettingsPicker = async (opts = {}) => {
    const requestId = nextSettingsRequest();
    try {
      await buildSettingsPicker(opts, requestId);
    } catch (error) {
      store.pushNotice(`settings unavailable: ${error?.message || error}`, 'error');
    }
  };
  // One heavy read at a time; changes arriving meanwhile share a single
  // follow-up, which goes through the live-refresh callback so it is a no-op
  // once the panel was closed or replaced.
  const refreshHeavy = () => {
    const gate = heavyGateOf(settingsHeavyCacheRef);
    if (gate.running) {
      gate.queued = true;
      return;
    }
    gate.running = true;
    void openSettingsPicker({ light: true, heavy: true }).finally(() => {
      gate.running = false;
      if (!gate.queued) return;
      gate.queued = false;
      settingsLiveRefreshRef?.current?.();
    });
  };
  const refreshSettings = ({ heavy = false } = {}) => {
    if (heavy) refreshHeavy();
    else void openSettingsPicker({ light: true });
  };
  const navigation = createSettingsNavigation({ openers, openSettingsPicker, setSettingsPrompt });

  return { openSettingsPicker };
}
