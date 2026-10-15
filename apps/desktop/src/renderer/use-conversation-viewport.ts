import { useRef } from 'react';
import { useTranscriptFollow } from './use-transcript-follow';

/** The pane's DOM anchors and the reader's follow state over the transcript
 *  viewport. */
export function useConversationViewport({
  transcriptSessionKey,
  transcriptPending,
}: {
  transcriptSessionKey: string;
  transcriptPending: boolean;
}) {
  const conversation = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scrollToEndRef = useRef<(behavior?: ScrollBehavior) => void>(() => {});
  // Reader intent must reach the virtual timeline's anchor in the same task it
  // is decided in; React state gets there a render later.
  const setTranscriptAnchorBottomRef = useRef<(bottom: boolean) => void>(() => {});
  // Latched once this identity has painted its timeline. A promotion whose
  // Markdown-readiness flag lags one tick must not unmount measured rows.
  const timelineMounted = useRef(false);
  // Auto-scroll + message-gesture split.
  const follow = useTranscriptFollow({
    viewport,
    content,
    sessionKey: transcriptSessionKey,
    contentMounted: !transcriptPending || timelineMounted.current,
    setAnchorBottomRef: setTranscriptAnchorBottomRef,
    scrollToEndRef,
  });
  return {
    conversation,
    viewport,
    content,
    scrollToEndRef,
    setTranscriptAnchorBottomRef,
    timelineMounted,
    follow,
  };
}

export type ConversationViewport = ReturnType<typeof useConversationViewport>;
