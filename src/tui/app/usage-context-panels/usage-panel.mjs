// /usage panel: opens the provider-quota dashboard under a usage claim and
// streams its updates until Esc or a newer /usage invalidates the claim.

export function createUsagePanelOpener({ store, surface, setProviderPrompt, setSettingsPrompt, closeUsagePanel }) {
  return (arg = '') => {
    const refresh = /(?:^|\s)(?:refresh|--refresh|-r|true)(?:\s|$)/i.test(String(arg || ''));
    const own = surface.claim();
    // The dashboard streams updates for seconds: they paint through a usage
    // claim, which closeUsagePanel (Esc) and any newer /usage invalidate.
    const dashboardOwn = surface.claimUsage();
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.paint(null);
    own.context(null);
    dashboardOwn.paint({
      title: 'Provider Quotas',
      subtitle: 'Statusline-style provider quota windows.',
      checking: true,
      refresh,
      rows: [],
      total: null,
    });
    setTimeout(() => {
      if (!dashboardOwn.owns()) return;
      void store
        .getUsageDashboard?.({
          refresh,
          onUpdate: (dashboard) => {
            if (dashboard) dashboardOwn.paint(dashboard);
          },
        })
        .then((dashboard) => {
          if (!dashboardOwn.owns()) return;
          if (!dashboard) {
            closeUsagePanel();
            store.pushNotice('usage dashboard unavailable', 'warn');
            return;
          }
          dashboardOwn.paint(dashboard);
        })
        .catch((e) => {
          if (!dashboardOwn.owns()) return;
          closeUsagePanel();
          store.pushNotice(`usage failed: ${e?.message || e}`, 'error');
        });
    }, 0);
  };
}
