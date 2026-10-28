/**
 * Request parsing and target resolution for the agent `visualize` tool. A file
 * target may live anywhere; it is rooted in the session's cwd when it resolves
 * inside it, else in its own folder. Capture and export outputs must stay
 * inside the session's cwd after symlinks resolve; web targets are http(s) only.
 */
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  MAX_VISUALIZE_INLINE_BYTES,
  VISUALIZE_INLINE_KINDS,
  type VisualizeInlineContent,
  type VisualizePaneKind,
  visualizeKindForPath,
} from '../../shared/visualize';

export const MAX_VISUALIZE_TARGETS = 3;
const MAX_LABEL_CHARS = 120;
const MAX_SELECTOR_CHARS = 500;
const MAX_MARK_LABEL_CHARS = 80;
const MAX_MARKS_PER_CALL = 20;
const SESSION_ID = /^[\w.:-]{1,200}$/;
const CALL_ID = /^[\w.:|-]{1,200}$/;

export type VisualizeAction = 'open' | 'close' | 'annotate' | 'capture' | 'export' | 'check' | 'inspect';

/** Viewport bounds `inspect` accepts, in CSS px. */
export const INSPECT_VIEWPORT_MIN = 200;
export const INSPECT_VIEWPORT_MAX_WIDTH = 3000;
export const INSPECT_VIEWPORT_MAX_HEIGHT = 4000;
export const INSPECT_VIEWPORT_DEFAULT_HEIGHT = 800;

export interface VisualizeMark {
  selector: string;
  label?: string;
}

export type VisualizeAnnotateOp =
  | { add: VisualizeMark[]; remove?: undefined; clear?: undefined }
  | { remove: string[]; add?: undefined; clear?: undefined }
  | { clear: true; add?: undefined; remove?: undefined };

export type VisualizeRequest =
  | {
      sessionId: string;
      cwd: string;
      action: 'open';
      /** Empty when `content` is given (the two are exclusive). */
      targets: string[];
      content?: VisualizeInlineContent;
      label?: string;
      version?: number;
      /** The open only checks the agent's own work: the tab is never shown to
       *  the user and closes when the turn ends. */
      verify?: boolean;
      /** The agent's tool call id for this open (absent from a runtime that
       *  does not send it): what the turn-end record names. */
      callId?: string;
    }
  | { sessionId: string; cwd: string; action: 'close'; tab?: string }
  | { sessionId: string; cwd: string; action: 'annotate'; tab: string; op: VisualizeAnnotateOp }
  | { sessionId: string; cwd: string; action: 'capture'; tab: string; output: string }
  | {
      sessionId: string;
      cwd: string;
      action: 'export';
      tab: string;
      format: 'png' | 'pdf';
      output: string;
      version?: number;
      overwrite?: boolean;
    }
  | { sessionId: string; cwd: string; action: 'check'; tab: string }
  | {
      sessionId: string;
      cwd: string;
      action: 'inspect';
      tab: string;
      /** Lay the page out at this size while reading it; absent = as shown. */
      viewport?: { width: number; height: number };
      /** Scope the read-out to this subtree. */
      selector?: string;
    };

export type VisualizeTarget =
  | { kind: 'url'; target: string; url: string; label: string }
  | {
      kind: VisualizePaneKind;
      target: string;
      path: string;
      label: string;
      /** The folder (symlink-resolved) the file and its page assets must stay
       *  inside: the cwd when the file resolves inside it, else its own folder. */
      root: string;
    };

/** An output that resolves outside the session's cwd. */
export class OutsideWorkingDirectoryError extends Error {
  constructor(raw: string) {
    super(`output is outside the working directory: ${raw}`);
    this.name = 'OutsideWorkingDirectoryError';
  }
}

/** A file target that resolves outside every folder recorded for it (a
 *  parent swapped for a link, or a reopen naming a file the session never
 *  opened outside its working directory). */
export class OutsideRecordedRootError extends Error {
  constructor(raw: string) {
    super(`target resolves outside the folder recorded for it: ${raw}`);
    this.name = 'OutsideRecordedRootError';
  }
}

