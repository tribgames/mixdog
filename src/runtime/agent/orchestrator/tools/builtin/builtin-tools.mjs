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
        description: 'Known-file contents or line ranges. Images render for viewing; not directories. Replaces cat/head/tail.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',
                    description: 'Known file path.',
                },
                offset: {
                    type: 'integer',
                    minimum: 0,
                    description: '1-based start line; default 1.',
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Maximum lines to return; default 800.',
                },
            },
            required: ['file_path'],
            additionalProperties: false,
        },
    },
    {
        name: 'shell',
        title: 'Shell',
        annotations: { title: 'Shell', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, compressible: true },
        description: 'Run programs, runtime/state operations, calculations, transformations, file generation, and unsupported-format inspection. After 10s, a running command returns task_id and completes by notification.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: `Command.${_shellSyntaxCheat}` },
                timeout_ms: {
                    type: 'number',
                    description: 'Optional total deadline.',
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
        description: 'Search file contents for literal or regex matches; contextual path:line blocks are directly usable—read only omitted lines. Replaces grep/rg.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'Text/regex.',
                },
                path: {
                    type: 'string',
                    description: 'File/dir scope.',
                },
                glob: {
                    type: 'string',
                    description: 'Glob filter.',
                },
                mode: { type: 'string', enum: ['content', 'files', 'count'], description: 'content default; files lists matching paths; count totals all patterns together per file.' },
                limit: { type: 'number', minimum: 0, description: 'Max results; default 250; 0 unlimited.' },
                offset: { type: 'number', minimum: 0, description: 'Result offset.' },
                context: { type: 'number', minimum: 0, description: 'Omit for automatic context; 0 for matches only.' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
    },
    {
        name: 'glob',
        title: 'Glob',
        annotations: { title: 'Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Return wildcard-matching paths under a known base when those paths are needed. Replaces find -name.',
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
                limit: { type: 'number', description: 'Max entries; default 100; 0 unlimited.' },
                offset: { type: 'number', minimum: 0, description: 'Entry offset.' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
    },
    {
        name: 'find',
        title: 'Find Files',
        annotations: { title: 'Find Files', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Fuzzy filename/directory path lookup when the location itself is unknown; returns paths only. No source-content, symbol, value, or line search.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Filename or directory path fragments matched against path strings.',
                },
                path: { type: 'string', description: 'Base path.' },
                limit: { type: 'number', description: 'Max paths; default 25; 0 unlimited.' },
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
        description: "Return a known directory's immediate entries (path + type) when the entry list itself is needed; not a prerequisite for another tool on that directory. No wildcard; meta:true adds size/mtime/mode.",
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Directory.',
                },
                hidden: { type: 'boolean', description: 'Include dotfiles.' },
                meta: { type: 'boolean', description: 'Per-entry size bytes, UTC mtime, octal mode.' },
                limit: { type: 'number', description: 'Max entries; default 200; 0 unlimited.' },
                offset: { type: 'number', description: 'Entry offset.' },
            },
            required: [],
            additionalProperties: false,
        },
    },
];
