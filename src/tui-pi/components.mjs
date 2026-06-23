/**
 * src/tui/components.mjs — Claude-Code-style chat components over pi-tui.
 *
 * Built on the pre-built pi-tui ESM primitives (Markdown/Text/Container/Spacer
 * from the vendored dist/). These factories reproduce Claude Code's visual
 * shape (refs/claude-code): a colored turn marker `●` before each assistant
 * reply and tool call, and a dim `  ⎿  ` result tree under tool calls.
 *
 *   createAssistantMarkdown()      → streaming assistant block: `● <markdown>`.
 *   createUserMarkdown(text)       → the echoed user line.
 *   createToolCard(call)           → `● tool(arg-summary)` with a controller to
 *                                     attach the `⎿` result once it arrives.
 *   createNoticeText(text)         → a plain notice/system line.
 *
 * Markers/indent are applied by a thin custom Component (MarkerBlock) that
 * prefixes the first rendered line with the marker and indents continuations,
 * so wrapping/CJK width handling still comes from pi-tui's own renderer.
 */
import {
  Markdown,
  Text,
  Container,
  truncateToWidth,
  visibleWidth,
} from '../../vendor/pi/packages/tui/dist/index.js';

import { markdownTheme, TURN_MARKER, RESULT_PREFIX, RESULT_INDENT, colors } from './theme.mjs';
import { renderToolCard } from '../ui/tool-card.mjs';
import { stripAnsi } from '../ui/ansi.mjs';

// Padding for chat message blocks (x, y). CC keeps assistant text tight to the
// marker, so paddingX=0 (the marker provides the left gutter) and paddingY=0
// (spacing is owned by explicit Spacers in turn.mjs).
const MSG_PAD_X = 0;
const MSG_PAD_Y = 0;

/**
 * MarkerBlock — wraps an inner Component, prefixing its first line with a
 * `marker ` gutter and indenting every following line so multi-line content
 * stays aligned under the marker (the Claude-Code `● …` / `  ⎿  …` shape).
 *
 * Implements the pi-tui Component contract: render(width)→string[], invalidate.
 */
class MarkerBlock {
  /**
   * @param {object} inner a pi-tui Component (has render(width):string[])
   * @param {string} marker the styled marker glyph (e.g. colored `●`)
   * @param {string} [contMarker] indent string for continuation lines
   */
  constructor(inner, marker, contMarker) {
    this.inner = inner;
    this.marker = marker;
    // Continuation indent defaults to spaces matching the marker's visible width
    // plus one (for the trailing space), so wrapped lines align under content.
    this.contMarker = contMarker ?? ' '.repeat(visibleWidth(marker) + 1);
    // Cell width consumed by the gutter, so the inner component wraps correctly.
    this.gutter = visibleWidth(marker) + 1;
  }

  invalidate() {
    this.inner.invalidate?.();
  }

  // --- Focusable / input passthrough ---------------------------------------
  // When wrapping a focusable component (the Editor), the TUI sets `.focused`
  // and routes key input to `.handleInput`. Forward both so a wrapped Editor
  // behaves exactly as an unwrapped one (cursor + typing intact).
  get focused() {
    return this.inner.focused;
  }

  set focused(v) {
    if ('focused' in this.inner) this.inner.focused = v;
  }

  get wantsKeyRelease() {
    return this.inner.wantsKeyRelease;
  }

  handleInput(data) {
    return this.inner.handleInput?.(data);
  }

  render(width) {
    const innerWidth = Math.max(1, width - this.gutter);
    const lines = this.inner.render(innerWidth);
    if (!lines || lines.length === 0) return [`${this.marker} `];
    return lines.map((line, i) =>
      i === 0 ? `${this.marker} ${line}` : `${this.contMarker}${line}`,
    );
  }
}

/**
 * Wrap a focusable input component (the Editor) with a `> ` prompt prefix and
 * matching left padding on continuation lines — the Claude-Code input shape.
 * The returned wrapper forwards focus + key input to the inner component.
 *
 * @param {object} editor a pi-tui Editor (Focusable Component)
 * @param {string} promptMarker the styled prompt prefix WITHOUT trailing space
 *   (MarkerBlock adds one space after the marker)
 */
export function withPrompt(editor, promptMarker) {
  return new MarkerBlock(editor, promptMarker);
}

