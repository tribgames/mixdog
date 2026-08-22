/**
 * maintenance-pickers.mjs — Update / Auto-clear / Profile picker cluster.
 *
 * Extracted from App.jsx behavior-preservingly as a dependency-injection
 * factory. These openers drive the panel surface + setSettingsPrompt and read
 * live store state, so they can't be pure. Every function body is the original
 * App logic verbatim, with closure identifiers threaded through the factory
 * argument.
 */
export function createMaintenancePickers({
  store,
  theme,
  formatDuration,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  closeUsagePanel,
}) {
  const openUpdatePicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    // Surface claim for this panel, taken at the user's open action — BEFORE
    // the first daemon read. Every paint through it re-validates and re-arms,
    // so a re-check or install settling after Esc cannot paint over whatever
    // the user is looking at now.
    const own = surface.claim();
    const paintPanel = (panel) => {
      if (!own.owns()) return false;
      setProviderPrompt(null);
      setSettingsPrompt(null);
      return own.paint(panel);
    };
    // Async: both reads are remote calls on a daemon-backed store, so the sync
    // versions rendered every row from an unresolved promise.
    const readSettings = async () => {
      try { return (await store.getUpdateSettings?.()) || {}; } catch { return {}; }
    };
    const readStatus = async () => {
      try { return (await store.getUpdateStatus?.()) || { phase: 'idle' }; } catch { return { phase: 'idle' }; }
    };
    const render = async ({ checking = false } = {}) => {
      const [upd, status] = await Promise.all([readSettings(), readStatus()]);
      const current = upd.currentVersion || 'unknown';
      // After a successful in-place install the running process is still the
      // old version; surface the pending version so "Current" doesn't look
      // stale/broken until restart.
      const installedVersion = status.phase === 'installed' ? (status.version || upd.latestVersion || null) : null;
      const latestMeta = checking || status.phase === 'checking'
        ? 'checking…'
        : (upd.latestVersion || 'unknown');
      const items = [
        {
          value: 'current',
          label: 'Current version',
          meta: installedVersion ? `${current} → ${installedVersion}` : current,
          description: installedVersion
            ? `v${installedVersion} installed — restart mixdog to apply.`
            : 'Installed mixdog version.',
          _action: 'current',
        },
        {
          value: 'latest',
          label: 'Latest version',
          meta: latestMeta,
          description: 'Enter to re-check now.',
          _action: 'latest',
        },
        {
          value: 'auto-update',
          label: 'Auto-update',
          meta: upd.autoUpdate ? 'On' : 'Off',
          description: 'Enter to toggle automatic updates.',
          _action: 'auto-update',
        },
      ];
      return paintPanel({
        title: 'Update',
        description: 'Check version and update mixdog.',
        help: '↑/↓ Select · Enter Open/Toggle · Esc Close',
        indexMode: 'always',
        labelWidth: 16,
        metaWidth: 16,
        items,
        confirmBar: {
          buttons: [
            {
              value: 'update-now',
              label: installedVersion
                ? `v${installedVersion} installed — restart to apply`
                : (status.phase === 'installing'
                  ? 'Installing…'
                  : (upd.updateAvailable
                    ? `Update to v${upd.latestVersion || 'latest'}`
                    : 'Update now')),
            },
          ],
          onConfirm: (button) => {
            if (button?.value === 'update-now' && !installedVersion && status.phase !== 'installing') runUpdate();
          },
        },
        onSelect: (_value, item) => {
          if (item?._action === 'latest') {
            recheck();
          } else if (item?._action === 'auto-update') {
            toggleAutoUpdate(!upd.autoUpdate);
          }
        },
        onCancel: () => {
          own.close();
          if (returnTo) returnTo();
        },
      });
    };
    // Every render() is an async daemon read; a detached call would surface a
    // failed read as an unhandled rejection (fatal for the TUI process).
    const rerender = (opts = {}) => {
      void Promise.resolve(render(opts))
        .catch((e) => store.pushNotice(`update panel failed: ${e?.message || e}`, 'error'));
    };
    // Deferred repaint bound to the claim AT ACTION TIME: a check/install that
    // settles after Esc must not re-open the Update panel.
    const deferredRerender = (opts = {}) => own.defer(() => rerender(opts));
    const toggleAutoUpdate = (enabled) => {
      // Persisted by the daemon: only claim the new value once it is written.
      void Promise.resolve(store.setAutoUpdate?.(enabled))
        .then(() => store.pushNotice(`Auto-update ${enabled ? 'on' : 'off'}`, 'info'))
        .catch((e) => store.pushNotice(`auto-update failed: ${e?.message || e}`, 'error'))
        .finally(deferredRerender());
    };
    const recheck = () => {
      rerender({ checking: true });
      const settled = deferredRerender();
      void Promise.resolve(store.checkForUpdate?.({ force: true }))
        .then(() => settled())
        .catch((e) => {
          store.pushNotice(`update check failed: ${e?.message || e}`, 'error');
          settled();
        });
    };
    const runUpdate = () => {
      store.pushNotice('Updating…', 'info');
      const settled = deferredRerender();
      void Promise.resolve(store.runUpdateNow?.())
        .then((result) => {
          if (result?.ok) {
            store.pushNotice(`v${result.version} installed — restart to apply`, 'warn');
          } else {
            store.pushNotice(`Update failed: ${result?.error || 'unknown error'}`, 'error');
          }
          settled();
        })
        .catch((e) => {
          store.pushNotice(`Update failed: ${e?.message || e}`, 'error');
          settled();
        });
    };
    // First paint, THEN the initial check. The repaint epoch is captured after
    // this panel has taken the surface: capturing it before the first paint
    // binds it to the previous owner's epoch, which the open transition (a
    // panel identity change) supersedes — leaving "Latest version" stuck on
    // "checking…". Esc after the paint still closes the panel for good.
    void Promise.resolve(render({ checking: true }))
      .catch((e) => {
        store.pushNotice(`update panel failed: ${e?.message || e}`, 'error');
        return false;
      })
      .then((painted) => {
        // Open abandoned (Esc while the first read was pending): the panel
        // never took the surface, so the check result must not paint it either.
        if (!painted) return;
        const initialChecked = deferredRerender();
        void Promise.resolve(store.checkForUpdate?.({}))
          .then(() => initialChecked())
          .catch(() => initialChecked());
      });
  };

  const openAutoClearPicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    // Surface claim, same rule as openUpdatePicker: every paint (render() and
    // renderAdvanced()) re-validates and re-arms, so a readCurrent() settling
    // after Esc — on open or on any later toggle — can never paint over the
    // user's surface.
    const own = surface.claim();
    const paintPanel = (panel) => own.paint(panel);
    // Lead BP4 messages cache TTL follows autoClear (cache-strategy.mjs
    // resolveLeadMessagesTtl): off or idle>=1h -> 1h, shorter idle -> 5m.
    const HOUR_MS = 60 * 60 * 1000;
    const formatDurationInput = (ms) => {
      const value = Math.max(0, Math.round(Number(ms) || 0));
      if (value > 0 && value % HOUR_MS === 0) return `${value / HOUR_MS}h`;
      if (value > 0 && value % 60_000 === 0) return `${value / 60_000}m`;
      if (value > 0 && value % 1000 === 0) return `${value / 1000}s`;
      return `${value}ms`;
    };
    const readCurrent = async () => {
      try { return (await store.getAutoClear?.()) || null; } catch { return null; }
    };
    const applyAutoClear = (patch = {}) => {
      // Bound to the claim on this keypress: a write acking after Esc must not
      // re-open the Auto-clear panel.
      const settled = own.defer(() => {
        void Promise.resolve(render())
          .catch((e) => store.pushNotice(`auto-clear panel failed: ${e?.message || e}`, 'error'));
      });
      void Promise.resolve(store.setAutoClear?.(patch))
        .then((next) => {
          if (!next) {
            store.pushNotice('autoclear unavailable', 'warn');
            return;
          }
          store.pushNotice(next.enabled ? `autoclear on · idle ${formatDuration(next.idleMs)}` : 'autoclear off', 'info');
        })
        .catch((e) => store.pushNotice(`autoclear failed: ${e?.message || e}`, 'error'))
        .finally(settled);
    };
    const openProviderDurationEditor = (entry) => {
      if (!entry?.provider) return;
      own.close();
      setSettingsPrompt({
        kind: 'autoclear-provider',
        label: `Auto-clear · ${entry.provider}`,
        hint: `Type a duration like 10m, 1h, or 24h. Empty resets to built-in ${formatDurationInput(entry.builtInMs)}.`,
        initialValue: formatDurationInput(entry.idleMs),
        provider: entry.provider,
        builtInMs: entry.builtInMs,
        returnTo,
      });
    };
    const renderAdvanced = async () => {
      const current = await readCurrent();
      const provider = current?.provider || 'default';
      const providerDefaults = Array.isArray(current?.providerDefaults) ? current.providerDefaults : [];
      const items = providerDefaults.map((entry) => ({
        value: `provider:${entry.provider}`,
        label: entry.provider,
        marker: entry.provider === provider ? '✓' : '',
        markerColor: theme.success,
        meta: `${formatDuration(entry.idleMs)}${entry.custom ? ' custom' : ''}`,
        description: `Default idle window for ${entry.provider}. Enter to edit as text.`,
        _action: 'provider-default',
        _entry: entry,
      }));
      paintPanel({
        title: 'Auto-clear · Advanced',
        description: 'Provider default idle windows. Enter edits the duration text.',
        help: '↑/↓ Select · Enter Edit · Esc Back',
        indexMode: 'always',
        labelWidth: 18,
        metaWidth: 18,
        items,
        onSelect: (_value, item) => {
          if (item?._action === 'provider-default') openProviderDurationEditor(item._entry);
        },
        onCancel: () => {
          void render();
        },
      });
    };
    const render = async () => {
      const current = await readCurrent();
      const enabled = current?.enabled !== false;
      const idleMs = Number(current?.idleMs || HOUR_MS);
      const cacheTtlLabel = !enabled || idleMs >= HOUR_MS ? '1h' : '5m';
      const items = [
        {
          value: 'toggle',
          label: 'Auto-clear',
          meta: enabled ? 'On' : 'Off',
          description: enabled
            ? `Clear idle sessions after ${formatDuration(idleMs)} · lead cache TTL ${cacheTtlLabel}.`
            : 'Idle auto-clear disabled.',
          _action: 'toggle',
        },
        {
          value: 'advanced',
          label: 'Advanced',
          description: 'Edit provider-paired default idle windows as text.',
          _action: 'advanced',
        },
      ];
      paintPanel({
        title: 'Auto-clear',
        description: `Clear idle context after ${enabled ? formatDuration(idleMs) : 'never'} · lead cache TTL ${cacheTtlLabel}.`,
        help: '↑/↓ Select · ←/→ Toggle On/Off · Enter Open/Toggle · Esc Close',
        indexMode: 'always',
        labelWidth: 10,
        items,
        onLeft: (item) => {
          if (item?._action === 'toggle') applyAutoClear({ enabled: false });
        },
        onRight: (item) => {
          if (item?._action === 'toggle') applyAutoClear({ enabled: true });
        },
        onSelect: (_value, item) => {
          if (item?._action === 'toggle') {
            applyAutoClear({ enabled: !enabled });
          } else if (item?._action === 'advanced') {
            renderAdvanced();
          }
        },
        onCancel: () => {
          own.close();
          if (returnTo) returnTo();
        },
      });
    };
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.context(null);
    closeUsagePanel();
    if (options.advanced === true) renderAdvanced();
    else render();
  };

  const openProfilePicker = async (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    // Surface claim (panel-surface.mjs): getProfile() is a daemon read, so Esc
    // can land before the first paint.
    const own = surface.claim();
    let profile = null;
    try {
      profile = (await store.getProfile?.()) || null;
    } catch {
      profile = null;
    }
    const languages = Array.isArray(profile?.languages) && profile.languages.length
      ? profile.languages
      : [{ id: 'system', label: 'System (locale)' }];
    const currentLangId = profile?.language || 'system';
    const currentLang = languages.find((lang) => lang.id === currentLangId) || languages[0];
    const experienceLevels = Array.isArray(profile?.experienceLevels) && profile.experienceLevels.length
      ? profile.experienceLevels
      : [
          { id: 'beginner', label: 'Beginner' },
          { id: 'vibe-coder', label: 'Vibe coder' },
          { id: 'junior', label: 'Junior' },
          { id: 'expert', label: 'Expert' },
        ];
    const currentExperienceLevelId = profile?.experienceLevel || '';
    const currentExperienceLevel = experienceLevels.find((level) => level.id === currentExperienceLevelId) || null;
    const titleValue = String(profile?.title || '').trim();
    // setProfile is a daemon write: rebuild the panel only after it settles so
    // the row cannot show a value the daemon rejected (and so a rejected write
    // cannot escape as an unhandled rejection).
    // Bound to the claim when the cycle keypress builds its chain: a setProfile
    // that acks after Esc must not re-open the Profile panel.
    const reopenProfile = () => own.defer(() => {
      void Promise.resolve(openProfilePicker({ returnTo }))
        .catch((e) => store.pushNotice(`profile panel failed: ${e?.message || e}`, 'error'));
    });
    const cycleLanguage = (direction = 1) => {
      const idx = Math.max(0, languages.findIndex((lang) => lang.id === currentLangId));
      const next = languages[(idx + direction + languages.length) % languages.length];
      void Promise.resolve(store.setProfile?.({ language: next.id }))
        .then(() => store.pushNotice(`Language set to ${next.label}`, 'info'))
        .catch((e) => store.pushNotice(`profile update failed: ${e?.message || e}`, 'error'))
        .finally(reopenProfile());
    };
    const cycleExperienceLevel = (direction = 1) => {
      const idx = experienceLevels.findIndex((level) => level.id === currentExperienceLevelId);
      const nextIdx = idx < 0
        ? (direction < 0 ? experienceLevels.length - 1 : 0)
        : (idx + direction + experienceLevels.length) % experienceLevels.length;
      const next = experienceLevels[nextIdx];
      void Promise.resolve(store.setProfile?.({ experienceLevel: next.id }))
        .then(() => store.pushNotice(`Experience level set to ${next.label}`, 'info'))
        .catch((e) => store.pushNotice(`profile update failed: ${e?.message || e}`, 'error'))
        .finally(reopenProfile());
    };
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.context(null);
    closeUsagePanel();
    own.paint({
      title: 'Profile',
      description: 'How the assistant addresses you, adapts terminology, and chooses its response language.',
      help: '↑/↓ Select · ←/→ Change · Enter Edit · Esc Close',
      indexMode: 'always',
      labelWidth: 12,
      metaWidth: 20,
      items: [
        {
          value: 'title',
          label: 'Title',
          meta: titleValue || '(not set)',
          description: 'Preferred form of address. Enter to edit.',
          _action: 'title',
        },
        {
          value: 'experience-level',
          label: 'Experience',
          meta: currentExperienceLevel?.label || '(not set)',
          description: 'Development experience. ←/→ to change, Enter to cycle.',
          _action: 'experience-level',
        },
        {
          value: 'language',
          label: 'Language',
          meta: currentLang?.label || 'System (locale)',
          description: 'Response language. ←/→ to change, Enter to cycle.',
          _action: 'language',
        },
      ],
      onLeft: (item) => {
        if (item?._action === 'language') cycleLanguage(-1);
        else if (item?._action === 'experience-level') cycleExperienceLevel(-1);
      },
      onRight: (item) => {
        if (item?._action === 'language') cycleLanguage(1);
        else if (item?._action === 'experience-level') cycleExperienceLevel(1);
      },
      onSelect: (_value, item) => {
        if (item?._action === 'title') {
          own.close();
          setSettingsPrompt({
            kind: 'profile-title',
            label: 'Profile · Title',
            hint: 'How should the assistant address you? Leave blank to clear.',
          });
        } else if (item?._action === 'language') {
          cycleLanguage(1);
        } else if (item?._action === 'experience-level') {
          cycleExperienceLevel(1);
        }
      },
      onCancel: () => {
        own.close();
        if (returnTo) returnTo();
      },
    });
  };

  return {
    openUpdatePicker,
    openAutoClearPicker,
    openProfilePicker,
  };
}
