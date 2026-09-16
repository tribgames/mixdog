import { useSyncExternalStore } from 'react';
import type { DesktopPromptContent } from '../shared/contract';
import { isBuiltInSkill, skillDisplayDescription } from './skill-presentation';
import { t } from './i18n';
import { skillSelectionHeader } from '../../../../src/runtime/shared/skill-selection.mjs';

export type ComposerSkill = { name: string; description: string };
// Thunks, not literals: the key must be a static t() argument for extraction
// (`npm run i18n:sync`) to find it, and the call has to run after the catalog
// loads rather than at module evaluation. Format and product names such as PDF
// or Word stay neutral through ui-untranslated-allowlist.json.
const TITLES: Record<string, () => string> = {
  pdf: () => t('PDF'), pptx: () => t('PPT'), docx: () => t('Word'), xlsx: () => t('Excel'),
  image: () => t('Image'), video: () => t('Video'), 'browser-use': () => t('Browser Use'),
  'computer-use': () => t('Computer Use'), 'goal-management': () => t('Goal'),
  'history-recall': () => t('History recall'), 'memory-management': () => t('Memory'),
  'local-provider': () => t('Local Provider'), setup: () => t('Settings'),
  'skill-creator': () => t('Create skill'),
  'code-tidy': () => t('Code Tidy'),
};
export const skillTitle = (name: string) => Object.hasOwn(TITLES, name) ? TITLES[name]() : name;

export function shouldRemoveSelectedSkill(input: {
  selected: string; key: string; start: number; end: number;
  composing: boolean; repeat?: boolean; modified?: boolean;
}): boolean {
  return Boolean(input.selected) && input.key === 'Backspace'
    && input.start === 0 && input.end === 0
    && !input.composing && !input.repeat && !input.modified;
}

// The add menu already has a dedicated "Set a goal" entry that opens the goal
// form directly; listing the shipped goal-management skill beside it would
// show two same-named items with different behaviour. The skill itself stays
// loadable by the model.
const MENU_HIDDEN_BUILTIN_SKILLS = new Set(['goal-management']);

export function selectableComposerSkills(value: unknown): ComposerSkill[] {
  const status = value as { skills?: Array<{ name?: unknown; description?: unknown; enabled?: boolean; source?: unknown; owner?: unknown }> } | null;
  const seen = new Set<string>();
  // Shipped skills lead the menu; custom ones follow. Both groups keep the
  // order the daemon reported, so the list stays stable between openings.
  const builtin: ComposerSkill[] = [];
  const custom: ComposerSkill[] = [];
  for (const skill of Array.isArray(status?.skills) ? status.skills : []) {
    const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
    if (!name || skill.enabled !== true || seen.has(name)) continue;
    seen.add(name);
    const shipped = isBuiltInSkill(skill);
    if (shipped && MENU_HIDDEN_BUILTIN_SKILLS.has(name)) continue;
    (shipped ? builtin : custom).push({ name, description: skillDisplayDescription(skill) });
  }
  return [...builtin, ...custom];
}

export function withSelectedSkill(content: DesktopPromptContent, name: string): DesktopPromptContent {
  if (!name) return content;
  // The runtime prepares explicit selections before the first model request,
  // using the normal Skill policy/dependency checks.
  const instruction = skillSelectionHeader(name);
  return typeof content === 'string' ? instruction + content
    : [{ type: 'text', text: instruction }, ...content];
}

const selections = new Map<string, string>();
const listeners = new Set<() => void>();
function readSelection(scope: string) {
  if (!selections.has(scope)) {
    let value = '';
    try { value = sessionStorage.getItem(`mixdog:composer-skill:${scope}`) || ''; } catch { /* memory-only host */ }
    selections.set(scope, value);
  }
  return selections.get(scope) || '';
}
function writeSelection(scope: string, name: string) {
  selections.set(scope, name);
  try {
    if (name) sessionStorage.setItem(`mixdog:composer-skill:${scope}`, name);
    else sessionStorage.removeItem(`mixdog:composer-skill:${scope}`);
  } catch { /* memory-only host */ }
  for (const notify of listeners) notify();
}
const subscribe = (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; };
export function useComposerSkill(scope: string) {
  const name = useSyncExternalStore(subscribe, () => readSelection(scope), () => '');
  return {
    name,
    select: (next: string) => writeSelection(scope, next),
    submitted: (sent: string) => { if (readSelection(scope) === sent) writeSelection(scope, ''); },
  };
}