/** A file target that no longer exists (deleted, or its folder removed). */
export class TargetNotFoundError extends Error {
  constructor(raw: string) {
    super(`target not found: ${raw}`);
    this.name = 'TargetNotFoundError';
  }
}

/** True when `error` says a tab's file is gone (a missing target, or the
 *  file system's ENOENT from a later step such as the media stat). */
export const isFileMissing = (error: unknown): boolean =>
  error instanceof TargetNotFoundError || (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  const clean = value.trim();
  if (clean.length > max) throw new Error(`${name} must be at most ${max} characters`);
  if (clean.includes('\0')) throw new Error(`${name} is invalid`);
  return clean;
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : text(value, name, max);
}

function parseInspectViewport(value: unknown): { width: number; height: number } {
  const size = (raw: unknown, name: string, max: number): number => {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < INSPECT_VIEWPORT_MIN || raw > max) {
      throw new Error(`viewport.${name} must be a whole number of pixels from ${INSPECT_VIEWPORT_MIN} to ${max}`);
    }
    return raw;
  };
  if (!isRecord(value)) throw new Error('viewport must be { width, height? }');
  return {
    width: size(value.width, 'width', INSPECT_VIEWPORT_MAX_WIDTH),
    height:
      value.height === undefined || value.height === null
        ? INSPECT_VIEWPORT_DEFAULT_HEIGHT
        : size(value.height, 'height', INSPECT_VIEWPORT_MAX_HEIGHT),
  };
}

function parseAnnotateOp(input: Record<string, unknown>): VisualizeAnnotateOp {
  const given = ['add', 'remove', 'clear'].filter((key) => input[key] !== undefined);
  if (given.length !== 1) throw new Error('annotate takes exactly one of add, remove, or clear');
  if (input.clear !== undefined) {
    if (input.clear !== true) throw new Error('clear must be true');
    return { clear: true };
  }
  if (input.remove !== undefined) {
    const list = Array.isArray(input.remove) ? input.remove : [input.remove];
    if (!list.length || list.length > MAX_MARKS_PER_CALL) {
      throw new Error(`remove takes 1-${MAX_MARKS_PER_CALL} selectors`);
    }
    return { remove: list.map((entry) => text(entry, 'selector', MAX_SELECTOR_CHARS)) };
  }
  const list = Array.isArray(input.add) ? input.add : [input.add];
  if (!list.length || list.length > MAX_MARKS_PER_CALL) throw new Error(`add takes 1-${MAX_MARKS_PER_CALL} marks`);
  return {
    add: list.map((entry) => {
      if (!isRecord(entry)) throw new Error('each add entry must be { selector, label? }');
      const label = optionalText(entry.label, 'label', MAX_MARK_LABEL_CHARS);
      return { selector: text(entry.selector, 'selector', MAX_SELECTOR_CHARS), ...(label ? { label } : {}) };
    }),
  };
}

/** `input.content` of an `open`: a direct renderer's source, instead of
 *  targets. The source is kept verbatim (a chart's JSON, a diagram's text). */
function parseInlineContent(input: Record<string, unknown>): VisualizeInlineContent | undefined {
  const content = input.content;
  if (content === undefined || content === null) return undefined;
  if (input.targets !== undefined && input.targets !== null) {
    throw new Error('pass either input.targets or input.content, not both');
  }
  if (!isRecord(content)) throw new Error('content must be { kind, source, title? }');
  const kind = VISUALIZE_INLINE_KINDS.find((candidate) => candidate === content.kind);
  if (!kind) throw new Error(`content.kind must be one of ${VISUALIZE_INLINE_KINDS.join(', ')}`);
  const source = content.source;
  if (typeof source !== 'string' || !source.trim()) throw new Error('content.source must be a non-empty string');
  if (Buffer.byteLength(source) > MAX_VISUALIZE_INLINE_BYTES) {
    throw new Error(`content.source must be at most ${MAX_VISUALIZE_INLINE_BYTES / 1024} KiB`);
  }
  const title = optionalText(content.title, 'content.title', MAX_LABEL_CHARS);
  return { kind, source, ...(title ? { title } : {}) };
}

