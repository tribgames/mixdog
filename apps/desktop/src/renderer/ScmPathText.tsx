// A changed path renders as ONE continuous sentence and lets
// COLOUR carry the structure:
// the directory prefix — its separators included — is dim, the file name is
// bright. There is no name/path column pair and no second line.
//
// Truncation is an ALGORITHM, never a CSS ellipsis that eats the file name at
// narrow dock widths: the FILE NAME stays whole while the DIRECTORY prefix
// shortens to `pre…/name`, the directory/file split walks the truncated text
// back apart, and the full path only moves into a tooltip once something was
// actually dropped. The available width is measured on the rendered box and
// the text against the row's own font (canvas measureText) in a
// measure-then-fit loop, re-run whenever the row resizes.
import { useLayoutEffect, useRef, useState } from "react";

/** Middle ellipsis — the fallback when not even
 *  `…/name` fits the available width. */
export function truncateMid(value: string, length: number): string {
  if (value.length <= length) return value;
  if (length <= 0) return "";
  if (length === 1) return "…";
  const mid = (length - 1) / 2;
  const pre = value.substring(0, Math.floor(mid));
  const post = value.substring(value.length - Math.ceil(mid));
  return `${pre}…${post}`;
}

/** Truncate a path to exactly `length` CHARACTERS,
 *  spending them on the file name first and the directory prefix last. */
export function truncateScmPath(path: string, length: number): string {
  if (path.length <= length) return path;
  if (length <= 0) return "";
  if (length === 1) return "…";
  const lastSeparator = path.lastIndexOf("/");
  // No directory prefix, fall back to middle ellipsis.
  if (lastSeparator === -1) return truncateMid(path, length);
  const fileNameLength = path.length - lastSeparator - 1;
  // The file name prefixed with `…/` would already be too long.
  if (fileNameLength + 2 > length) return truncateMid(path, length);
  const pre = path.substring(0, length - fileNameLength - 2);
  const post = path.substring(lastSeparator);
  return `${pre}…${post}`;
}

/** Split the truncated text back into its dim
 *  directory prefix and its bright file name by matching the untruncated
 *  directory character by character; a `…` (and the `/` right after it) counts
 *  towards the directory, purely for looks. */
export function splitScmPath(truncated: string, directory: string): {
  directoryText: string;
  fileText: string;
} {
  let directoryLength = 0;
  for (let i = 0; i < truncated.length && i < directory.length; i += 1) {
    if (directory[i] === truncated[i]) {
      directoryLength += 1;
      continue;
    }
    if (truncated[i] === "…") {
      directoryLength += 1;
      if (truncated[i + 1] === "/") directoryLength += 1;
    }
    break;
  }
  return {
    directoryText: truncated.slice(0, directoryLength),
    fileText: truncated.slice(directoryLength),
  };
}

/** Binary search over character counts — the general fallback for a path
 *  without a directory (middle ellipsis), where no cheaper arithmetic holds. */
