// --- Tool definitions for external models ---
//
// CANONICAL SOURCE for built-in tool schemas and annotations (compressible,
// readOnlyHint, destructiveHint, etc.). A description carries the tool's
// behavior, argument shapes, and the usage boundaries that only apply to that
// tool; cross-tool policy lives in rules/shared/*.md.
// Platform-specific command syntax belongs next to the command argument.
import { GIT_TOOL_DEF } from './git-command-tool.mjs';
import { PUBLIC_PATH_BATCH_LIMIT, PUBLIC_READ_WINDOW_MAX } from './arg-guard.mjs';
import { GITHUB_TOOL_DEF } from '../../../../github/tool.mjs';
import { envFlag } from '../../../../shared/env.mjs';
import {
  SHELL_HOLD_DEFAULT_MS,
  SHELL_HOLD_MAX_MS,
  SHELL_HOLD_MIN_MS,
  AGENT_TASK_WAIT_DEFAULT_MS,
  TASK_WAIT_DEFAULT_MS,
  TASK_WAIT_MAX_MS,
  TASK_WAIT_MIN_MS,
  budgetSeconds,
} from './wait-budgets.mjs';
// action=wait bounds, published by the schema below and clamped by the task
// tool; the values live in wait-budgets.mjs. The wait returns the instant the
// task settles or new user input or a task notification arrives, so the ceiling only bounds a
// still-running task; the floor keeps wait from collapsing into a busy poll.
export const TASK_WAIT_TIMEOUT_DEFAULT_MS = TASK_WAIT_DEFAULT_MS;
export const TASK_WAIT_TIMEOUT_MIN_MS = TASK_WAIT_MIN_MS;
export const TASK_WAIT_TIMEOUT_MAX_MS = TASK_WAIT_MAX_MS;
const _holdS = budgetSeconds(SHELL_HOLD_DEFAULT_MS);
const _shellSyntaxCheat =
  process.platform === 'win32'
    ? " PowerShell: ; between independent commands, if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } between dependent ones; no heredoc, </dev/null or | head/tail/wc (Select-Object -First/-Last); multiline python/node via @'…'@ | python - (node -); 2>$null; /c/→C:\\; $PID is reserved."
    : ' Bash: chain dependent commands with &&; multiline input via a quoted heredoc delimiter, not extra quoting/escape layers.';
// Process-stable switch used to describe foreground-only execution accurately.
const _shellBackgroundDisabled = envFlag('MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS');

