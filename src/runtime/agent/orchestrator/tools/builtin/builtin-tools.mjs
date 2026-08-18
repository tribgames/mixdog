// --- Tool definitions for external models ---
//
// CANONICAL SOURCE for built-in tool schemas and annotations (compressible,
// readOnlyHint, destructiveHint, etc.). Descriptions carry the tool CONTRACT
// only (behavior + argument shapes); usage policy lives in rules/shared/01-tool.md.
// Platform-specific command syntax belongs next to the command argument.
import { GIT_TOOL_DEF } from './git-command-tool.mjs';
const _shellSyntaxCheat =
    process.platform === 'win32'
        ? ' PowerShell: use ; between independent commands; use if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } between dependent commands; single-quote inline scripts, avoid nested double quotes; /c/→C:\\; $PID is reserved.'
        : ' Bash: use && between dependent commands.';
// Keep the routing map short and adjacent to the shell's primary description.
// PowerShell aliases appear only on win32.
const _shellToolRouting = process.platform === 'win32'
    ? 'Use read, NOT cat/Get-Content/head/tail; list, NOT ls/dir; find/glob, NOT find; grep, NOT grep/rg/Select-String; edit/apply_patch, NOT sed/awk/heredocs/echo/Set-Content.'
    : 'Use read, NOT cat/head/tail; list, NOT ls; find/glob, NOT find; grep, NOT grep/rg; edit/apply_patch, NOT sed/awk/heredocs/echo.';
// CC parity: when background tasks are disabled for this process, drop the
// run_in_background field from the schema entirely so the model cannot burn a
// failure turn attempting it. Mirrors bash-tool's runtime guard, which stays
// as defense in depth. Process-stable env, evaluated once at module load.
const _shellBackgroundDisabled = /^(1|true|yes|on)$/i.test(
    String(process.env.MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS || '').trim(),
);

export const BUILTIN_TOOLS = [
    {
        name: 'read',
        title: 'Read',
        annotations: { title: 'Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false },
        description: 'Read-only; safe to batch in parallel. Known-file contents or line ranges. Images render for viewing; not directories. Replaces cat/head/tail. Never re-open spans grep or code_graph already returned.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',
                    description: 'Known file path as plain text; not a JSON array or annotated path. A glob (e.g. "logs/*.log") fans out to per-file results (cap 10, newest first); literal-named files win over expansion.',
                },
                offset: {
                    type: 'integer',
                    minimum: 0,
                    description: '1-based start line as a bare integer; default 1.',
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Maximum line count as a bare integer; default 800.',
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
        description: 'Performs exact string replacements in files. old_string must identify exactly one occurrence; if it appears more than once, add surrounding lines to make it unique or set replace_all to change every occurrence. An empty old_string creates a missing file or fills an empty file; it never overwrites a non-empty file. Use exact text already in context — never re-open the file to build old_string from visible spans or to verify a successful edit.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',
                    description: 'Path to the file to modify.',
                },
                old_string: {
                    type: 'string',
                    description: 'The exact text to replace.',
                },
                new_string: {
                    type: 'string',
                    description: 'The replacement text; must differ from old_string.',
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
        description: `Run programs, runtime/state operations, calculations, transformations, file generation, and unsupported-format inspection. Avoid file operations covered by dedicated tools unless explicitly instructed or after verifying that a dedicated tool cannot do the job. ${_shellToolRouting} Commands start in the foreground${_shellBackgroundDisabled ? '' : ' unless run_in_background is true'}; after 15s, a still-running foreground command continues as a tracked task_id and completes by notification.`,
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: `Command.${_shellSyntaxCheat}` },
                ...(_shellBackgroundDisabled ? {} : {
                    run_in_background: {
                        type: 'boolean',
                        default: false,
                        description: 'Start as a tracked background task immediately; use only when the result is not needed for the next step — completion arrives by notification. Default false.',
                    },
                }),
            },
            required: ['command'],
            additionalProperties: false,
        },
    },
    GIT_TOOL_DEF,
    {
        name: 'task',
        title: 'Task',
        annotations: { title: 'Task', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description: 'List shell tasks, read one current output snapshot, or cancel by task_id; completion arrives by notification.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'Shell task_id; required for read/cancel.' },
                action: { type: 'string', enum: ['list', 'read', 'cancel'], description: 'list all; read snapshot; cancel task.' },
            },
            required: ['action'],
            additionalProperties: false,
        },
    },
    {
        name: 'grep',
        title: 'Grep',
        annotations: { title: 'Grep', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Read-only; safe to batch in parallel. Search file contents for literal or regex matches; contextual path:line blocks are directly usable—read only omitted lines. Ripgrep-dialect regex (e.g. "log.*Error"; escape literal braces; patterns match within one line). Batch independent searches in one message. Replaces grep/rg.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Required literal text or regex, or array for independent fan-out.',
                },
                path: {
                    type: 'string',
                    description: 'One plain existing file or directory scope; if unsure, omit to search the project root.',
                },
                glob: {
                    type: 'string',
                    description: 'Optional file-path glob filter, not search text.',
                },
                mode: { type: 'string', enum: ['content', 'files', 'count'], description: 'content default; files lists matching paths; count totals all patterns together per file.' },
                limit: { type: 'integer', minimum: 0, description: 'Max results; default 250; 0 unlimited.' },
                offset: { type: 'integer', minimum: 0, description: 'Result offset.' },
                context: { type: 'integer', minimum: 0, description: 'Omit for automatic context; 0 for matches only.' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
    },
    {
        name: 'glob',
        title: 'Glob',
        annotations: { title: 'Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Read-only; safe to batch in parallel. Return wildcard-matching file paths under a known base directory when those paths are needed. Directories never match; enumerate them with list. Omit path for the current Project; if the base location is unknown, use find first. Newest first by default. Replaces find -name.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'Glob.',
                },
                path: {
                    type: 'string',
                    description: 'Known existing base directory; omit for the current Project; unknown location → find.',
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
        description: 'Read-only; safe to batch in parallel. Fuzzy filename/directory path lookup when the location itself is unknown; returns paths only. No content or symbol search.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Filename/path fragment; space-separated fragments AND-match within one path.',
                },
                path: { type: 'string', description: 'Base path.' },
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
        description: "Read-only; safe to batch in parallel. Return a known directory's immediate entries (path + type) when the entry list itself is needed; not a prerequisite for another tool on that directory — tree walks go to glob, name hunts to find. No wildcard; meta:true adds size/mtime/mode.",
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Known directory; defaults to the project root.',
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
