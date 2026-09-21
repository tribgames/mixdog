// maintenance-pickers/auto-clear-picker.mjs
// The Auto-clear panel: the on/off toggle with its lead-cache TTL note, and
// the Advanced list of provider default idle windows edited as text.

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

export function createAutoClearPicker({
  store,
  theme,
  formatDuration,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  closeUsagePanel,
}) {
  const readCurrent = async () => {
    try {
      return (await store.getAutoClear?.()) || null;
    } catch {
      return null;
    }
  };

  const providerDefaultItems = (current) => {
    const provider = current?.provider || 'default';
    const providerDefaults = Array.isArray(current?.providerDefaults) ? current.providerDefaults : [];
    return providerDefaults.map((entry) => ({
      value: `provider:${entry.provider}`,
      label: entry.provider,
      marker: entry.provider === provider ? '✓' : '',
      markerColor: theme.success,
      meta: `${formatDuration(entry.idleMs)}${entry.custom ? ' custom' : ''}`,
      description: `Default idle window for ${entry.provider}. Enter to edit as text.`,
      _action: 'provider-default',
      _entry: entry,
    }));
  };

  const openAutoClearPicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    // Surface claim, same rule as openUpdatePicker: every paint (render() and
    // renderAdvanced()) re-validates and re-arms, so a readCurrent() settling
    // after Esc — on open or on any later toggle — can never paint over the
    // user's surface.
    const own = surface.claim();
    const applyAutoClear = (patch = {}) => {
      // Bound to the claim on this keypress: a write acking after Esc must not
      // re-open the Auto-clear panel.
      const settled = own.defer(() => {
        void Promise.resolve(render()).catch((e) =>
          store.pushNotice(`auto-clear panel failed: ${e?.message || e}`, 'error')
        );
      });
      void Promise.resolve(store.setAutoClear?.(patch))
        .then((next) => {
          if (!next) {
            store.pushNotice('autoclear unavailable', 'warn');
            return;
          }
          store.pushNotice(
            next.enabled ? `autoclear on · idle ${formatDuration(next.idleMs)}` : 'autoclear off',
            'info'
          );
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
      own.paint({
        title: 'Auto-clear · Advanced',
        description: 'Provider default idle windows. Enter edits the duration text.',
        help: '↑/↓ Select · Enter Edit · Esc Back',
        indexMode: 'always',
        labelWidth: 18,
        metaWidth: 18,
        items: providerDefaultItems(current),
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
      own.paint({
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
    return Promise.resolve(options.advanced === true ? renderAdvanced() : render()).catch((e) =>
      store.pushNotice(`auto-clear panel failed: ${e?.message || e}`, 'error')
    );
  };

  return { openAutoClearPicker };
}
