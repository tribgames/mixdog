import { CarriedFacts, carriedFold } from './list-carry';

type ScopeItem = { id?: string | number; kind?: string; text?: unknown; label?: unknown; status?: unknown };

export type TurnReviewScope = {
  startIndex: number;
  key: string;
  hasActivity: boolean;
  /** Rows without the prompt that opened their turn: the daemon's byte-budgeted transcript tail cut it off, so every row
   *  left still belongs to that turn. */
  truncated: boolean;
};

function stableItemKey(item: ScopeItem | undefined, index: number): string {
  if (item?.id !== undefined && item?.id !== null) return String(item.id);
  return `${item?.kind || 'item'}:${item?.text || item?.label || item?.status || ''}:${index}`;
}

/** `open`: a prompt opened a turn no `turndone` closed yet (1). `start`: the prompt that opened the newest turn.
 *  `activity`: the first row after it (of the list, while no prompt opened a turn) that is not a prompt. */
type ScopeFact = 'open' | 'start' | 'activity';

const scopeOf = carriedFold<ScopeItem, CarriedFacts<ScopeFact, number>, TurnReviewScope>({
  make: () => new CarriedFacts(),
  rewind: (facts, from) => facts.rewind(from),
  read(facts, items, from) {
    for (let index = from; index < items.length; index += 1) {
      const item = items[index];
      if (item?.kind === 'user') {
        if (facts.get('open') === 1) continue;
        facts.set(index, 'open', 1);
        facts.set(index, 'start', index);
        facts.set(index, 'activity', -1);
        continue;
      }
      if (item && (facts.get('activity') ?? -1) < 0) facts.set(index, 'activity', index);
      if (item?.kind === 'turndone' && facts.get('open') === 1) facts.set(index, 'open', 0);
    }
  },
  result(facts, items) {
    const startIndex = facts.get('start') ?? -1;
    return {
      startIndex,
      key: startIndex >= 0 ? stableItemKey(items[startIndex], startIndex) : 'none',
      hasActivity: (facts.get('activity') ?? -1) >= 0,
      truncated: startIndex < 0 && items.length > 0,
    };
  },
});

/** The turn a transcript's review is of: the prompt that opened its running turn, else its newest one. A list carried on
 *  from one already read (list-carry.ts `noteCarried`) is read from the rows it did not leave in place. */
export function turnReviewScope(items: readonly ScopeItem[] | undefined): TurnReviewScope {
  return scopeOf(Array.isArray(items) ? items : NO_ITEMS);
}

const NO_ITEMS: readonly ScopeItem[] = [];
