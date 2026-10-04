import { tExisting } from './i18n';
import { toolActivityCodeLanguage } from './transcript-tool-format';

/** One displayed line: `line` is its number in the file, or null for a row
 *  that is not file content (an error or a note inside a section). */
export interface ToolOutputRow {
  line: number | null;
  text: string;
}

/** A run of rows that belong to one file (or one labelled group). */
export interface ToolOutputSection {
  /** Label of a group that names no file ("best declaration candidate"). */
  title: string;
  path: string;
  /** The first line the section shows, for opening the file there. */
  line?: number;
  meta: string;
  language: string;
  rows: ToolOutputRow[];
}

export interface ToolFileEntry {
  path: string;
  name: string;
  dir: string;
  kind: 'file' | 'dir';
}

type SectionTool = 'read' | 'grep' | 'code_graph';

const READ_ROW = /^(\d+)→(.*)$/;
const MATCH_ROW = /^\s*(\d+)[:-] ?(.*)$/;
const READ_FILE = /^(\S.*?) \[([^\]]+)\]$/;
const READ_PREFACE = /^read \d+$/;
const READ_RUN_FOOTER = /^\[lines \d+-\d+(?: of \d+)?\]$/;
const HASH_HEADER = /^# (.+)$/;
const GROUP_FILE = /^(\S.*?)(?: \((\d+) hits\))?$/;
const PATH_LOCATION = /:\d+(?:-\d+)?(?::\d+)?$/;

function looksLikePath(token: string): boolean {
  if (!token || /^(?:pattern|patterns|paths?)[:=]/.test(token)) return false;
  return /[\\/]/.test(token) || /\.[A-Za-z0-9]{1,12}$/.test(token);
}

/** The file a header names: its last token for `# grep src/a.ts`, its first
 *  for `src/a.ts:8-15:17 (javascript, …)`. */
function headerTarget(text: string): { path: string; rest: string } {
  const tokens = text.trim().split(/\s+/);
  const last = tokens[tokens.length - 1].replace(PATH_LOCATION, '');
  if (looksLikePath(last)) return { path: last, rest: '' };
  const first = tokens[0].replace(PATH_LOCATION, '');
  if (looksLikePath(first)) return { path: first, rest: tokens.slice(1).join(' ') };
  return { path: '', rest: text.trim() };
}

function emptySection(title: string, path: string, meta = ''): ToolOutputSection {
  return { title, path, meta, language: '', rows: [] };
}

function finishSection(section: ToolOutputSection, tool: SectionTool): ToolOutputSection | null {
  // A blank note row closes nothing; a blank numbered row is the file's own.
  for (let last = section.rows.at(-1); last && last.line == null && !last.text.trim(); last = section.rows.at(-1)) {
    section.rows.pop();
  }
  if (!section.rows.length) return null;
  const numbered = section.rows.filter((row) => row.line != null);
  if (numbered.length) {
    const first = numbered[0].line as number;
    const last = numbered[numbered.length - 1].line as number;
    section.line = first;
    section.language = toolActivityCodeLanguage(section.path);
    if (!section.meta) {
      section.meta =
        tool === 'read'
          ? first === last
            ? String(first)
            : `${first}–${last}`
          : tExisting('{{count}} matches', `${numbered.length} ${numbered.length === 1 ? 'match' : 'matches'}`, {
              count: numbered.length,
            });
    }
  }
  return section;
}

/** A read, grep or code-graph result cut into per-file sections of numbered
 *  rows. Empty when the text carries neither a numbered row nor a file header,
 *  so a bare status or a files-only listing stays plain text. */
export function toolOutputSections(text: string, tool: SectionTool, defaultPath = ''): ToolOutputSection[] {
  const rowPattern = tool === 'read' ? READ_ROW : MATCH_ROW;
  const lines = text.split('\n');
  const sections: ToolOutputSection[] = [];
  let current = emptySection('', defaultPath);
  let numbered = 0;
  let named = 0;
  const open = (next: ToolOutputSection) => {
    const done = finishSection(current, tool);
    if (done) sections.push(done);
    current = next;
    if (next.path) named += 1;
  };
  lines.forEach((line, index) => {
    const row = rowPattern.exec(line);
    if (row) {
      numbered += 1;
      current.rows.push({ line: Number(row[1]), text: row[2] });
      return;
    }
    const trimmed = line.trim();
    if (tool === 'read') {
      if (READ_PREFACE.test(trimmed) || READ_RUN_FOOTER.test(trimmed)) return;
      const file = READ_FILE.exec(trimmed);
      if (file) {
        open(emptySection('', file[1], file[2] === 'ok' ? '' : file[2]));
        return;
      }
    } else {
      const hash = HASH_HEADER.exec(trimmed);
      if (hash) {
        const target = headerTarget(hash[1]);
        open(emptySection(target.path ? '' : target.rest, target.path));
        return;
      }
      const group = !/^\s/.test(line) && rowPattern.test(lines[index + 1] ?? '') ? GROUP_FILE.exec(trimmed) : null;
      if (group) {
        const target = headerTarget(group[1]);
        if (target.path) {
          open(emptySection('', target.path, target.rest));
          return;
        }
      }
    }
    if (!trimmed && !current.rows.length) return;
    current.rows.push({ line: null, text: line });
  });
  const last = finishSection(current, tool);
  if (last) sections.push(last);
  return numbered || named ? sections : [];
}

/** A whole file as one section, numbered from 1. */
export function toolFileSection(text: string, path: string): ToolOutputSection {
  const rows = text
    .replace(/\n$/, '')
    .split('\n')
    .map((line, index) => ({ line: index + 1, text: line }));
  return { title: '', path, meta: '', language: toolActivityCodeLanguage(path), rows };
}

const LIST_ROW = /^(.+)\t(file|dir)$/;

function fileEntry(path: string, kind: 'file' | 'dir'): ToolFileEntry {
  const clean = path.replace(/[\\/]+$/, '');
  const cut = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return { path: clean, name: clean.slice(cut + 1), dir: cut > 0 ? clean.slice(0, cut) : '', kind };
}

/** A glob, find or list result as file rows. Lines that are not paths come
 *  back as notes; a result that is mostly not paths is not a listing at all. */
export function toolFileEntries(text: string, basePath = ''): { entries: ToolFileEntry[]; notes: string[] } {
  const entries: ToolFileEntry[] = [];
  const notes: string[] = [];
  const base = basePath.replace(/[\\/]+$/, '');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const listed = LIST_ROW.exec(trimmed);
    if (listed) {
      const entry = fileEntry(base ? `${base}/${listed[1]}` : listed[1], listed[2] as 'file' | 'dir');
      entries.push({ ...entry, dir: '' });
    } else if (trimmed.length < 400 && !/^[([#]|^Error\b/.test(trimmed) && looksLikePath(trimmed)) {
      entries.push(fileEntry(trimmed, /[\\/]$/.test(trimmed) ? 'dir' : 'file'));
    } else {
      notes.push(line);
    }
  }
  return entries.length && notes.length <= entries.length / 4 + 2 ? { entries, notes } : { entries: [], notes: [] };
}