function fittingLengthBySearch(
  text: string,
  available: number,
  width: (value: string) => number,
): number {
  let low = 0;
  let high = text.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (width(truncateScmPath(text, middle)) <= available) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/** The longest character count whose truncation still FITS `available` px.
 *
 *  A `pre…/name` truncation only varies in how many DIRECTORY characters it
 *  keeps, so the fit is found by summing memoized per-character widths from
 *  the left until the `…/name` tail no longer fits, then confirmed with one
 *  real measurement (stepping down a character if kerning made the sum
 *  optimistic). The binary search this replaces measured ~8 fresh strings per
 *  row — a Source Control list of a few hundred changes spent 100ms+ in
 *  measureText on its first paint (user: 소스 제어 누르면 히칭). */
function fittingLength(
  text: string,
  available: number,
  width: (value: string) => number,
): number {
  if (width(text) <= available) return text.length;
  const lastSeparator = text.lastIndexOf("/");
  if (lastSeparator === -1) return fittingLengthBySearch(text, available, width);
  const tail = text.slice(lastSeparator);
  const tailWidth = width("…") + width(tail);
  if (tailWidth > available) return fittingLengthBySearch(text, available, width);
  const room = available - tailWidth;
  let used = 0;
  let kept = 0;
  while (kept < lastSeparator) {
    const next = used + width(text[kept]);
    if (next > room) break;
    used = next;
    kept += 1;
  }
  // truncateScmPath spends `length` as: kept + "…" + "/name".
  let length = kept + 1 + tail.length;
  const floor = tail.length + 1;
  while (length > floor && width(truncateScmPath(text, length)) > available) length -= 1;
  return length;
}

/** ONE 2D context per document, re-fonted per call: every row used to mint
 *  its own canvas + context on every measurement, and a windowed list of
 *  1,000+ changes minted dozens per scroll tick (CPU profile: canvas
 *  creation + getBoundingClientRect dominated the boot main thread). */
const measureContexts = new WeakMap<Document, CanvasRenderingContext2D | null>();
/** Text widths repeat heavily (same directories, same file names) — keep a
 *  bounded per-font memo so a re-measure after a resize is mostly lookups. */
const widthMemo = new Map<string, number>();
const WIDTH_MEMO_LIMIT = 4_000;

function measureContext(document: Document): CanvasRenderingContext2D | null {
  if (measureContexts.has(document)) return measureContexts.get(document) ?? null;
  const context = document.createElement("canvas").getContext("2d");
  measureContexts.set(document, context);
  return context;
}

/** Measures text in the row's OWN font, without reflowing anything. */
function measurerFor(element: HTMLElement): ((value: string) => number) | null {
  const view = element.ownerDocument?.defaultView;
  if (!view) return null;
  const context = measureContext(element.ownerDocument);
  if (!context) return null;
  const style = view.getComputedStyle(element);
  const font = style.font && style.font.trim()
    ? style.font
    : `${style.fontStyle || "normal"} ${style.fontWeight || "400"}`
      + ` ${style.fontSize || "12.5px"} ${style.fontFamily || "sans-serif"}`;
  return (value: string) => {
    const key = `${font}\u0000${value}`;
    const memo = widthMemo.get(key);
    if (memo !== undefined) return memo;
    if (context.font !== font) context.font = font;
    const width = context.measureText(value).width;
    if (widthMemo.size >= WIDTH_MEMO_LIMIT) widthMemo.clear();
    widthMemo.set(key, width);
    return width;
  };
}

export function ScmPathText({ path, name, title }: {
  /** The full path as it should read out loud (renames included). */
  path: string;
  /** Overrides the bright trailing segment (a rename reads `old → new`). */
  name?: string;
  /** Hover text; the full path is used on its own once the text truncates. */
  title?: string;
}) {
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const fileName = name ?? (slash >= 0 ? path.slice(slash + 1) : path);
  const fullText = `${directory}${fileName}`;
  const hostRef = useRef<HTMLSpanElement | null>(null);
  // `text` pins the measurement to the path it was taken for, so a row that
  // switches file renders its new path in full until it is measured again.
  const [measured, setMeasured] = useState<{ text: string; length: number }>(
    { text: fullText, length: fullText.length });

  useLayoutEffect(() => {
    const host = hostRef.current;
    const view = host?.ownerDocument?.defaultView;
    if (!host || !view) return;
    // ResizeObserver storms (the whole list re-laying out) re-enter here for
    // every row; an unchanged width is answered without touching layout.
    let lastAvailable = -1;
    const remeasure = () => {
      const available = host.getBoundingClientRect().width;
      if (available === lastAvailable) return;
      lastAvailable = available;
      const width = available > 0 ? measurerFor(host) : null;
      // Unmeasurable (no layout engine, detached row): render the full path.
      const length = width
        ? fittingLength(fullText, available - 1, width)
        : fullText.length;
      setMeasured((previous) => previous.text === fullText && previous.length === length
        ? previous
        : { text: fullText, length });
    };
    remeasure();
    if (typeof view.ResizeObserver === "function") {
      const observer = new view.ResizeObserver(() => remeasure());
      observer.observe(host);
      return () => observer.disconnect();
    }
    view.addEventListener("resize", remeasure);
    return () => view.removeEventListener("resize", remeasure);
  }, [fullText]);

  const length = measured.text === fullText ? measured.length : fullText.length;
  const shownText = length >= fullText.length
    ? fullText
    : truncateScmPath(fullText, length);
  const { directoryText, fileText } = splitScmPath(shownText, directory);
  // The tooltip appears once anything was dropped.
  const tooltip = title ?? (shownText === fullText ? "" : fullText);
  return <span ref={hostRef} className="dock-scm-file-copy"
    {...(tooltip ? { title: tooltip } : {})}>
    {directoryText ? <small className="dock-scm-file-path">{directoryText}</small> : null}
    <b className="dock-scm-file-name">{fileText}</b>
  </span>;
}
