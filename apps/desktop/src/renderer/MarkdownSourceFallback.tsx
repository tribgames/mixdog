import type { ComponentType, ReactNode } from "react";

type MarkdownSourcePart =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string; language: string };

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?/gm;
const FENCE_PROBE = /(?:^|\n) {0,3}(?:`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/;

export function containsFencedCodeMarkdown(text: string): boolean {
  return FENCE_PROBE.test(String(text ?? ""));
}

function trimPartialClosingFence(
  text: string,
  marker: string,
  minimumLength: number,
): string {
  const partial = /(?:^|\r?\n) {0,3}([`~]+)$/.exec(text);
  const run = partial?.[1] || "";
  if (!partial || !run || run[0] !== marker || run.length >= minimumLength) return text;
  return text.slice(0, partial.index).replace(/\r?\n$/, "");
}

function sourceParts(text: string): MarkdownSourcePart[] {
  const value = String(text ?? "");
  const parts: MarkdownSourcePart[] = [];
  let cursor = 0;
  OPEN_FENCE.lastIndex = 0;
  for (let opening = OPEN_FENCE.exec(value); opening; opening = OPEN_FENCE.exec(value)) {
    if (opening.index < cursor) continue;
    if (opening.index > cursor) {
      parts.push({ kind: "text", text: value.slice(cursor, opening.index) });
    }
    const marker = opening[1][0];
    const minimumLength = opening[1].length;
    const closingPattern = new RegExp(
      `^ {0,3}${marker}{${minimumLength},}[ \\t]*\\r?$`,
      "gm",
    );
    closingPattern.lastIndex = OPEN_FENCE.lastIndex;
    const closing = closingPattern.exec(value);
    const contentEnd = closing?.index ?? value.length;
    const language = opening[2].trim().split(/\s+/, 1)[0] || "";
    const source = value.slice(OPEN_FENCE.lastIndex, contentEnd).replace(/\r?\n$/, "");
    parts.push({
      kind: "code",
      text: closing ? source : trimPartialClosingFence(source, marker, minimumLength),
      language,
    });
    if (!closing) {
      cursor = value.length;
      break;
    }
    cursor = closingPattern.lastIndex;
    if (value[cursor] === "\n") cursor += 1;
    OPEN_FENCE.lastIndex = cursor;
  }
  if (cursor < value.length) parts.push({ kind: "text", text: value.slice(cursor) });
  if (parts.length === 0) parts.push({ kind: "text", text: value });
  return parts;
}

const SOURCE_HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const SOURCE_BULLET = /^ {0,3}[-*+]\s+(.*)$/;
const SOURCE_ORDERED = /^ {0,3}\d+[.)]\s+(.*)$/;

// The fallback stands in for the parsed block until the worker answers. Headings
// and list items adopt their final element grammar here too, so a streaming
// answer no longer shows "## " and "- " markers for the first frames and then
// snaps into shape (user: 마크다운이 늦게 나온다).
function sourceBlockNodes(block: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let prose: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushProse = () => {
    const text = prose.join("\n");
    prose = [];
    if (!text.trim()) return;
    const proseKey = `${key}-p-${nodes.length}`;
    nodes.push(
      <p className="markdown-plain" key={proseKey}>{sourceInlineNodes(text, proseKey)}</p>,
    );
  };
  const flushList = () => {
    if (!list) return;
    const current = list;
    list = null;
    const listKey = `${key}-list-${nodes.length}`;
    const items = current.items.map((item, index) => (
      <li key={`${listKey}-${index}`}>{sourceInlineNodes(item, `${listKey}-${index}`)}</li>
    ));
    nodes.push(current.ordered
      ? <ol key={listKey}>{items}</ol>
      : <ul key={listKey}>{items}</ul>);
  };
  for (const line of block.split(/\r?\n/)) {
    const heading = SOURCE_HEADING.exec(line);
    if (heading) {
      flushProse();
      flushList();
      const Heading = `h${heading[1].length}` as "h1";
      const headingKey = `${key}-h-${nodes.length}`;
      nodes.push(<Heading key={headingKey}>{sourceInlineNodes(heading[2], headingKey)}</Heading>);
      continue;
    }
    const bullet = SOURCE_BULLET.exec(line);
    const ordered = bullet ? null : SOURCE_ORDERED.exec(line);
    if (bullet || ordered) {
      flushProse();
      const isOrdered = Boolean(ordered);
      if (list && list.ordered !== isOrdered) flushList();
      list ??= { ordered: isOrdered, items: [] };
      list.items.push(bullet?.[1] ?? ordered?.[1] ?? "");
      continue;
    }
    if (list) {
      // A continuation line belongs to the item it follows.
      if (line.trim()) list.items[list.items.length - 1] += `\n${line.trim()}`;
      else flushList();
      continue;
    }
    prose.push(line);
  }
  flushProse();
  flushList();
  return nodes;
}

