/**
 * maintenance-pickers.mjs — Update / Auto-clear / Profile picker cluster.
 *
 * Extracted from App.jsx behavior-preservingly as a dependency-injection
 * factory. These openers drive setPicker + setSettingsPrompt and read live
 * store state, so they can't be pure. Every function body is the original App
 * logic verbatim, with closure identifiers threaded through the factory
 * argument.
 */
export function createMaintenancePickers({
  store,
  theme,
  formatDuration,
  setPicker,
  setProviderPrompt,
  setChannelPrompt,
  setHookPrompt,
  setSettingsPrompt,
  setContextPanel,
  closeUsagePanel,
}) {
  const openUpdatePicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    const readSettings = () => {
      try { return store.getUpdateSettings?.() || {}; } catch { return {}; }
    };
    const readStatus = () => {
      try { return store.getUpdateStatus?.() || { phase: 'idle' }; } catch { return { phase: 'idle' }; }
    };
    const render = ({ checking = false } = {}) => {
      const upd = readSettings();
      const status = readStatus();
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
      setProviderPrompt(null);
      setChannelPrompt(null);
      setHookPrompt(null);
      setSettingsPrompt(null);
      setPicker({
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
          setPicker(null);
          if (returnTo) returnTo();
        },
      });
    };
    const toggleAutoUpdate = (enabled) => {
      try {
        void Promise.resolve(store.setAutoUpdate?.(enabled)).finally(() => render());
        store.pushNotice(`Auto-update ${enabled ? 'on' : 'off'}`, 'info');
      } catch (e) {
        store.pushNotice(`auto-update failed: ${e?.message || e}`, 'error');
      }
      render();
    };
    const recheck = () => {
      render({ checking: true });
      void Promise.resolve(store.checkForUpdate?.({ force: true }))
        .then(() => render())
        .catch((e) => {
          store.pushNotice(`update check failed: ${e?.message || e}`, 'error');
          render();
        });
    };
    const runUpdate = () => {
      store.pushNotice('Updating…', 'info');
      void Promise.resolve(store.runUpdateNow?.())
        .then((result) => {
          if (result?.ok) {
            store.pushNotice(`v${result.version} installed — restart to apply`, 'warn');
          } else {
            store.pushNotice(`Update failed: ${result?.error || 'unknown error'}`, 'error');
          }
          render();
        })
        .catch((e) => {
          store.pushNotice(`Update failed: ${e?.message || e}`, 'error');
          render();
        });
    };
    render({ checking: true });
    void Promise.resolve(store.checkForUpdate?.({}))
      .then(() => render())
      .catch(() => render());
  };

  const openAutoClearPicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
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
    const readCurrent = () => {
      try { return store.getAutoClear?.() || null; } catch { return null; }
    };
    const applyAutoClear = (patch = {}) => {
      try {
        const next = store.setAutoClear?.(patch);
        if (!next) {
          store.pushNotice('autoclear unavailable', 'warn');
          return;
        }
        store.pushNotice(next.enabled ? `autoclear on · idle ${formatDuration(next.idleMs)}` : 'autoclear off', 'info');
      } catch (e) {
        store.pushNotice(`autoclear failed: ${e?.message || e}`, 'error');
      }
      render();
    };
    const openProviderDurationEditor = (entry) => {
      if (!entry?.provider) return;
      setPicker(null);
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
    const renderAdvanced = () => {
      const current = readCurrent();
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
      setPicker({
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
          render();
        },
      });
    };
    const render = () => {
      const current = readCurrent();
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
      setPicker({
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
          setPicker(null);
          if (returnTo) returnTo();
        },
      });
    };
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    if (options.advanced === true) renderAdvanced();
    else render();
  };

  const openProfilePicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    let profile = null;
    try {
      profile = store.getProfile?.() || null;
    } catch {
      profile = null;
    }
    const languages = Array.isArray(profile?.languages) && profile.languages.length
      ? profile.languages
      : [{ id: 'system', label: 'System (locale)' }];
    const currentLangId = profile?.language || 'system';
    const currentLang = languages.find((lang) => lang.id === currentLangId) || languages[0];
    const titleValue = String(profile?.title || '').trim();
    const cycleLanguage = (direction = 1) => {
      const idx = Math.max(0, languages.findIndex((lang) => lang.id === currentLangId));
      const next = languages[(idx + direction + languages.length) % languages.length];
      try {
        store.setProfile?.({ language: next.id });
        store.pushNotice(`Language set to ${next.label}`, 'info');
      } catch (e) {
        store.pushNotice(`profile update failed: ${e?.message || e}`, 'error');
      }
      openProfilePicker({ returnTo });
    };
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    setPicker({
      title: 'Profile',
      description: 'How the assistant addresses you and which language it replies in.',
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
          value: 'language',
          label: 'Language',
          meta: currentLang?.label || 'System (locale)',
          description: 'Response language. ←/→ to change, Enter to cycle.',
          _action: 'language',
        },
      ],
      onLeft: (item) => {
        if (item?._action === 'language') cycleLanguage(-1);
      },
      onRight: (item) => {
        if (item?._action === 'language') cycleLanguage(1);
      },
      onSelect: (_value, item) => {
        if (item?._action === 'title') {
          setPicker(null);
          setSettingsPrompt({
            kind: 'profile-title',
            label: 'Profile · Title',
            hint: 'How should the assistant address you? Leave blank to clear.',
          });
        } else if (item?._action === 'language') {
          cycleLanguage(1);
        }
      },
      onCancel: () => {
        setPicker(null);
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
