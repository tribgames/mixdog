// --- Tool definitions for external models ---
//
// CANONICAL SOURCE for built-in tool schemas and annotations (compressible,
// readOnlyHint, destructiveHint, etc.). A description carries the tool's
// behavior, argument shapes, and the usage boundaries that only apply to that
// tool; cross-tool policy lives in rules/shared/*.md.
// Platform-specific command syntax belongs next to the command argument.
import { GIT_STAGE_TOOL_DEF, GIT_TOOL_DEF } from './git-command-tool.mjs';
import { SHELL_MONITOR_INTERVAL_MAX_MS } from './shell-monitor.mjs';
const _shellSyntaxCheat =
    process.platform === 'win32'
        ? ' PowerShell: use ; between independent commands; use if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } between dependent commands; single-quote inline scripts, avoid nested double quotes; /c/→C:\\; $PID is reserved.'
        : ' Bash: use && between dependent commands.';
// Keep the routing map short and adjacent to the shell's primary description.
// PowerShell aliases appear only on win32.
const _shellToolRouting = process.platform === 'win32'
    ? 'Use read, NOT cat/Get-Content/head/tail; list, NOT ls/dir; find/glob, NOT find; grep, NOT grep/rg/Select-String; edit/apply_patch, NOT sed/awk/echo/Set-Content or a file-writing heredoc; git, NOT a plain git command; task, NOT Start-Job or a wait loop.'
    : 'Use read, NOT cat/head/tail; list, NOT ls; find/glob, NOT find; grep, NOT grep/rg; edit/apply_patch, NOT sed/awk/echo or a file-writing heredoc; git, NOT a plain git command; task, NOT & or a wait loop.';
// Process-stable switch used to describe foreground-only execution accurately.
const _shellBackgroundDisabled = /^(1|true|yes|on)$/i.test(
    String(process.env.MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS || '').trim(),
);

