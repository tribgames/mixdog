// VS Code output parity for editable log files. The text model keeps every
// source byte; this parser only describes which CSI sequences Monaco hides and
// which styles it paints over the remaining text.
export interface EditorAnsiStyle {
  foreground?: string;
  background?: string;
  underlineColor?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  hidden: boolean;
  strike: boolean;
  overline: boolean;
}

export interface EditorAnsiRange {
  start: number;
  end: number;
}

export interface EditorAnsiSpan extends EditorAnsiRange {
  style: EditorAnsiStyle;
}

export interface EditorAnsiParseResult {
  controls: EditorAnsiRange[];
  spans: EditorAnsiSpan[];
  visibleText: string;
}

export interface EditorAnsiDecoration extends EditorAnsiRange {
  className: string;
}

export interface EditorAnsiDecorationPlan extends EditorAnsiParseResult {
  decorations: EditorAnsiDecoration[];
  cssText: string;
}

// Defaults copied from VS Code's terminalColorRegistry.ts.
const ANSI_DARK = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510",
  "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543",
  "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5",
] as const;

const ANSI_LIGHT = [
  "#000000", "#cd3131", "#107c10", "#949800",
  "#0451a5", "#bc05bc", "#0598bc", "#555555",
  "#666666", "#cd3131", "#14ce14", "#b5ba00",
  "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5",
] as const;

const CSI_TERMINATOR = /^[ABCDHIJKfhmpsu]$/;

function defaultStyle(): EditorAnsiStyle {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
    hidden: false,
    strike: false,
    overline: false,
  };
}

function cloneStyle(style: EditorAnsiStyle): EditorAnsiStyle {
  return { ...style };
}

function resetStyle(style: EditorAnsiStyle): void {
  delete style.foreground;
  delete style.background;
  delete style.underlineColor;
  Object.assign(style, defaultStyle());
}

function byte(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(255, Math.round(value))) : 0;
}

function rgb(red: number, green: number, blue: number): string {
  return `rgb(${byte(red)}, ${byte(green)}, ${byte(blue)})`;
}

function ansi8BitColor(index: number, palette: readonly string[]): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return palette[index];
  if (index <= 231) {
    const value = index - 16;
    const blue = value % 6;
    const green = Math.floor(value / 6) % 6;
    const red = Math.floor(value / 36);
    const factor = 255 / 5;
    return rgb(red * factor, green * factor, blue * factor);
  }
  const level = Math.round(((index - 232) / 23) * 255);
  return rgb(level, level, level);
}

function setColor(
  style: EditorAnsiStyle,
  target: "foreground" | "background" | "underlineColor",
  codes: number[],
  index: number,
  palette: readonly string[],
): number {
  const mode = codes[index + 1];
  if (mode === 5 && Number.isFinite(codes[index + 2])) {
    const color = ansi8BitColor(codes[index + 2], palette);
    if (color) style[target] = color;
    return index + 2;
  }
  if (mode === 2 && [codes[index + 2], codes[index + 3], codes[index + 4]]
    .every(Number.isFinite)) {
    style[target] = rgb(codes[index + 2], codes[index + 3], codes[index + 4]);
    return index + 4;
  }
  return index;
}

function applySgr(style: EditorAnsiStyle, rawCodes: number[], palette: readonly string[]): void {
  const codes = rawCodes.length ? rawCodes : [0];
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) resetStyle(style);
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4 || code === 21) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 8) style.hidden = true;
    else if (code === 9) style.strike = true;
    else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 27) style.inverse = false;
    else if (code === 28) style.hidden = false;
    else if (code === 29) style.strike = false;
    else if (code === 39) style.foreground = undefined;
    else if (code === 49) style.background = undefined;
    else if (code === 53) style.overline = true;
    else if (code === 55) style.overline = false;
    else if (code === 59) style.underlineColor = undefined;
    else if (code === 38) index = setColor(style, "foreground", codes, index, palette);
    else if (code === 48) index = setColor(style, "background", codes, index, palette);
    else if (code === 58) index = setColor(style, "underlineColor", codes, index, palette);
    else if (code >= 30 && code <= 37) style.foreground = palette[code - 30];
    else if (code >= 90 && code <= 97) style.foreground = palette[code - 90 + 8];
    else if (code >= 40 && code <= 47) style.background = palette[code - 40];
    else if (code >= 100 && code <= 107) style.background = palette[code - 100 + 8];
  }
}

