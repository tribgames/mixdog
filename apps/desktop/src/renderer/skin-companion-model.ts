// The desktop pet's bubble state (Mixy's home chat), kept free of React so it
// is testable on its own: the app window derives it (desktop-pet-publisher.tsx),
// the pet window draws it (skin-companion-pet.tsx).
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { isTranscriptCancelledStatusText } from '../../../../src/runtime/shared/tool-execution-contract.mjs';
import { DESKTOP_PET_REPLY_MAX, type DesktopPetBubble } from '../shared/desktop-pet';
import type { TranscriptItem } from './desktop-types';
import { completionTone } from './transcript-primitives';

/** What the speech bubble shows: Mixy's latest reply (markdown), or a
 *  comic symbol while there is no reply to show. */
export type CompanionBubble = DesktopPetBubble;

/** The latest finished turn of a transcript: its identity, outcome, finish
 *  time and the reply it ended with (plain text). */
export interface CompanionCompletion {
  key: string;
  kind: 'done' | 'failed' | 'cancelled';
  at: number;
  text: string;
}

/** A reply's markdown for the bubble (the pet window renders it with the
 *  app's parser): tabs as spaces, other control characters dropped, blank
 *  line runs kept to one, bounded. */
export function markdownReplyText(text: string): string {
  const source = text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
    .replace(/[ \u00a0]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return source.length > DESKTOP_PET_REPLY_MAX ? `${source.slice(0, DESKTOP_PET_REPLY_MAX - 1).trimEnd()}…` : source;
}

function itemKey(item: TranscriptItem, index: number): string {
  return String(item.messageId || item.checkpointId || item.id || `index:${index}`);
}

/** The latest turn that finished, or null when the newest turn row is a
 *  prompt still waiting for its answer (or there is none). */
export function latestCompletion(items: readonly TranscriptItem[]): CompanionCompletion | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'user') {
      if (!isTranscriptCancelledStatusText(String(item.text || ''))) return null;
      return { key: itemKey(item, index), kind: 'cancelled', at: Number(item.at) || 0, text: '' };
    }
    if (item?.kind !== 'turndone') continue;
    const tone = completionTone(item);
    const at = Number(item.at) || 0;
    if (tone === 'failed') return { key: itemKey(item, index), kind: 'failed', at, text: '' };
    if (tone === 'interrupted') return { key: itemKey(item, index), kind: 'cancelled', at, text: '' };
    const finalId = item.finalAssistantId == null ? '' : String(item.finalAssistantId);
    let reply = '';
    for (let back = index - 1; back >= 0 && items[back]?.kind !== 'user'; back -= 1) {
      const candidate = items[back];
      if (candidate?.kind !== 'assistant') continue;
      if (finalId && String(candidate.id) !== finalId) {
        reply ||= String(candidate.text || '');
        continue;
      }
      reply = String(candidate.text || '');
      break;
    }
    return { key: itemKey(item, index), kind: 'done', at, text: markdownReplyText(reply) };
  }
  return null;
}

/** The bubble for Mixy's chat: approval outranks work; a reply shows until
 *  dismissed, and only when it is new to this renderer (it finished after
 *  the pet first saw the chat, or while it watched it work). A failed or
 *  cancelled turn shows nothing special: the app's chat shows that. */
export function companionBubble({
  working,
  approval,
  completion,
  dismissedKey,
  firstSeenAt,
  sawWorking,
}: {
  working: boolean;
  approval: boolean;
  completion: CompanionCompletion | null;
  dismissedKey: string;
  firstSeenAt: number;
  sawWorking: boolean;
}): CompanionBubble {
  if (approval) return { kind: 'approval' };
  if (working) return { kind: 'working' };
  if (!completion || completion.key === dismissedKey) return { kind: 'idle' };
  if (!sawWorking && !(completion.at > 0 && completion.at >= firstSeenAt)) return { kind: 'idle' };
  if (completion.kind !== 'done' || !completion.text) return { kind: 'idle' };
  return { kind: 'reply', key: completion.key, text: completion.text };
}
