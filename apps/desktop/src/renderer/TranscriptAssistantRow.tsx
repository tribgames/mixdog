import { useLayoutEffect, useRef, type ComponentProps } from 'react';
import { TranscriptRow } from './transcript-row';
import { requestTranscriptRowMeasure } from './transcript-measure';

export type TranscriptAssistantRowProps = ComponentProps<typeof TranscriptRow> & { live: boolean };

/** Keep the same Markdown subtree when a live row becomes a completed row. */
export function TranscriptAssistantRow({ live, ...props }: TranscriptAssistantRowProps) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    requestTranscriptRowMeasure(root.current);
  }, [live, props.item, props.completion]);
  return (
    <div ref={root} className="transcript-live-part" data-streaming-tail={live ? 'true' : undefined}>
      <TranscriptRow {...props} />
    </div>
  );
}
