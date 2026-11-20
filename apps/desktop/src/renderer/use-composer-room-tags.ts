// Agent mode's `@` in a room: pick members, who then answer the message once
// each in pick order (sent on the room's `/ask` path). A 1:1 thread's `@`
// opens nothing yet.
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { DesktopPromptContent, DesktopSubmitOptions } from '../shared/contract';
import { isInMarkdownCode } from '../../../../packages/protocol-client/src/rows/skill-mentions.mjs';
import type { RoomMemberLabel } from './agent-room-parts';
import { stashComposerTags, takeStashedComposerTags } from './composer-draft';
import { contentAsking, roomTagCandidates, roomTagTargets, roomTaggedMembers } from './composer-room-ask';

const TAG_KEYS = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown'];

export function useComposerRoomTags({
  identityScope,
  agentMode,
  roomMembers,
  draft,
  draftRef,
  setDraft,
  textarea,
  setCaretOffset,
  mention,
  composerFocused,
  paneActive,
  submit,
}: {
  identityScope: string;
  agentMode: boolean;
  roomMembers: RoomMemberLabel[] | null;
  draft: string;
  draftRef: { current: string };
  setDraft: Dispatch<SetStateAction<string>>;
  textarea: RefObject<HTMLTextAreaElement | null>;
  setCaretOffset(offset: number): void;
  mention: { match: { start: number; end: number; query: string } | null; signature: string };
  composerFocused: boolean;
  paneActive: boolean;
  submit(content: DesktopPromptContent, options?: DesktopSubmitOptions): Promise<unknown>;
}) {
  const [tagged, setTagged] = useState<string[]>(() => takeStashedComposerTags(identityScope));
  const taggedRef = useRef(tagged);
  taggedRef.current = tagged;
  const taggedScope = useRef(identityScope);
  const [tagDismissed, setTagDismissed] = useState('');
  // The highlighted candidate; ↑/↓ move it, Enter/Tab pick it.
  const [tagIndex, setTagIndex] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `@` query starts from the first candidate
  useEffect(() => setTagIndex(0), [mention.signature]);
  // Tags picked in the tab being left are parked with its text; the incoming
  // tab gets back the tags it parked.
  useEffect(() => {
    if (taggedScope.current === identityScope) return;
    stashComposerTags(taggedScope.current, taggedRef.current);
    taggedScope.current = identityScope;
    setTagged(takeStashedComposerTags(identityScope));
  }, [identityScope]);

  const add = (agentId: string) =>
    setTagged((current) => (current.includes(agentId) ? current : [...current, agentId]));
  const remove = (agentId: string) => setTagged((current) => current.filter((id) => id !== agentId));
  const members = roomTaggedMembers(tagged, roomMembers);
  // An `@` inside Markdown code (a fence or inline span) is text, not a tag.
  const match =
    agentMode && roomMembers && mention.match && !isInMarkdownCode(draft, mention.match.start) ? mention.match : null;
  const candidates =
    match && composerFocused && paneActive && tagDismissed !== mention.signature
      ? roomTagCandidates(match.query, roomMembers).filter((member) => !tagged.includes(member.id))
      : [];
  const selected = Math.min(tagIndex, candidates.length - 1);
  const pick = (agentId: string) => {
    if (!match) return;
    const current = draftRef.current;
    const next = `${current.slice(0, match.start)}${current.slice(match.end)}`.replace(/^\s+/, '');
    draftRef.current = next;
    setDraft(next);
    add(agentId);
    queueMicrotask(() => {
      const field = textarea.current;
      if (!field) return;
      field.focus();
      const caret = Math.min(match.start, next.length);
      field.setSelectionRange(caret, caret);
      setCaretOffset(caret);
    });
  };
  const submitTagged: typeof submit = members.length
    ? async (content, options) => {
        const accepted = await submit(contentAsking(content, roomTagTargets(members, roomMembers ?? [])), options);
        if (accepted === true) setTagged([]);
        return accepted;
      }
    : submit;
  /** Arrow/Enter/Tab/Escape drive the candidate list; Backspace at the field's
   *  start takes the last tag back. True when the key was consumed. */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean => {
    if (candidates.length > 0 && !composing && TAG_KEYS.includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const count = candidates.length;
      if (event.key === 'Escape') setTagDismissed(mention.signature);
      else if (event.key === 'ArrowDown') setTagIndex((index) => (index + 1) % count);
      else if (event.key === 'ArrowUp') setTagIndex((index) => (index - 1 + count) % count);
      else pick(candidates[selected].id);
      return true;
    }
    if (
      tagged.length > 0 &&
      event.key === 'Backspace' &&
      event.currentTarget.selectionStart === 0 &&
      event.currentTarget.selectionEnd === 0
    ) {
      event.preventDefault();
      setTagged((current) => current.slice(0, -1));
      return true;
    }
    return false;
  };
  return { taggedRef, members, candidates, selected, add, remove, pick, submitTagged, handleKeyDown };
}