/**
 * A streaming assistant message: `● <markdown>`. Returns the component plus a
 * controller so callers mutate the accumulated text without tracking it.
 *
 * @param {string} [initial]
 * @returns {{ component: object, append(chunk: string): string, set(text: string): void, get(): string }}
 */
export function createAssistantMarkdown(initial = '') {
  let acc = String(initial || '');
  const md = new Markdown(acc, MSG_PAD_X, MSG_PAD_Y, markdownTheme);
  const component = new MarkerBlock(md, colors.assistantMarker(TURN_MARKER));
  return {
    component,
    append(chunk) {
      acc += String(chunk ?? '');
      md.setText(acc);
      return acc;
    },
    set(text) {
      acc = String(text ?? '');
      md.setText(acc);
    },
    get() {
      return acc;
    },
  };
}

/** A user message block (markdown, no marker — CC shows user input plainly). */
export function createUserMarkdown(text) {
  return new Markdown(String(text ?? ''), 1, 0, markdownTheme);
}

/**
 * A tool-call card: `● tool(arg-summary)` with a `⎿` result attached later.
 * renderToolCard() returns a styled one-line string; we strip its leading
 * `▸ ` bullet (we use the CC `●` marker instead) and wrap it.
 *
 * Returns { component, setResult(text) } — call setResult() once the tool's
 * result lands in `messages` so the `  ⎿  …` tree appears under the call.
 *
 * @param {{ name?: string, arguments?: object, id?: string }} call
 */
export function createToolCard(call) {
  const container = new Container();

  // The call line: reuse the existing summarizer, drop its leading `▸ ` bullet
  // (we use the CC `●` marker instead). renderToolCard() prefixes the bullet
  // with whitespace AND an ANSI color code, so strip leading spaces + SGR
  // sequences, then the `▸` glyph and any SGR/space that follows it.
  const cardStr = String(renderToolCard(call) || '')
    .replace(/^(?:\s|\x1b\[[0-9;]*m)*▸(?:\s|\x1b\[[0-9;]*m)*/, '');
  const callLine = new MarkerBlock(new Text(cardStr, 0, 0), colors.toolMarker(TURN_MARKER));
  container.addChild(callLine);

  let resultComponent = null;

  return {
    component: container,
    /**
     * Attach (or replace) the `  ⎿  result` tree under the call.
     * @param {string} text raw tool-result text
     * @param {boolean} [isError]
     */
    setResult(text, isError = false) {
      if (resultComponent) container.removeChild(resultComponent);
      resultComponent = new ToolResultTree(String(text ?? ''), isError);
      container.addChild(resultComponent);
    },
  };
}

/**
 * ToolResultTree — renders `  ⎿  ` + a clamped preview of the tool result,
 * dim, with continuation lines indented under the glyph (CC shape). Long
 * results are truncated with a `… (+N lines)` tail.
 */
class ToolResultTree {
  constructor(text, isError = false, maxLines = 8) {
    this.text = text;
    this.isError = isError;
    this.maxLines = maxLines;
  }

  invalidate() {}

  render(width) {
    const raw = stripAnsi(this.text).replace(/\s+$/, '');
    if (!raw) return [colors.resultTree(`${RESULT_PREFIX}(no output)`)];

    const allLines = raw.split('\n');
    const shown = allLines.slice(0, this.maxLines);
    const overflow = allLines.length - shown.length;

    const paint = this.isError ? colors.errorMarker : colors.resultTree;
    const out = shown.map((line, i) => {
      const prefix = i === 0 ? RESULT_PREFIX : RESULT_INDENT;
      // Clamp each line to the terminal CELL width (CJK/emoji are 2 cells), so a
      // rendered line never exceeds `width` — pi-tui throws on over-wide custom
      // component lines. truncateToWidth appends an ellipsis when it cuts.
      const room = Math.max(0, width - visibleWidth(prefix));
      const clamped = visibleWidth(line) > room ? truncateToWidth(line, room) : line;
      return colors.resultTree(prefix) + paint(clamped);
    });
    if (overflow > 0) {
      out.push(colors.resultTree(`${RESULT_INDENT}… (+${overflow} more line${overflow === 1 ? '' : 's'})`));
    }
    return out;
  }
}

/** A plain dim/notice line (errors, system notes) as a Text component. */
export function createNoticeText(text) {
  return new Text(String(text ?? ''), 1, 0);
}