function sourceTextNodes(text: string, key: string): ReactNode[] {
  return text
    .split(/(?:\r?\n){2,}/)
    .map((paragraph) => paragraph.replace(/^\r?\n+|\r?\n+$/g, ""))
    .filter((paragraph) => paragraph.trim())
    .flatMap((paragraph, index) => sourceBlockNodes(paragraph, `${key}-paragraph-${index}`));
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

// Longest marker first: "**" must win over "*" at the same offset.
const INLINE_MARKERS = ["**", "__", "~~", "*", "_"] as const;
type InlineMarker = (typeof INLINE_MARKERS)[number];

function markerAt(text: string, index: number): InlineMarker | null {
  for (const marker of INLINE_MARKERS) {
    if (text.startsWith(marker, index)) return marker;
  }
  return null;
}

function markerElement(marker: InlineMarker): "strong" | "em" | "del" {
  if (marker === "**" || marker === "__") return "strong";
  if (marker === "~~") return "del";
  return "em";
}

function inlineCodeEnd(text: string, index: number): number {
  let runEnd = index + 1;
  while (text[runEnd] === "`") runEnd += 1;
  const marker = text.slice(index, runEnd);
  const closing = text.indexOf(marker, runEnd);
  return closing < 0 ? -1 : closing + marker.length;
}

function emphasisMarkerEnd(text: string, marker: InlineMarker, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "`" && !isEscaped(text, index)) {
      const codeEnd = inlineCodeEnd(text, index);
      if (codeEnd >= 0) {
        index = codeEnd - 1;
        continue;
      }
    }
    if (!text.startsWith(marker, index) || isEscaped(text, index)) continue;
    if (!text[index - 1] || /\s/.test(text[index - 1])) continue;
    if (marker[0] === "_" && /[\p{L}\p{N}_]/u.test(text[index + marker.length] || "")) continue;
    return index;
  }
  return -1;
}

function sourceInlineNodes(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let plainStart = 0;
  let index = 0;
  const pushPlain = (end: number) => {
    if (end > plainStart) nodes.push(text.slice(plainStart, end));
  };
  while (index < text.length) {
    if (text[index] === "`" && !isEscaped(text, index)) {
      const end = inlineCodeEnd(text, index);
      if (end >= 0) {
        pushPlain(index);
        let markerLength = 1;
        while (text[index + markerLength] === "`") markerLength += 1;
        nodes.push(
          <code key={`${key}-code-${index}`}>
            {text.slice(index + markerLength, end - markerLength)}
          </code>,
        );
        index = end;
        plainStart = end;
        continue;
      }
    }
    const marker = markerAt(text, index);
    const before = text[index - 1] || "";
    const after = marker ? text[index + marker.length] || "" : "";
    const canOpen = marker
      && !isEscaped(text, index)
      && Boolean(after)
      && !/\s/.test(after)
      && (marker[0] !== "_" || !/[\p{L}\p{N}_]/u.test(before));
    if (canOpen && marker) {
      const closing = emphasisMarkerEnd(text, marker, index + marker.length);
      if (closing >= 0) {
        const Emphasis = markerElement(marker);
        const emphasisKey = `${key}-${Emphasis}-${index}`;
        pushPlain(index);
        nodes.push(
          <Emphasis key={emphasisKey}>
            {sourceInlineNodes(text.slice(index + marker.length, closing), emphasisKey)}
          </Emphasis>,
        );
        index = closing + marker.length;
        plainStart = index;
        continue;
      }
    }
    index += 1;
  }
  pushPlain(text.length);
  return nodes;
}

/**
 * Source-shaped Markdown fallback used while the rich parser settles.
 * Fenced scripts adopt their final code-block grammar immediately, so the
 * visible text never swaps from Pretendard prose metrics to JetBrains Mono.
 */
export function MarkdownSourceFallback({
  text,
  copyControl: CopyControl,
}: {
  text: string;
  copyControl?: ComponentType<{ value: string; label: string; className: string }>;
}) {
  return <>
    {sourceParts(text).map((part, index) => part.kind === "text"
      ? sourceTextNodes(part.text, `text-${index}`)
      : <div className="markdown-code markdown-code-fallback" key={`code-${index}`}>
        <header><span>{part.language}</span>
          {CopyControl
            ? <CopyControl value={part.text} label="Copy code" className="markdown-code-copy" />
            : null}
        </header>
        <pre data-scrollable><code className={part.language ? `language-${part.language}` : undefined}>
          {part.text}
        </code></pre>
      </div>)}
  </>;
}
