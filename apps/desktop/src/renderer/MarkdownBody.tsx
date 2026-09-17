import type { MarkdownCopyControl } from './markdown-components';
import StreamingMarkdownBody from './StreamingMarkdownBody';

export default function MarkdownBody({ text, copyControl }: { text: string; copyControl: MarkdownCopyControl }) {
  // History and live output share one parser, AST cache and recovery path.
  return <StreamingMarkdownBody text={text} copyControl={copyControl} />;
}
