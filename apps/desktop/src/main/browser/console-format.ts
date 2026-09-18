/**
 * What a console line actually says. Chromium hands over structured argument
 * objects: reading only their `value` drops every object and array, which is
 * exactly what a failing page logs, and a message without its script and line
 * cannot be traced back to the code that produced it.
 */

export interface BrowserConsoleArgument {
  type?: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  preview?: {
    description?: string;
    overflow?: boolean;
    properties?: Array<{ name?: string; value?: string }>;
  };
}

const MAX_PREVIEW_PROPERTIES = 12;

function formatArgument(argument: BrowserConsoleArgument | undefined): string {
  if (!argument) return '';
  if (argument.value !== undefined) {
    if (typeof argument.value === 'string') return argument.value;
    try {
      return JSON.stringify(argument.value) ?? String(argument.value);
    } catch {
      return String(argument.value);
    }
  }
  const preview = argument.preview;
  const properties = preview?.properties?.slice(0, MAX_PREVIEW_PROPERTIES) || [];
  if (properties.length) {
    const body = properties.map((property) => `${property.name}: ${property.value}`).join(', ');
    const overflow = preview?.overflow || (preview?.properties?.length || 0) > properties.length ? ', …' : '';
    const label = preview?.description && preview.description !== 'Object' ? `${preview.description} ` : '';
    return `${label}{${body}${overflow}}`;
  }
  return argument.description || preview?.description || argument.subtype || argument.type || '';
}

export function formatConsoleArguments(args: BrowserConsoleArgument[]): string {
  return args.map(formatArgument).filter(Boolean).join(' ');
}

/** Chromium counts lines from zero; a reader counts from one. */
export function formatConsoleSource(url: string, lineNumber?: unknown): string {
  if (!url) return '';
  const line = Number(lineNumber);
  return Number.isFinite(line) ? ` (${url}:${Math.trunc(line) + 1})` : ` (${url})`;
}