/** `input.version`: a kept version number, or absent (undefined). */
function parseVersion(version: unknown): number | undefined {
  if (version === undefined || version === null) return undefined;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('version must be a positive integer (a kept version number)');
  }
  return version;
}

/** Validate one bridge request `{ sessionId, cwd, action, input }`. */
export function parseVisualizeRequest(raw: unknown): VisualizeRequest {
  if (!isRecord(raw)) throw new Error('visualize request must be an object');
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
  if (!SESSION_ID.test(sessionId)) throw new Error('sessionId is invalid');
  const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : '';
  if (!cwd || !isAbsolute(cwd) || cwd.includes('\0')) throw new Error('cwd must be an absolute path');
  const input = raw.input === undefined || raw.input === null ? {} : raw.input;
  if (!isRecord(input)) throw new Error('input must be an object');
  const base = { sessionId, cwd: resolve(cwd) };
  switch (raw.action) {
    case 'open': {
      const content = parseInlineContent(input);
      let list: unknown[] = [];
      if (!content) {
        if (Array.isArray(input.targets)) list = input.targets;
        else if (input.targets !== undefined) list = [input.targets];
      }
      if (!content && (list.length < 1 || list.length > MAX_VISUALIZE_TARGETS)) {
        throw new Error(`targets must list 1-${MAX_VISUALIZE_TARGETS} files or URLs (or pass input.content instead)`);
      }
      const label = optionalText(input.label, 'label', MAX_LABEL_CHARS);
      const version = parseVersion(input.version);
      if (input.verify !== undefined && input.verify !== null && typeof input.verify !== 'boolean')
        throw new Error('verify must be a boolean');
      const callId = typeof raw.callId === 'string' && CALL_ID.test(raw.callId) ? raw.callId : '';
      return {
        ...base,
        action: 'open',
        ...(callId ? { callId } : {}),
        targets: list.map((entry) => text(entry, 'target', 4096)),
        ...(content ? { content } : {}),
        ...(label ? { label } : {}),
        ...(typeof version === 'number' ? { version } : {}),
        ...(input.verify === true ? { verify: true } : {}),
      };
    }
    case 'close': {
      const tab = optionalText(input.tab, 'tab', 64);
      return { ...base, action: 'close', ...(tab ? { tab } : {}) };
    }
    case 'annotate':
      return { ...base, action: 'annotate', tab: text(input.tab, 'tab', 64), op: parseAnnotateOp(input) };
    case 'capture':
      return {
        ...base,
        action: 'capture',
        tab: text(input.tab, 'tab', 64),
        output: text(input.output, 'output', 4096),
      };
    case 'export': {
      const format = input.format;
      if (format !== 'png' && format !== 'pdf') throw new Error('format must be png or pdf');
      const version = parseVersion(input.version);
      if (input.overwrite !== undefined && typeof input.overwrite !== 'boolean')
        throw new Error('overwrite must be a boolean');
      return {
        ...base,
        action: 'export',
        tab: text(input.tab, 'tab', 64),
        format,
        output: text(input.output, 'output', 4096),
        ...(typeof version === 'number' ? { version } : {}),
        ...(input.overwrite === true ? { overwrite: true } : {}),
      };
    }
    case 'check':
      return { ...base, action: 'check', tab: text(input.tab, 'tab', 64) };
    case 'inspect': {
      const selector = optionalText(input.selector, 'selector', MAX_SELECTOR_CHARS);
      return {
        ...base,
        action: 'inspect',
        tab: text(input.tab, 'tab', 64),
        ...(input.viewport === undefined || input.viewport === null
          ? {}
          : { viewport: parseInspectViewport(input.viewport) }),
        ...(selector ? { selector } : {}),
      };
    }
    default:
      throw new Error('action must be one of open, close, annotate, capture, export, check, inspect');
  }
}

