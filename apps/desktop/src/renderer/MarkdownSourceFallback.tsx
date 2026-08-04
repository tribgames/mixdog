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

export function isFencedCodeOnlyMarkdown(text: string): boolean {
  const parts = sourceParts(text);
  return parts.some((part) => part.kind === "code")
    && parts.every((part) => part.kind === "code" || !part.text.trim());
}

function sourceTextNodes(text: string, key: string): ReactNode[] {
  return text
    .split(/(?:\r?\n){2,}/)
    .map((paragraph) => paragraph.replace(/^\r?\n+|\r?\n+$/g, ""))
    .filter((paragraph) => paragraph.trim())
    .map((paragraph, index) => (
      <p className="markdown-plain" key={`${key}-paragraph-${index}`}>{paragraph}</p>
    ));
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
        <header><span>{part.language || "code"}</span>
          {CopyControl
            ? <CopyControl value={part.text} label="Copy code" className="markdown-code-copy" />
            : null}
        </header>
        <pre><code className={part.language ? `language-${part.language}` : undefined}>
          {part.text}
        </code></pre>
      </div>)}
  </>;
}
