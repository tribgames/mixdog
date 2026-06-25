/**
 * Terminal-safe UI text normalization.
 *
 * Keep user/content Unicode intact (Korean, paths, code, etc.). Mixdog's own
 * decorative glyphs can be downgraded to ASCII for legacy/codepage terminals by
 * setting MIXDOG_ASCII_UI=1; modern terminals keep the Claude Code-like glyphs.
 */

export function asciiUiEnabled() {
  const raw = String(process.env.MIXDOG_ASCII_UI || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

const UI_REPLACEMENTS = [
  [/[ \t]*·[ \t]*/g, ' - '],
  [/…/g, '...'],
  [/⎿/g, '>'],
  [/❯|›/g, '>'],
  [/→/g, '->'],
  [/←/g, '<-'],
  [/↑/g, '^'],
  [/↓/g, 'v'],
  [/✓/g, 'ok'],
  [/✕|✗|✖/g, 'x'],
  [/●|○|◐|◉|◇|◆|◈|▣|※|⚑|∴|∙|✻/g, '*'],
  [/▶/g, '>'],
  [/⏸/g, '|'],
  [/▾/g, 'v'],
  [/▸/g, '>'],
  [/▎/g, '|'],
  [/━/g, '-'],
  [/│/g, '|'],
  [/↯/g, '!'],
  [/↻/g, '~'],
  [/⑂/g, 'Y'],
];

export function terminalSafeText(value) {
  let text = String(value ?? '');
  if (!asciiUiEnabled()) return text;
  for (const [pattern, replacement] of UI_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}