/** True when `target` is `root` itself or below it. */
export function insidePath(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export { visualizeKindForPath };

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

type FileTarget = Exclude<VisualizeTarget, { kind: 'url' }>;

/** An existing supported file `raw` (relative paths from `cwd`, symlinks
 *  resolved), rooted where `rootOf` says for its resolved path. */
async function resolveFile(
  cwd: string,
  raw: string,
  rootOf: (real: string) => Promise<string> | string
): Promise<FileTarget> {
  const requested = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    throw new TargetNotFoundError(raw);
  }
  if (!(await stat(real)).isFile()) throw new Error(`target is not a file: ${raw}`);
  const kind = visualizeKindForPath(real);
  if (!kind) {
    throw new Error(
      `unsupported file type: ${raw} (supported: HTML, PDF, Word/Excel/PowerPoint/OpenDocument, images, audio, video, or an http(s) URL)`
    );
  }
  return { kind, target: raw, path: real, label: fileTabLabel(real), root: await rootOf(real) };
}

/** A file tab's name: the file's own, or its folder's when the file is an
 *  index page (`mockups/login/index.html` is "login"), matching its preview
 *  tile in the transcript. */
function fileTabLabel(path: string): string {
  const name = basename(path);
  const folder = basename(dirname(path));
  return /^index\.[^.]+$/i.test(name) && folder && folder !== dirname(path) ? folder : name;
}

/** Resolve one target of the agent tool's `open` (the only caller that may
 *  name any file): an http(s) URL, or an existing supported file anywhere
 *  (relative paths from `cwd`, symlinks resolved), rooted in `cwd` when it
 *  lies inside it, else in its own folder. */
export async function resolveVisualizeTarget(cwd: string, raw: string): Promise<VisualizeTarget> {
  if (URL_SCHEME.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`invalid URL: ${raw}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`only http(s) URLs can be visualized: ${raw}`);
    }
    return { kind: 'url', target: raw, url: url.href, label: `${url.host}${url.pathname === '/' ? '' : url.pathname}` };
  }
  return resolveFile(cwd, raw, async (real) => {
    const realCwd = await realpath(cwd).catch(() => null);
    return realCwd && insidePath(realCwd, real) ? realCwd : dirname(real);
  });
}

/** Resolve a file target for anything but the agent's `open` (a reload, a
 *  restore, a reopen from the panel or a paired device): it must resolve
 *  inside one of `roots` (resolved folders already recorded for it), which
 *  becomes its root. No other folder is ever authorized here. */
export async function resolveTargetWithin(cwd: string, raw: string, roots: readonly string[]): Promise<FileTarget> {
  return resolveFile(cwd, raw, (real) => {
    const root = roots.find((candidate) => insidePath(candidate, real));
    if (!root) throw new OutsideRecordedRootError(raw);
    return root;
  });
}

/** Resolve a `capture` output: a `.png` path inside `cwd`, with its folder
 *  created. A symlinked folder or file must still land inside `cwd`, and no
 *  folder is created until the nearest existing ancestor resolves inside it. */
export async function resolveCaptureOutput(cwd: string, raw: string): Promise<string> {
  if (!/\.png$/i.test(raw)) throw new Error('output must be a .png path');
  return resolveProjectOutput(cwd, raw);
}

/** Resolve any output file path inside `cwd` (the checks of `resolveCaptureOutput`
 *  without the extension rule), with its folder created. */
export async function resolveProjectOutput(cwd: string, raw: string): Promise<string> {
  const requested = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  if (!insidePath(cwd, requested) || requested === resolve(cwd)) {
    throw new OutsideWorkingDirectoryError(raw);
  }
  const realCwd = await realpath(cwd);
  // Lexically inside cwd and cwd exists, so this stops at cwd at the latest.
  let ancestor = dirname(requested);
  while (!(await lstat(ancestor).catch(() => null))) ancestor = dirname(ancestor);
  if (!insidePath(realCwd, await realpath(ancestor))) throw new OutsideWorkingDirectoryError(raw);
  await mkdir(dirname(requested), { recursive: true });
  const parent = await realpath(dirname(requested));
  if (!insidePath(realCwd, parent)) throw new OutsideWorkingDirectoryError(raw);
  const file = resolve(parent, basename(requested));
  const existing = await lstat(file).catch(() => null);
  if (existing) {
    if (existing.isDirectory()) throw new Error(`output is a directory: ${raw}`);
    if (existing.isSymbolicLink() && !insidePath(realCwd, await realpath(file))) {
      throw new OutsideWorkingDirectoryError(raw);
    }
  }
  return file;
}
