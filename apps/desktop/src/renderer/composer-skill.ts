import { useSyncExternalStore } from 'react';
import type { DesktopPromptContent } from '../shared/contract';
import { skillDisplayDescription } from './skill-presentation';

export type ComposerSkill = { name: string; description: string };
const TITLES: Record<string, string> = {
  pdf: 'PDF', pptx: 'PPT', docx: 'Word', xlsx: 'Excel',
  image: 'Image', video: 'Video', 'browser-use': 'Browser Use',
  'computer-use': 'Computer Use', 'goal-management': 'Goal',
  'history-recall': 'History recall', 'memory-management': 'Memory',
  'local-provider': 'Local Provider', setup: 'Settings', 'skill-creator': 'Create skill',
};
export const skillTitle = (name: string) => Object.hasOwn(TITLES, name) ? TITLES[name] : name;

export function shouldRemoveSelectedSkill(input: {
  selected: string; key: string; start: number; end: number;
  composing: boolean; repeat?: boolean; modified?: boolean;
}): boolean {
  return Boolean(input.selected) && input.key === 'Backspace'
    && input.start === 0 && input.end === 0
    && !input.composing && !input.repeat && !input.modified;
}

export function selectableComposerSkills(value: unknown): ComposerSkill[] {
  const status = value as { skills?: Array<{ name?: unknown; description?: unknown; enabled?: boolean; source?: unknown; owner?: unknown }> } | null;
  const seen = new Set<string>();
  return (Array.isArray(status?.skills) ? status.skills : []).flatMap(skill => {
    const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
    if (!name || skill.enabled !== true || seen.has(name)) return [];
    seen.add(name);
    return [{ name, description: skillDisplayDescription(skill) }];
  });
}

export function withSelectedSkill(content: DesktopPromptContent, name: string): DesktopPromptContent {
  if (!name) return content;
  // The selection is a user instruction, not a synthetic tool result. Loading
  // remains with the normal Skill tool so dependency/disabled checks still run.
  const instruction = `The user explicitly selected skill ${JSON.stringify(name)} for this request. Load it with the Skill tool before doing the task. If it is unavailable, report that rather than silently substituting another skill.\n\n`;
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