export const BUILTIN_TOOLS = [
    {
        name: 'read',
        title: 'Read',
        annotations: { title: 'Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false },
        description: 'Read-only; safe to batch in parallel. Known-file contents or line ranges, bounded to the narrowest range that answers the question. Images render for viewing; not directories. Replaces cat/head/tail.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',                    description: 'Known file path as plain text. A glob (e.g. "logs/*.log") fans out to per-file results (cap 10, newest first); literal-named files win over expansion.',
                },
                offset: {
                    type: 'integer',
                    minimum: 1,
                    description: '1-based start line as a bare integer; default 1.',
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Maximum line count as a bare integer; default 500.',
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
        description: 'Replace exact text in one file. Use exact text already in context; never re-open the file to build old_string or to verify a successful edit. old_string must match once unless replace_all is true. Empty old_string creates a missing file or fills an empty file; it never overwrites a non-empty file. Replaces sed/awk and echo redirection.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',                    description: 'Path to the file to modify.',
                },
                old_string: {
                    type: 'string',
                    description: 'Exact text to replace. Empty only to create a missing file or fill an empty file.',
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
        description: `Run programs, runtime/state operations, calculations, transformations, file generation, and unsupported-format inspection. ${_shellToolRouting} ${_shellBackgroundDisabled ? 'Commands run in the foreground until completion.' : 'Commands use a 10s foreground window by default—not a timeout. Still-running work continues as a tracked task_id. Completion is automatic; do not call task read/monitor to wait or check progress. Continue independent work or end the turn. Use task read only when the user explicitly asks for current status, and task monitor only when they explicitly ask for periodic progress.'}`,
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: `Command.${_shellSyntaxCheat}` },
                timeout_ms: {
                    type: 'number',
                    minimum: 0,
                    description: 'Optional hard total deadline in ms; kills the command even after background promotion. Omit or 0 = no deadline.',
                },
            },
            required: ['command'],
            additionalProperties: false,
        },
    },
    GIT_TOOL_DEF,
    GIT_STAGE_TOOL_DEF,
    {
        name: 'task',
        title: 'Task',
        annotations: { title: 'Task', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description: 'List shell tasks, read one current snapshot, change periodic monitoring, or cancel by task_id. Replaces shell job control (jobs/wait/Start-Job). Completion is automatic; do not call read/monitor to wait or check progress. Continue independent work or end the turn. Use read only when the user explicitly asks for current status, and monitor only when they explicitly ask for periodic progress.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'Shell task_id; required for read/monitor/cancel.' },
                action: { type: 'string', enum: ['list', 'read', 'monitor', 'cancel'], description: 'list all; read snapshot; monitor changes periodic progress; cancel task.' },
                monitor_interval_ms: {
                    type: 'integer',
                    minimum: 0,
                    maximum: SHELL_MONITOR_INTERVAL_MAX_MS,
                    description: 'Required for action=monitor. 0 disables periodic progress; use 300000 (5m) or longer to enable.',
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
        description: 'Read-only; safe to batch in parallel. Search file contents for literal or regex matches and return contextual path:line blocks that are directly usable; read only the lines they omit. A wide reconnaissance pattern goes to mode:files first; context:0 when only the location is needed. Ripgrep-dialect regex (e.g. "log.*Error"; escape literal braces; patterns match within one line). Replaces grep/rg.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, maxItems: 10 },
                    ],
                    description: 'Required literal text or regex, or array for independent fan-out.',
                },
                path: {
                    type: 'string',                    description: 'One plain existing file or directory scope; if unsure, omit to search the project root.',
                },
                glob: {
                    type: 'string',                    description: 'Optional file-path glob filter, not search text.',
                },
                mode: { type: 'string', enum: ['content', 'files', 'count'], description: 'content default; files lists matching paths; count totals all patterns together per file.' },
                limit: { type: 'integer', minimum: 0, description: 'Max results; default 250; 0 unlimited.' },
                offset: { type: 'integer', minimum: 0, description: 'Result offset.' },
                context: { type: 'integer', minimum: 0, maximum: 200, description: 'Omit for automatic context; 0 for matches only.' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
    },
    {
        name: 'glob',
        title: 'Glob',
        annotations: { title: 'Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Read-only; safe to batch in parallel. Return wildcard-matching file paths under a known base directory when those paths are needed. Omit path for the current Project; an unknown base directory goes to find first. Directories never match. Newest first by default. Replaces find -name.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, maxItems: 10 },
                    ],
                    description: 'Glob or array of globs (max 10).',
                },
                path: {
                    type: 'string',                    description: 'Known existing base directory; omit for the current Project.',
                },
                sort: { type: 'string', enum: ['natural', 'mtime'], description: 'mtime default (newest first); natural = raw walk order, cheaper on huge trees.' },
                limit: { type: 'integer', minimum: 0, description: 'Max entries; default 100; 0 unlimited.' },
                offset: { type: 'integer', minimum: 0, description: 'Entry offset.' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
    },
    {
        name: 'find',
        title: 'Find Files',
        annotations: { title: 'Find Files', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Read-only; safe to batch in parallel. Fuzzy filename/directory path lookup when the location itself is unknown; returns paths only. Skip it when the path is already known or resolvable.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',                    description: 'Filename/path fragment; space-separated fragments AND-match within one path.',
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
        description: "Read-only; safe to batch in parallel. Return a known directory's immediate entries (path + type) when the entry list itself is needed; never as a prerequisite for another tool on that directory. No wildcard; meta:true adds size/mtime/mode. Replaces ls/dir.",
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',                    description: 'Known directory; defaults to the current Project.',
                },
                hidden: { type: 'boolean', description: 'Include dotfiles.' },
                meta: { type: 'boolean', description: 'Per-entry size bytes, UTC mtime, octal mode.' },
                limit: { type: 'integer', minimum: 0, description: 'Max entries; default 200; 0 unlimited.' },
                offset: { type: 'integer', minimum: 0, description: 'Entry offset.' },
            },
            required: [],
            additionalProperties: false,
        },
    },
];
