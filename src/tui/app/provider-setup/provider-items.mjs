// provider-setup/provider-items.mjs
// Pure helpers of the Provider setup picker: which providers count as active,
// the status footer, the key-console URL, and the sorted provider rows of the
// main list.
import { theme } from '../../theme.mjs';
import { providerStatusLabel, providerDetailText, providerKindLabel } from '../app-format.mjs';
import { providerDisplayRank } from '../model-options.mjs';

export const keyConsoleUrl = (provider) => {
  const url = String(provider?.url || '').trim();
  return /^https:\/\//.test(url) ? url : '';
};

export const providerIsActive = (provider) =>
  provider?.reauthRequired !== true &&
  (provider?.usable === true ||
    (provider?.usable == null && (provider?.enabled || provider?.authenticated || provider?.detected)));

/** Footer rows for one provider: the active glyph plus kind · status · detail. */
export const providerStatusFooter = (provider) => {
  if (!provider) return '';
  const active = providerIsActive(provider);
  return [
    {
      glyph: active ? '●' : '○',
      color: active ? theme.success : theme.inactive,
      text: [providerKindLabel(provider), providerStatusLabel(provider), providerDetailText(provider)]
        .filter(Boolean)
        .join(' · '),
    },
  ];
};

const providerItemRank = (item) => providerDisplayRank(item._providerId || item.value);

/** The provider rows of the main list — API-key and OAuth providers together —
 *  in display rank, then label order. */
export function buildProviderItems(setup) {
  const providerItems = [];
  for (const p of setup.api || []) {
    providerItems.push({
      value: `api:${p.id}`,
      label: p.name,
      meta: providerStatusLabel(p),
      description: '',
      _type: 'api-key',
      _providerId: p.id,
      _providerName: p.name,
      _provider: p,
      _authenticated: p.authenticated,
      _url: p.url,
    });
  }
  for (const p of setup.oauth || []) {
    providerItems.push({
      value: `oauth:${p.id}`,
      label: p.name,
      meta: providerStatusLabel(p),
      description: '',
      _type: 'oauth',
      _providerId: p.id,
      _providerName: p.name,
      _provider: p,
      _authenticated: p.authenticated,
    });
  }
  providerItems.sort((a, b) => {
    const rank = providerItemRank(a) - providerItemRank(b);
    if (rank !== 0) return rank;
    return String(a.label || '').localeCompare(String(b.label || ''), 'en', { sensitivity: 'base' });
  });
  return providerItems;
}

/** Index of the remembered provider row, or the top when none is remembered. */
export const providerMainInitialIndex = (items, value) => {
  if (!value) return 0;
  const idx = items.findIndex((item) => item.value === value);
  return idx >= 0 ? idx : 0;
};
