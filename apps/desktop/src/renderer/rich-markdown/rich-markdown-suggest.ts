import type { EditorState } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';

import { t } from '../i18n';
import { filterBlockCommands, filterEmoji } from './rich-markdown-commands';
import type { OverlayPoint, SuggestItem } from './RichMarkdownOverlays';

export interface MenuState {
  kind: 'slash' | 'emoji';
  from: number;
  to: number;
  items: SuggestItem[];
  selected: number;
  point: OverlayPoint;
}

/** The `/query` or `:query` the caret is typing, if any. */
function typedTrigger(state: EditorState): { kind: 'slash' | 'emoji'; query: string; from: number; to: number } | null {
  const { selection } = state;
  if (!selection.empty || !(selection instanceof TextSelection)) return null;
  const { $from } = selection;
  if ($from.parent.type.spec.code || !$from.parent.isTextblock) return null;
  const before = $from.parent.textBetween(
    Math.max(0, $from.parentOffset - 48),
    $from.parentOffset,
    undefined,
    '\ufffc'
  );
  const slash = /(?:^|\s)\/([\p{L}\p{N}-]{0,24})$/u.exec(before);
  if (slash) return { kind: 'slash', query: slash[1], from: $from.pos - slash[1].length - 1, to: $from.pos };
  const emoji = /(?:^|\s):([a-z0-9_+-]{2,32})$/.exec(before);
  if (emoji) return { kind: 'emoji', query: emoji[1], from: $from.pos - emoji[1].length - 1, to: $from.pos };
  return null;
}

/** The suggestion menu for what the caret is typing now, or null when it
 *  should close. A menu for the same trigger keeps its point and its
 *  selection (clamped to the new items). */
export function suggestMenuFor(
  state: EditorState,
  menu: MenuState | null,
  pointAt: (pos: number) => OverlayPoint
): MenuState | null {
  const trigger = typedTrigger(state);
  if (!trigger) return null;
  const items: SuggestItem[] =
    trigger.kind === 'slash'
      ? filterBlockCommands(trigger.query, t).map((command) => ({ kind: 'command', command }))
      : filterEmoji(trigger.query).map(([code, emoji]) => ({ kind: 'emoji', code, emoji }));
  if (trigger.kind === 'emoji' && !items.length) return null;
  const same = menu?.kind === trigger.kind && menu.from === trigger.from;
  return {
    kind: trigger.kind,
    from: trigger.from,
    to: trigger.to,
    items,
    selected: same ? Math.min(menu.selected, Math.max(items.length - 1, 0)) : 0,
    point: same ? menu.point : pointAt(trigger.from),
  };
}
