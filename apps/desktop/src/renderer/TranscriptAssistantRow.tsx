import type { ComponentProps } from 'react';
import { TranscriptRow } from './transcript-row';

export type TranscriptAssistantRowProps = ComponentProps<typeof TranscriptRow> & { live: boolean };

/** Keep the same Markdown subtree when a live row becomes a completed row. */
export function TranscriptAssistantRow({ live, ...props }: TranscriptAssistantRowProps) {
  return (
    <div className="transcript-live-part" data-streaming-tail={live ? 'true' : undefined}>
      <TranscriptRow {...props} />
    </div>
  );
}
