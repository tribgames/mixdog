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
        title: 'Mixdog Read',
        annotations: { title: 'Mixdog Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false },
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
        title: 'Mixdog Shell',
        annotations: { title: 'Mixdog Shell', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, compressible: true },
        description: 'Run programs and runtime/state operations; perform calculations, transform data, generate computed files, or inspect formats unsupported by file tools. Do not use for ordinary file-content inspection. A command that may alter source evidence may run only after a separate completed tool round has preserved the original or established verified read-only access. Tracked sync/async commands belong to the current run; only a service explicitly required after the run exits should be shell-detached (for example, nohup ... &).',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: `Command.${_shellSyntaxCheat}` },
                timeout_ms: {
                    type: 'number',
                    description: 'Optional total deadline.',
                },
                run_in_background: { type: 'boolean', description: 'Run immediately as a tracked background task; returns task_id and sends a completion notification.' },
            },
            required: ['command'],
            additionalProperties: false,
        },
    },
    {
        name: 'task',
        title: 'Background Task Control',
        annotations: { title: 'Background Task Control', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description: 'Schedule one progress check or manually inspect/cancel a shell background task_id; normal completion arrives by notification. Not for session or agent ids.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'Shell task_id.' },
                action: { type: 'string', enum: ['list', 'status', 'read', 'check_after', 'cancel'], description: 'Default list; task_id alone defaults to non-blocking status. check_after schedules one non-blocking progress notification.' },
                after_ms: { type: 'number', description: 'Required explicitly for check_after; one-shot delay before the progress snapshot, not the task deadline.' },
            },
            required: [],
            additionalProperties: false,
        },
    },
    {
        name: 'grep',
        title: 'Mixdog Grep',
        annotations: { title: 'Mixdog Grep', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
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
        title: 'Mixdog Glob',
        annotations: { title: 'Mixdog Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
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
        title: 'Mixdog Find Files',
        annotations: { title: 'Mixdog Find Files', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
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
        title: 'Mixdog List Directory',
        annotations: { title: 'Mixdog List Directory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
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