export const BUILTIN_TOOLS = [
  {
    name: 'read',
    title: 'Read',
    annotations: {
      title: 'Read',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      compressible: false,
    },
    description:
      "Read file windows or images. One call per read stage: {file_path, offset, limit} entries for every located site (≤10 files per call), never a whole large file. Content in context is never read again. Missing paths are reported, never replaced. Directories: list. Binaries: bounded hex. Rows carry no line numbers; `[lines a-b]` gives each block's range. Never count rows: before writing a line number, copy it from grep, code_graph or git diff output; otherwise cite path and symbol.",
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          anyOf: [
            { type: 'string' },
            {
              type: 'array',
              minItems: 1,
              maxItems: PUBLIC_PATH_BATCH_LIMIT,
              items: {
                anyOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: {
                      file_path: { type: 'string' },
                      offset: { type: 'integer', minimum: 1 },
                      limit: { type: 'integer', minimum: 1, maximum: PUBLIC_READ_WINDOW_MAX },
                    },
                    required: ['file_path'],
                    additionalProperties: false,
                  },
                ],
              },
            },
          ],
          description:
            'Path(s) or {file_path, offset, limit} entries; overlapping windows of one file merge. A glob fans out to ≤10 newest files, 25 lines each.',
        },
        offset: {
          type: 'integer',
          minimum: 1,
          description: '1-based start line; default 1; batch default.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: PUBLIC_READ_WINDOW_MAX,
          description: 'Maximum line count; default 500 per exact file, 25 per glob-expanded file; batch default.',
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit',
    title: 'Edit',
    annotations: {
      title: 'Edit',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
      compressible: false,
      compressibleLossless: true,
    },
    description:
      'Replace exact text in one file. old_string must match once unless replace_all is true. Every non-overlapping edit of the stage in one response, using existing text, not text another edit creates; many files → one edit per file, all in that response. Widened replacements keep intervening lines verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to modify.',
        },
        old_string: {
          type: 'string',
          description:
            'Exact target text. Empty only to create a missing file or fill an empty file; never overwrites non-empty files and is not an absence check.',
        },
        new_string: {
          type: 'string',
          description: 'Replacement text; may be empty to delete. Must differ from old_string.',
        },
        replace_all: {
          type: 'boolean',
          default: false,
          description: 'Replace all occurrences of old_string; default false.',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'shell',
    title: 'Shell',
    annotations: {
      title: 'Shell',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      compressible: true,
    },
    description: `Run programs, builds, tests and computation. Never use shell commands or scripts for work covered by dedicated tools: cat/head/tail→read, ls→list, find→glob, filename lookup→find, grep/rg→grep, code structure→code_graph, file edits/writes (sed/awk/redirection)→edit/apply_patch, Git→git when that tool is on the surface. Tool names are not shell commands. ${_shellBackgroundDisabled ? 'Commands run in the foreground until completion.' : `Holds up to ${_holdS}s for the result. Still running at ${_holdS}s, or new user input or a task notification arrives: it moves to the background (never killed) and returns task_id plus output so far. Completion is delivered automatically; task wait only when you need the result now. If no execution slot frees, the command is queued as a background task. Dev servers/watchers: background:true, and stop them with task cancel when done.`}`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: `Command.${_shellSyntaxCheat}` },
        timeout_ms: {
          type: 'integer',
          minimum: 0,
          description: `Hard kill deadline in ms (omit or 0 = none), separate from the ${_holdS}s hold; set one for throwaway probes so a slow check fails fast.`,
        },
        wait_ms: {
          type: 'integer',
          minimum: SHELL_HOLD_MIN_MS,
          maximum: SHELL_HOLD_MAX_MS,
          description: `Hold in ms before a still-running command moves to the background (default ${SHELL_HOLD_DEFAULT_MS}). Usually omit.`,
        },
        background: {
          type: 'boolean',
          description:
            'Start in the background at once (servers, watchers, `npm run dev`); returns task_id right away.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  GIT_TOOL_DEF,
  GITHUB_TOOL_DEF,
  {
    name: 'task',
    title: 'Task',
    // destructiveHint is per TOOL, but destructiveness here is per ACTION:
    // only `cancel` terminates a process tree, while list/read/wait are
    // read-only. Declaring the tool destructive makes list/read/wait
    // inherit that hint and drops `task` out of read-only-selectable
    // surfaces, so the honest static shape is non-destructive; the cancel
    // path states its own outcome in the result body.
    annotations: {
      title: 'Task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description:
      'Manage shell tasks. Completion is delivered automatically; wait only when you need the result now, never poll with read. wait returns when the task finishes, or when new user input or any task notification arrives (the task keeps running). read/wait return new output, prioritizing the tail on completion. output:tail re-reads recent output without advancing the cursor; use read on the log path for omitted content.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Shell task_id; required for read/wait/cancel.' },
        action: {
          type: 'string',
          enum: ['list', 'read', 'wait', 'cancel'],
          description: 'list all; read next output; wait for completion and next output; cancel task.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 0,
          description: `Wait ceiling in ms; returns on completion, new user input or a task notification, else current output at the ceiling. Default ${TASK_WAIT_TIMEOUT_DEFAULT_MS} (agents ${AGENT_TASK_WAIT_DEFAULT_MS}); clamped to ${TASK_WAIT_TIMEOUT_MIN_MS}-${TASK_WAIT_TIMEOUT_MAX_MS}.`,
        },
        output: {
          type: 'string',
          enum: ['new', 'tail'],
          description:
            'read/wait only. Default new; tail replays recent output after an interruption or context loss. Up to 8 KiB per stream while running, 12 KiB on completion or replay; original logs are preserved.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'grep',
    title: 'Grep',
    annotations: {
      title: 'Grep',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      compressible: true,
    },
    description:
      'Search literal/regex file contents (single-line ripgrep); returns path:line blocks with context, patch-ready. Broad reconnaissance: mode:files; locating: context:0; every pattern and scope in one call, and the anchors are the windows for one read. Symbol relations: code_graph.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 10 }],
          description: 'Ripgrep regex(es); escape literal metacharacters.',
        },
        path: {
          anyOf: [
            { type: 'string' },
            { type: 'array', minItems: 1, maxItems: PUBLIC_PATH_BATCH_LIMIT, items: { type: 'string' } },
          ],
          description:
            'Plain file/directory scopes; omit for Project root. Every pattern searches every path; pattern/path pairs need separate calls.',
        },
        glob: {
          type: 'string',
          description:
            'Relative glob filter evaluated inside path, e.g. "*.cs" or "src/**/*.ts"; for exact/absolute paths use path instead.',
        },
        mode: {
          type: 'string',
          enum: ['content', 'files', 'count'],
          description: 'content default; files lists matching paths; count totals all patterns together per file.',
        },
        limit: {
          type: 'integer',
          minimum: 0,
          description:
            'Requested results; default 250; 0 unlimited. Context output caps at 40 blocks; continue via the returned offset.',
        },
        offset: { type: 'integer', minimum: 0, description: 'Result offset.' },
        context: {
          type: 'integer',
          minimum: 0,
          maximum: 200,
          description: 'Omit for automatic context; 0 for matches only.',
        },
        include_noise: {
          type: 'boolean',
          description: 'Also search gitignored trees.',
        },
        text: {
          type: 'boolean',
          description: 'Search binary data as text (archives/Git objects not decoded).',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'glob',
    title: 'Glob',
    annotations: {
      title: 'Glob',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      compressible: true,
    },
    description:
      'Wildcard file-path lookup under a known directory; directories never match. Omit path for the current Project; no preliminary listing. Unknown base: find first with a known path fragment. Gitignored paths need include_noise:true.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 10 }],
          description: 'Union of patterns under one base; separate calls for other bases or per-pattern results.',
        },
        path: {
          type: 'string',
          description: 'Known existing base directory; omit for the current Project.',
        },
        sort: {
          type: 'string',
          enum: ['natural', 'mtime'],
          description: 'mtime default (newest first); natural = raw walk order, cheaper on huge trees.',
        },
        limit: { type: 'integer', minimum: 0, description: 'Max entries; default 100; 0 unlimited.' },
        offset: { type: 'integer', minimum: 0, description: 'Entry offset.' },
        include_noise: {
          type: 'boolean',
          description: 'Also search gitignored trees.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'find',
    title: 'Find Files',
    annotations: {
      title: 'Find Files',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      compressible: true,
    },
    description:
      'Fuzzy filename/directory path lookup; returns paths only. Only when the target path is unknown and cannot be directly resolved but a fragment is known; general discovery: glob.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          pattern: '\\S',
          description: 'Non-empty filename/path fragment; space-separated fragments AND-match within one path.',
        },
        path: { type: 'string', description: 'Base directory; omit for the current Project.' },
        limit: { type: 'integer', minimum: 0, description: 'Max paths; default 25; 0 unlimited.' },
        include_noise: { type: 'boolean', description: 'Also search gitignored trees.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'list',
    title: 'List Directory',
    annotations: {
      title: 'List Directory',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      compressible: true,
    },
    description:
      "Return a known directory's immediate entries (path + type); no wildcard. Only when those entries or metadata are needed, not to re-confirm a known listing or before read/glob.",
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Known directory; defaults to the current Project.',
        },
        hidden: { type: 'boolean', description: 'Include dotfiles.' },
        meta: {
          type: 'boolean',
          description: 'Per-entry size bytes, UTC mtime, octal mode; text files also get a line count.',
        },
        limit: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'Max entries; default 100; 0 = no page cap (absolute cap still applies).',
        },
        offset: { type: 'integer', minimum: 0, description: 'Entry offset.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
];
