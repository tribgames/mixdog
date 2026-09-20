// maintenance-pickers/update-picker.mjs
// The Update panel: installed/latest versions from the daemon, the
// auto-update toggle, re-check, and the in-place update run.
function updateButtonLabel(installedVersion, status, upd) {
  if (installedVersion) return `v${installedVersion} installed — restart to apply`;
  if (status.phase === 'installing') return 'Installing…';
  return upd.updateAvailable ? `Update to v${upd.latestVersion || 'latest'}` : 'Update now';
}

function updateItems({ upd, status, installedVersion, checking }) {
  const current = upd.currentVersion || 'unknown';
  const latestMeta = checking || status.phase === 'checking' ? 'checking…' : upd.latestVersion || 'unknown';
  return [
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
}

export function createUpdatePicker({ store, surface, setProviderPrompt, setSettingsPrompt }) {
  // Async: both reads are remote calls on a daemon-backed store, so the sync
  // versions rendered every row from an unresolved promise.
  const readSettings = async () => {
    try {
      return (await store.getUpdateSettings?.()) || {};
    } catch {
      return {};
    }
  };
  const readStatus = async () => {
    try {
      return (await store.getUpdateStatus?.()) || { phase: 'idle' };
    } catch {
      return { phase: 'idle' };
    }
  };

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
    const render = async ({ checking = false } = {}) => {
      const [upd, status] = await Promise.all([readSettings(), readStatus()]);
      // After a successful in-place install the running process is still the
      // old version; surface the pending version so "Current" doesn't look
      // stale/broken until restart.
      const installedVersion = status.phase === 'installed' ? status.version || upd.latestVersion || null : null;
      return paintPanel({
        title: 'Update',
        description: 'Check version and update mixdog.',
        help: '↑/↓ Select · Enter Open/Toggle · Esc Close',
        indexMode: 'always',
        labelWidth: 16,
        metaWidth: 16,
        items: updateItems({ upd, status, installedVersion, checking }),
        confirmBar: {
          buttons: [
            {
              value: 'update-now',
              label: updateButtonLabel(installedVersion, status, upd),
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
      void Promise.resolve(render(opts)).catch((e) =>
        store.pushNotice(`update panel failed: ${e?.message || e}`, 'error')
      );
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
    return Promise.resolve(render({ checking: true }))
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

  return { openUpdatePicker };
}
