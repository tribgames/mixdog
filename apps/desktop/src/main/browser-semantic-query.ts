export type BrowserSemanticMatchField = 'name' | 'value' | 'role' | 'href';

export interface BrowserSemanticMatch {
  field: BrowserSemanticMatchField;
  score: number;
}

const ROLE_PRIORITY: Record<string, number> = {
  link: 40,
  button: 35,
  menuitem: 30,
  menuitemcheckbox: 30,
  menuitemradio: 30,
  tab: 25,
  option: 20,
  checkbox: 15,
  radio: 15,
  switch: 15,
  combobox: 10,
  listbox: 10,
  searchbox: 10,
  textbox: 10,
};

function normalized(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function semanticHrefText(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return normalized(`${parsed.hostname}${decodeURIComponent(parsed.pathname)}`);
  } catch {
    return normalized(raw.split(/[?#]/, 1)[0]);
  }
}

export function rankBrowserSemanticMatch(
  queryValue: unknown,
  fields: {
    name?: unknown;
    value?: unknown;
    role?: unknown;
    href?: unknown;
  },
): BrowserSemanticMatch | null {
  const query = normalized(queryValue);
  if (!query) return { field: 'name', score: 0 };
  const role = normalized(fields.role);
  const rolePriority = ROLE_PRIORITY[role] || 0;
  const candidates: Array<[BrowserSemanticMatchField, string, number]> = [
    ['name', normalized(fields.name), 400],
    ['value', normalized(fields.value), 300],
    ['role', normalized(fields.role), 200],
    ['href', semanticHrefText(fields.href), role === 'link' ? 330 : 100],
  ];
  const matches: BrowserSemanticMatch[] = [];
  for (const [field, value, base] of candidates) {
    if (!value.includes(query)) continue;
    matches.push({
      field,
      score: base + rolePriority + (value === query ? 20 : value.startsWith(query) ? 10 : 0),
    });
  }
  return matches.sort((left, right) => right.score - left.score)[0] || null;
}
