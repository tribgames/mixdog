// --- Tool definitions for external models ---
//
// Ordered to match the previous hand-maintained tools.json entries
// (read / edit / write / shell / grep / glob) so
// build-tools-manifest reproduces the legacy ordering.
// CANONICAL SOURCE for all tool annotations (compressible, readOnlyHint,
// destructiveHint, etc.). tools.json is GENERATED from this array by
// dev/scripts/build-tools-manifest.mjs — do not edit annotations in tools.json
// directly. To verify sync: node dev/scripts/check-tools-sync.mjs
import {
    TOOL_ASYNC_EXECUTION_CONTRACT,
    TOOL_MANUAL_CONTROL_CONTRACT,
    executionModeSchemaDescription,
} from '../../../../shared/background-tasks.mjs';

export const BUILTIN_TOOLS = [
    {
        name: 'read',
        title: 'Mixdog Read',
        annotations: { title: 'Mixdog Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false },
        description: 'Read one known file. Broad/unknown: code_graph/grep/glob first; refs only if requested. For where/candidate answers use file:line hits and avoid read. Use symbol OR line+context; no reread same file.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path only; dirs use list.' },
                line: { type: 'number', minimum: 1, description: 'Anchor line. Do not combine with offset/limit.' },
                context: { type: 'number', minimum: 0, maximum: 200, description: 'Lines around line. Use only with line; max 200.' },
                symbol: { type: 'string', description: 'Symbol body via code graph.' },
            },
        },
    },
    {
        name: 'edit',
        title: 'Mixdog Edit',
        annotations: { title: 'Mixdog Edit', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Legacy exact-string fallback. Avoid for normal code changes; use apply_patch as the first-class mutation tool. Use edit only for one tiny already-read literal replacement when apply_patch is unavailable. Use either single old_string/new_string or edits[]; when using edits[], do not include top-level old_string/new_string.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                old_string: { type: 'string', description: 'Exact current text copied from a recent read; do not guess or retry stale text.' },
                new_string: { type: 'string' },
                replace_all: { type: 'boolean' },
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string' },
                            old_string: { type: 'string' },
                            new_string: { type: 'string' },
                            replace_all: { type: 'boolean' },
                        },
                        required: ['old_string', 'new_string'],
                        additionalProperties: false,
                    },
                    minItems: 1,
                    description: 'Batch replacements (operation:"replace"). Each item may carry its own path, or use the top-level path as the default. Prefer apply_patch for normal code changes.',
                },
            },
        },
    },
    {
        name: 'write',
        title: 'Mixdog Write',
        annotations: { title: 'Mixdog Write', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Write a whole file — new, or a full rewrite of one already read. For partial edits use apply_patch; never overwrite an unread file.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                content: { type: 'string' },
            },
        },
    },
    {
        name: 'diagnostics',
        title: 'Mixdog Diagnostics',
        annotations: { title: 'Mixdog Diagnostics', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, compressible: true },
        description: 'Run the matching type/lint checker under path (tsc/eslint/ruff/etc.). Default cwd; no LSP.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File or directory to diagnose. Defaults to cwd.' },
            },
            required: [],
        },
    },
    {
        name: 'open_config',
        title: 'Open Config UI',
        annotations: { title: 'Open Config UI', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Open the mixdog settings UI (Providers + Presets) in the browser. Starts the resident config server if needed and returns the UI URL. No params.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'shell',
        title: 'Mixdog Shell',
        annotations: { title: 'Mixdog Shell', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, compressible: true },
        description: `Run an OS shell command for git/build/test/run only. Do NOT use shell grep/cat/head for source; use code_graph/grep/read/list/glob. Set shell explicitly: 'powershell' for PowerShell or 'bash' for Git Bash/POSIX. Use cwd; omit empty workdir. Windows native shell does not support persistent/session_id. mode=async uses the shared background task system and returns task_id. ${TOOL_ASYNC_EXECUTION_CONTRACT}`,
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string' },
                cwd: { type: 'string' },
                workdir: { type: 'string', description: 'Alias for cwd; omit if empty.' },
                timeout: { type: 'number', description: 'Timeout in milliseconds.' },
                merge_stderr: { type: 'boolean' },
                mode: { type: 'string', enum: ['sync', 'async'], description: executionModeSchemaDescription('sync') },
                run_in_background: { type: 'boolean', description: `Legacy alias for mode=async. ${TOOL_ASYNC_EXECUTION_CONTRACT}` },
                persistent: { type: 'boolean', description: 'Persistent shell mode; unsupported on Windows native shell.' },
                session_id: { type: 'string', description: 'Persistent shell id; omit on Windows native shell.' },
                create: { type: 'boolean', description: 'Allow creating a new persistent session for an explicit session_id.' },
                close: { type: 'boolean' },
                shell: { type: 'string', enum: ['bash', 'powershell'], description: "Force the shell. On Windows: 'bash' runs the command through Git Bash (POSIX syntax), 'powershell' forces PowerShell. On POSIX: 'powershell' resolves pwsh if installed (errors if absent); 'bash' is /bin/sh (already the default). Always set this explicitly; omitting uses the OS default (PowerShell on Windows), where POSIX syntax fails to parse." },
            },
            required: ['command'],
        },
    },
    {
        name: 'task',
        title: 'Background Task Control',
        annotations: { title: 'Background Task Control', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description: `Manual control for an async background task by task_id. action: list | status | read | wait | cancel. ${TOOL_MANUAL_CONTROL_CONTRACT} Not for bridge_*/sess_* ids.`,
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'task_id from shell mode=async. Use only for manual control; normal completion arrives as a notification.' },
                action: { type: 'string', enum: ['list', 'status', 'read', 'wait', 'cancel'], description: 'Manual control only: list all visible tasks; status is non-blocking; read includes available result/output; wait blocks inside this one call until done/timeout; cancel terminates when the task supports it. Do not call repeatedly as a polling loop.' },
                timeout_ms: { type: 'number', description: 'Maximum time for a single manual wait call. Prefer the completion notification instead of repeated waits.' },
                poll_ms: { type: 'number', description: 'Internal polling interval used only inside one manual wait call.' },
            },
            required: [],
        },
    },
    {
        name: 'grep',
        title: 'Mixdog Grep',
        annotations: { title: 'Mixdog Grep', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'FIRST for free-text/literal/config search after file-space is known. Symbols -> code_graph; unknown files -> glob/list first. Minimal: pattern, path, optional glob. Prefer plain terms/arrays over fragile regex; avoid shell grep/rg.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Literal/substring or ripgrep regex. Array = OR terms. Legacy `\\|` in a single string is accepted as OR.',
                },
                path: { type: 'string', description: 'One file or directory only; for many paths use common parent + glob.' },
                glob: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Glob filter(s).',
                },
                output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'], description: 'Default content.' },
                head_limit: { type: 'number', description: 'Max result lines.' },
                offset: { type: 'number', description: 'Skip N result lines for paging.' },
            },
            required: [],
        },
    },
    {
        name: 'glob',
        title: 'Mixdog Glob',
        annotations: { title: 'Mixdog Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'FIRST for file-space narrowing by known filename/path pattern. Use before grep/code_graph when the main unknown is which files. Returns mtime-sorted paths.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Glob or array.',
                },
                path: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Base dir or array.',
                },
                head_limit: { type: 'number', description: 'Max entries.' },
                offset: { type: 'number', description: 'Skip N entries for paging.' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'list',
        title: 'Mixdog List Directory',
        annotations: { title: 'Mixdog List Directory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'FIRST for file-space narrowing by directory or fuzzy partial filename. Minimal: path, or fuzzy. Use glob for known patterns; avoid tree unless needed.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                head_limit: { type: 'number', description: 'Max entries.' },
                offset: { type: 'number', description: 'Skip N entries for paging.' },
                fuzzy: { type: 'string', description: 'Rank files by partial name.' },
            },
            required: [],
        },
    },
];
