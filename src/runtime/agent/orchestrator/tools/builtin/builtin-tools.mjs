// --- Tool definitions for external models ---
//
// CANONICAL SOURCE for built-in tool schemas and annotations (compressible,
// readOnlyHint, destructiveHint, etc.). Descriptions carry the tool CONTRACT
// only (behavior + argument shapes); usage policy lives in rules/shared/01-tool.md.
// Platform-specific command syntax belongs next to the command argument.
const _shellSyntaxCheat =
    process.platform === 'win32'
        ? ' PowerShell: use ; between independent commands; use if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } between dependent commands; single-quote inline scripts, avoid nested double quotes; /c/→C:\\; $PID is reserved.'
        : ' Bash: use && between dependent commands.';

export const BUILTIN_TOOLS = [
    {
        name: 'read',
        title: 'Read',
        annotations: { title: 'Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false },
        description: 'Known-file contents or line ranges. Images render for viewing; not directories. Replaces cat/head/tail. Never re-open spans grep or code_graph already returned.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',
                    description: 'Known file path as plain text; not a JSON array or annotated path.',
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
        description: 'Run programs, runtime/state operations, calculations, transformations, file generation, and unsupported-format inspection. Commands start in the foreground; after 15s, a still-running command continues as a tracked task_id and completes by notification.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: `Command. Unless a dedicated tool verifiably cannot do the job, never run cat/Get-Content/head/tail (read covers them), ls/dir (list), find (find/glob), grep/rg/Select-String (grep), or sed/awk (edit); never create files via heredoc or echo/Set-Content redirection — the file-editing tool creates files (empty old_string, or an Add File patch); never echo/printf text meant for the user — answer directly.${_shellSyntaxCheat}` },
                timeout_ms: {
                    type: 'integer',
                    minimum: 0,
                    description: 'Hard total deadline in milliseconds; omit or use 0 to allow unlimited runtime after task promotion.',
                },
            },
            required: ['command'],
            additionalProperties: false,
        },
    },
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
        description: 'Search file contents for literal or regex matches; contextual path:line blocks are directly usable—read only omitted lines. Ripgrep-dialect regex (e.g. "log.*Error"; escape literal braces; patterns match within one line). Batch independent searches in one message. Replaces grep/rg.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'Required literal text or regex to search for.',
                },
                path: {
                    type: 'string',
                    description: 'One plain file or directory scope.',
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
        description: 'Return wildcard-matching paths under a known base when those paths are needed. Newest first by default. Replaces find -name.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'Glob.',
                },
                path: {
                    type: 'string',
                    description: 'Base dir.',
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
        description: 'Fuzzy filename/directory path lookup when the location itself is unknown; returns paths only. No content or symbol search.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Filename or directory path fragments matched against path strings.',
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
        description: "Return a known directory's immediate entries (path + type) when the entry list itself is needed; not a prerequisite for another tool on that directory — tree walks go to glob, name hunts to find. No wildcard; meta:true adds size/mtime/mode.",
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
