/**
 * repl/turn-output.mjs — what the REPL prints once a turn has settled: the
 * markdown re-render of the streamed block (TTY only, text-only turns) and the
 * per-turn statusline footer.
 */
import { colorEnabled } from '../ui/ansi.mjs';
import { buildStreamFinalPatch } from '../ui/stream-finalize.mjs';
import { eraseStreamedBlock } from './stream-sink.mjs';

/**
 * Approach (a): clear the raw streamed block and re-print as markdown. Only
 * when we're on a TTY and actually streamed something — otherwise the raw text
 * already on screen is fine (and we must not emit cursor escapes into a pipe).
 */
export async function finalizeTurnOutput({ out, sink, finalText, renderMarkdown }) {
  if (!finalText) return;
  const streamedText = sink.currentText();
  if (sink.printedAny() && colorEnabled() && !sink.printedToolCard()) {
    const rendered = await renderMarkdown(finalText);
    const patch = buildStreamFinalPatch(streamedText, rendered, {
      columns: out.columns || 80,
    });
    if (patch) out.write(patch.output);
    else {
      eraseStreamedBlock(out, streamedText);
      out.write(rendered);
    }
    out.write('\n');
  } else if (!sink.printedAny()) {
    // Nothing streamed live (provider without onTextDelta) — render once.
    out.write(`${await renderMarkdown(finalText)}\n`);
  } else {
    // Tool cards are printed after the streamed text. Erasing only the
    // streamed text from the current cursor position would clear/move
    // through the card rows and make the terminal scroll jump. Keep the
    // live transcript as-is for mixed text+tool turns.
    // Non-TTY / NO_COLOR: leave the raw stream, just terminate the line.
    out.write('\n');
  }
}

export function statuslineFor(renderStatusline, { runtime, cwd, stats }) {
  return renderStatusline({
    provider: runtime.provider,
    model: runtime.model,
    cwd,
    stats,
    contextWindow: runtime.contextWindow,
    rawContextWindow: runtime.rawContextWindow,
  });
}
