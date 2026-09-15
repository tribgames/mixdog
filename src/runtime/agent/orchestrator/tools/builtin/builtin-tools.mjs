// --- Tool definitions for external models ---
//
// CANONICAL SOURCE for built-in tool schemas and annotations (compressible,
// readOnlyHint, destructiveHint, etc.). A description carries the tool's
// behavior, argument shapes, and the usage boundaries that only apply to that
// tool; cross-tool policy lives in rules/shared/*.md.
// Platform-specific command syntax belongs next to the command argument.
import { GIT_STAGE_TOOL_DEF, GIT_TOOL_DEF } from './git-command-tool.mjs';
import { PUBLIC_PATH_BATCH_LIMIT, PUBLIC_READ_WINDOW_MAX } from './arg-guard.mjs';
import { GITHUB_TOOL_DEF } from '../../../../github/tool.mjs';
import { envFlag } from '../../../../shared/env.mjs';
// action=wait ceiling, colocated with the schema that publishes it so the
// documented bounds and the runtime clamp cannot drift. The wait returns the
// instant the task settles, so the ceiling only bounds how long a STILL-running
// task may hold the call. The floor is the load-bearing part: measured runs
// show a caller with no wait primitive re-reading the same task every 2-3 s
// (177 reads in one trial), and a caller that can pass a timeout occasionally
// asks for 1 s. Both collapse into a busy loop without a floor.
//
// The ceiling is bounded at 10 min for the mirror-image failure: a single wait
// holding the ONLY decision point for longer than the caller's whole remaining
// budget. Measured run: one `wait` with timeout_ms 2_400_000 blocked 1_611 s of
// an 1_800 s budget and the caller never got another turn — no partial result,
// no alternative path. A still-running task returns its current output at the
// ceiling, so the caller re-decides and may wait again; nothing is lost except
// the unbounded block. 10 min also matches the reference agent's equivalent
// wait primitive, which caps at 600_000 ms.
export const TASK_WAIT_TIMEOUT_DEFAULT_MS = 60_000;
export const TASK_WAIT_TIMEOUT_MIN_MS = 10_000;
export const TASK_WAIT_TIMEOUT_MAX_MS = 600_000;
const _shellSyntaxCheat =
    process.platform === 'win32'
        ? ' PowerShell: use ; between independent commands; use if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } between dependent commands; single-quote inline scripts, avoid nested double quotes; /c/→C:\\; $PID is reserved. For multiline program input, use a literal here-string.'
        : ' Bash: chain dependent commands with &&; multiline input via a quoted heredoc delimiter, not extra quoting/escape layers.';
// Process-stable switch used to describe foreground-only execution accurately.
const _shellBackgroundDisabled = envFlag('MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS');