export function isAnsiOutputPath(path: string): boolean {
  return /\.(?:ansi|log|out|stderr|stdout)$/i.test(String(path || ""));
}

export function parseEditorAnsi(text: string, light = false): EditorAnsiParseResult {
  const source = String(text ?? "");
  const palette = light ? ANSI_LIGHT : ANSI_DARK;
  const controls: EditorAnsiRange[] = [];
  const spans: EditorAnsiSpan[] = [];
  const visibleParts: string[] = [];
  const style = defaultStyle();
  let visibleStart = 0;
  let current = 0;

  const flush = (end: number) => {
    if (end <= visibleStart) return;
    const value = source.slice(visibleStart, end);
    visibleParts.push(value);
    spans.push({ start: visibleStart, end, style: cloneStyle(style) });
  };

  while (current < source.length) {
    if (source.charCodeAt(current) !== 27 || source[current + 1] !== "[") {
      current += 1;
      continue;
    }
    const start = current;
    current += 2;
    let sequence = "";
    let found = false;
    while (current < source.length) {
      const character = source[current];
      sequence += character;
      current += 1;
      if (CSI_TERMINATOR.test(character)) {
        found = true;
        break;
      }
    }
    if (!found) {
      current = start + 1;
      continue;
    }

    flush(start);
    controls.push({ start, end: current });
    if (sequence.endsWith("m")) {
      const body = sequence.slice(0, -1);
      const values = body === "" ? [] : body.split(";").map(Number);
      if (values.every(Number.isFinite)) applySgr(style, values, palette);
    }
    visibleStart = current;
  }

  flush(source.length);
  return { controls, spans, visibleText: visibleParts.join("") };
}

function styleHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function declarationsFor(style: EditorAnsiStyle): string[] {
  let foreground = style.foreground;
  let background = style.background;
  if (style.inverse) {
    const nextForeground = background ?? "var(--mx-workspace-sheet)";
    const nextBackground = foreground ?? "var(--mx-text)";
    foreground = nextForeground;
    background = nextBackground;
  }
  const declarations: string[] = [];
  if (foreground) declarations.push(`color:${foreground}!important`);
  if (background) declarations.push(`background-color:${background}!important`);
  if (style.bold) declarations.push("font-weight:700");
  if (style.dim) declarations.push("opacity:.65");
  if (style.italic) declarations.push("font-style:italic");
  const lines = [
    style.underline ? "underline" : "",
    style.strike ? "line-through" : "",
    style.overline ? "overline" : "",
  ].filter(Boolean);
  if (lines.length) declarations.push(`text-decoration-line:${lines.join(" ")}`);
  if (style.underlineColor) declarations.push(`text-decoration-color:${style.underlineColor}`);
  if (style.hidden) declarations.push("visibility:hidden");
  return declarations;
}

export function editorAnsiDecorationPlan(text: string, light = false): EditorAnsiDecorationPlan {
  const parsed = parseEditorAnsi(text, light);
  const decorations: EditorAnsiDecoration[] = parsed.controls.map((range) => ({
    ...range,
    className: "editor-ansi-control",
  }));
  const rules = new Map<string, string>();
  for (const span of parsed.spans) {
    const declarations = declarationsFor(span.style);
    if (!declarations.length) continue;
    const declaration = declarations.join(";");
    const className = `editor-ansi-style-${styleHash(declaration)}`;
    rules.set(className, declaration);
    decorations.push({ start: span.start, end: span.end, className });
  }
  return {
    ...parsed,
    decorations,
    cssText: [...rules].map(([className, declaration]) =>
      `.monaco-editor .${className}{${declaration}}`).join("\n"),
  };
}

export function visibleEditorAnsiText(text: string): string {
  return parseEditorAnsi(text).visibleText;
}