export const BUILTIN_TOOLS = [
    {
        name: 'read',
        title: 'Read',
        annotations: { title: 'Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false },
        description: 'Read known file ranges or images. Batch independent files or windows, including several windows of one file, in one file_path array; if the shared output cap forces separate calls, issue them together. Missing exact paths are reported, never replaced. Reuse unchanged content already in context. Directories: use list. Binaries return bounded hex.',
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
                                            offset: { type: 'integer', minimum: 1, maximum: PUBLIC_READ_WINDOW_MAX },
                                            limit: { type: 'integer', minimum: 1, maximum: PUBLIC_READ_WINDOW_MAX },
                                        },
                                        required: ['file_path'],
                                        additionalProperties: false,
                                    },
                                ],
                            },
                        },
                    ],
                    description: 'Path(s) or {file_path, offset, limit} entries; repeat a path for several ranges. Entry windows override batch defaults; overlapping windows of one file merge. A glob fans out to at most 10 newest files, 25 lines each, sharing 10 KB. Call output caps at 50 KB.',
                },
                offset: {
                    type: 'integer',
                    minimum: 1,
                    maximum: PUBLIC_READ_WINDOW_MAX,
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
        annotations: { title: 'Edit', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, compressible: false, compressibleLossless: true },
        description: 'Replace exact text in one file. old_string must match once unless replace_all is true. Batch non-overlapping edits in call order using existing text, not text another edit creates. Widened replacements must keep intervening lines verbatim. Call this tool directly, not as a shell command.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',                    description: 'Path to the file to modify.',
                },
                old_string: {
                    type: 'string',
                    description: 'Exact target text. Empty only to create a missing file or fill an empty file; never overwrites non-empty files and is not an absence check.',
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
        annotations: { title: 'Shell', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, compressible: true },
        description: `Run programs, builds, tests and computation. Never for files, search or Git (cat/head/tail→read, ls→list, find→glob, grep/rg→grep, code_graph, git, edit/apply_patch); tool names run as tools, never as shell commands — no \`edit/apply_patch <<EOF\`. ${_shellBackgroundDisabled ? 'Commands run in the foreground until completion.' : 'After a 10s foreground window (not a timeout), unfinished work continues under task_id; use task wait, not read polling.'}`,
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: `Command.${_shellSyntaxCheat}` },
                timeout_ms: {
                    type: 'number',
                    minimum: 0,
                    description: 'Hard kill deadline in ms, separate from the 10s foreground window; omit or 0 = none. Set one for throwaway checks and probes so a slow check fails fast instead of being waited on.',
                },
            },
            required: ['command'],
            additionalProperties: false,
        },
    },
    GIT_TOOL_DEF,
    GIT_STAGE_TOOL_DEF,
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
        //
        // FUTURE (action-scoped destructiveness, not implemented here):
        //   1. `task` would declare `destructiveHint: false` plus
        //      `destructiveActions: ['cancel']` in these annotations.
        //   2. Enforcement CANNOT live in catalog/selection code:
        //      `isReadonlySelectable(tool)` (tool-catalog.mjs:262-268) receives
        //      only the tool definition and runs while the surface is being
        //      assembled — before any invocation exists, so no `action`
        //      argument is available to match against the list.
        //   3. It must therefore live in dispatch/approval, where validated
        //      call arguments exist: that layer resolves destructiveness per
        //      invocation (`destructiveActions.includes(args.action)`) and
        //      gates approval on the result, while selection keeps treating the
        //      tool as non-destructive.
        annotations: { title: 'Task', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description: 'Manage shell tasks. Wait for completion instead of repeatedly polling task output; completion notifications are automatic, not final reports. Continue independent work meanwhile.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'Shell task_id; required for read/wait/cancel.' },
                action: { type: 'string', enum: ['list', 'read', 'wait', 'cancel'], description: 'list all; read snapshot; wait for completion; cancel task.' },
                timeout_ms: {
                    type: 'integer',
                    minimum: 0,
                    description: `Wait ceiling in ms; returns on completion, else current output at the ceiling. Default ${TASK_WAIT_TIMEOUT_DEFAULT_MS}; clamped to ${TASK_WAIT_TIMEOUT_MIN_MS}-${TASK_WAIT_TIMEOUT_MAX_MS}.`,
                },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'grep',
        title: 'Grep',
        annotations: { title: 'Grep', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Search literal/regex file contents; returns path:line blocks with context. Single-line ripgrep; 10 KB cap. Batch independent patterns and scopes; defer a search only when a pending result decides its need or inputs. Broad reconnaissance: mode:files; locations only: context:0. Symbol relations: code_graph.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, maxItems: 10 },
                    ],
                    description: 'Ripgrep regex(es); escape literal metacharacters. Invalid regex is reported, never reinterpreted.',
                },
                path: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', minItems: 1, maxItems: PUBLIC_PATH_BATCH_LIMIT, items: { type: 'string' } },
                    ],
                    description: 'Plain file/directory scopes; omit for Project root. Every pattern searches every path (not zipped); specific pattern/path pairs need separate calls. Missing scopes are reported, never widened or replaced.',
                },
                glob: {
                    type: 'string',                    description: 'Relative glob filter evaluated inside path, e.g. "*.cs" or "src/**/*.ts"; for exact/absolute paths use path instead.',
                },
                mode: { type: 'string', enum: ['content', 'files', 'count'], description: 'content default; files lists matching paths; count totals all patterns together per file.' },
                limit: { type: 'integer', minimum: 0, description: 'Requested results; default 250. Context output caps at 40 blocks; continue via the returned offset.' },
                offset: { type: 'integer', minimum: 0, description: 'Result offset.' },
                context: { type: 'integer', minimum: 0, maximum: 200, description: 'Omit for automatic context; 0 for matches only.' },
                include_noise: { type: 'boolean', description: 'Also search gitignored/dependency trees; explicit exclusions still apply.' },
                text: { type: 'boolean', description: 'Search binary data as text past NUL bytes; archives and Git objects are not decoded.' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
    },
    {
        name: 'glob',
        title: 'Glob',
        annotations: { title: 'Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Wildcard file-path lookup under a known directory; directories never match. Omit path for the current Project; no preliminary listing. Unknown base: find first with a known path fragment. Gitignored paths need include_noise:true.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, maxItems: 10 },
                    ],
                    description: 'Union of patterns under one base; separate calls for other bases or per-pattern results.',
                },
                path: {
                    type: 'string',                    description: 'Known existing base directory; omit for the current Project.',
                },
                sort: { type: 'string', enum: ['natural', 'mtime'], description: 'mtime default (newest first); natural = raw walk order, cheaper on huge trees.' },
                limit: { type: 'integer', minimum: 0, description: 'Max entries; default 100; 0 unlimited.' },
                offset: { type: 'integer', minimum: 0, description: 'Entry offset.' },
                include_noise: { type: 'boolean', description: 'Also search gitignored/dependency trees; explicit exclusions still apply.' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
    },
    {
        name: 'find',
        title: 'Find Files',
        annotations: { title: 'Find Files', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Fuzzy filename/directory path lookup; returns paths only. Use only when the target path is unknown and cannot be directly resolved and a filename/path fragment is known. General discovery in the current Project: glob. Never send an empty query.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string', minLength: 1, pattern: '\\S',
                    description: 'Non-empty filename/path fragment; space-separated fragments AND-match within one path.',
                },
                path: { type: 'string', description: 'Base directory; omit for the current Project.' },
                limit: { type: 'integer', minimum: 0, description: 'Max paths; default 25; 0 unlimited.' },
                include_noise: { type: 'boolean', description: 'Also search gitignored/dependency trees.' },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'list',
        title: 'List Directory',
        annotations: { title: 'List Directory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: "Return a known directory's immediate entries (path + type); no wildcard. Only when those entries or metadata are needed, not to re-confirm a known listing or before read/glob.",
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',                    description: 'Known directory; defaults to the current Project.',
                },
                hidden: { type: 'boolean', description: 'Include dotfiles.' },
                meta: { type: 'boolean', description: 'Per-entry size bytes, UTC mtime, octal mode.' },
                limit: { type: 'integer', minimum: 0, maximum: 100, description: 'Max entries; default 100; 0 = no page cap (absolute cap still applies).' },
                offset: { type: 'integer', minimum: 0, description: 'Entry offset.' },
            },
            required: [],
            additionalProperties: false,
        },
    },
];
