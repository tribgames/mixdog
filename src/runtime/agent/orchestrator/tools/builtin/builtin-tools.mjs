// --- Tool definitions for external models ---
//
// Ordered to match the previous hand-maintained tools.json entries
// (read / edit / write / bash / grep / glob) so
// build-tools-manifest reproduces the legacy ordering.
// CANONICAL SOURCE for all tool annotations (compressible, readOnlyHint,
// destructiveHint, etc.). tools.json is GENERATED from this array by
// dev/scripts/build-tools-manifest.mjs — do not edit annotations in tools.json
// directly. To verify sync: node dev/scripts/check-tools-sync.mjs
export const BUILTIN_TOOLS = [
    {
        name: 'read',
        title: 'Mixdog Read',
        annotations: { title: 'Mixdog Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false },
        description: 'Read file contents (path required). symbol=NAME = whole definition; offset/limit or line/context = window; mode/max_lines = whole-file glance. Batch all regions of a file in one call. Output is verbatim (line-number prefix only, no escaping).',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                offset: { type: 'number', description: 'Start line for a windowed read (1-based).' },
                limit: { type: 'number', description: 'Max lines to read (default 2000; full:true uncaps).' },
                line: { type: 'number' },
                context: { type: 'number', description: 'Lines around `line` (default 20).' },
                pages: { type: 'string' },
                symbol: { type: 'string', description: 'Read a whole symbol body (function/class/const) via the code graph.' },
                language: { type: 'string', description: 'Language hint for symbol resolution.' },
                mode: { type: 'string', enum: ['head', 'tail', 'count', 'summary', 'hex'], description: 'Whole-file glance: head/tail (first/last n), count (line/word/byte stats), summary (stats+head), hex (binary preview). For a window use offset/limit.' },
                n: { type: 'number', description: 'Line count for mode head/tail/summary (default 20).' },
                full: { type: 'boolean', description: 'Default false. true = return whole file (bypass 2000-line cap; still byte-capped).' },
                max_lines: { type: 'number', description: 'Whole-file read: cap output to ~N lines. Ignored with offset/limit/mode.' },
                budget: { type: 'string', enum: ['compact'], description: 'Auto-shrink: whole-file -> count; line -> context<=20; range -> limit<=120.' },
            },
        },
    },
    {
        name: 'edit',
        title: 'Mixdog Edit',
        annotations: { title: 'Mixdog Edit', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Exact-string editor for small known substitutions; for large or structural changes prefer apply_patch. operation: replace (default) | notebook | rename. Use either single old_string/new_string or edits[]; when using edits[], do not include top-level old_string/new_string.',
        inputSchema: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['replace', 'notebook', 'rename'], description: 'Edit mode: "replace" (default, exact text edit), "notebook" (Jupyter cell edit), or "rename" (symbol rename).' },
                path: { type: 'string' },
                old_string: { type: 'string' },
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
                    description: 'Batch replacements (operation:"replace"). Each item may carry its own path, or use the top-level path as the default.',
                },
                notebook_path: { type: 'string', description: 'operation:"notebook" — path to the .ipynb notebook to edit.' },
                cell_id: { type: 'string', description: 'operation:"notebook" — target cell: a real cell.id or a cell-N index. For insert, the new cell is placed after this cell (or at the start if omitted).' },
                new_source: { type: 'string', description: 'operation:"notebook" — new source for the cell (not required for delete).' },
                cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'operation:"notebook" — cell type. Required for insert; otherwise defaults to the current cell type.' },
                edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'operation:"notebook" — replace (default), insert, or delete.' },
                symbol: { type: 'string', description: 'operation:"rename" — identifier to rename.' },
                new_name: { type: 'string', description: 'operation:"rename" — new identifier.' },
                file: { type: 'string', description: 'operation:"rename" — optional file to scope the reference search.' },
                apply: { type: 'boolean', description: 'operation:"rename" — default false (preview). Set true to perform the rename.' },
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
                allow_unread_overwrite: { type: 'boolean', description: 'Default false. true = skip ONLY the read-before-overwrite snapshot gate when you already know the full intended content; all other write safety checks still apply.' },
                writes: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string' },
                            content: { type: 'string' },
                        },
                        required: ['path', 'content'],
                        additionalProperties: false,
                    },
                    minItems: 1,
                    description: 'Batch writes.',
                },
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
        name: 'bash',
        title: 'Mixdog Shell',
        annotations: { title: 'Mixdog Shell', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, compressible: true },
        description: "Shell for git/build/test/run. ALWAYS set `shell` explicitly ('bash' = POSIX via Git Bash, 'powershell' = PS cmdlets); omitting defaults to the OS shell (Windows = PowerShell, POSIX = /bin/sh) and mis-parses the other syntax. run_in_background works for both shells, including Windows shell:'bash' (Git Bash). Single shell entry point; not for inline code you were asked to return.",
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string' },
                cwd: { type: 'string' },
                timeout: { type: 'number', description: 'Timeout in ms, or seconds when <=600.' },
                merge_stderr: { type: 'boolean' },
                run_in_background: { type: 'boolean' },
                persistent: { type: 'boolean' },
                session_id: { type: 'string' },
                create: { type: 'boolean', description: 'Allow creating a new persistent session for an explicit session_id.' },
                close: { type: 'boolean' },
                shell: { type: 'string', enum: ['bash', 'powershell'], description: "Force the shell. On Windows: 'bash' runs the command through Git Bash (POSIX syntax), 'powershell' forces PowerShell. On POSIX: 'powershell' resolves pwsh if installed (errors if absent); 'bash' is /bin/sh (already the default). Always set this explicitly; omitting uses the OS default (PowerShell on Windows), where POSIX syntax fails to parse." },
            },
            required: ['command'],
        },
    },
    {
        name: 'job_wait',
        title: 'Background Job Control',
        annotations: { title: 'Background Job Control', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description: 'Control a bash run_in_background job by job_id. action: wait (default) | peek | kill. Not for bridge_*/sess_* ids.',
        inputSchema: {
            type: 'object',
            properties: {
                job_id: { type: 'string', description: 'job_id from bash with run_in_background:true.' },
                action: { type: 'string', enum: ['wait', 'peek', 'kill'], description: 'wait (default) = block until done; peek = non-blocking status + output tail; kill = terminate.' },
                timeout_ms: { type: 'number' },
                poll_ms: { type: 'number' },
            },
            required: ['job_id'],
        },
    },
    {
        name: 'grep',
        title: 'Mixdog Grep',
        annotations: { title: 'Mixdog Grep', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Search file contents (ripgrep) for free-text / non-symbol content (for a symbol by name use code_graph). pattern (regex) or glob; output_mode: content (default) | files_with_matches | count. Array pattern matches several in one call. -A/-B/-C is line-based (useless on minified files; use -o or multiline).',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Ripgrep regex, or an array of regexes (OR-matched; <=20, <=5 with multiline) to match several in one call.',
                },
                path: { type: 'string' },
                glob: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Glob, or an array of globs, to filter files.',
                },
                output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'], description: 'Default content (matching lines). files_with_matches = paths only; count = per-file counts.' },
                head_limit: { type: 'number', description: 'Max result lines (default 80; 0 = unlimited). Truncated output says how many results remain.' },
                offset: { type: 'number', description: 'Skip N result lines before head_limit applies — for paging large result sets.' },
                '-i': { type: 'boolean' },
                '-n': { type: 'boolean' },
                '-A': { type: 'number' },
                '-B': { type: 'number' },
                '-C': { type: 'number', description: 'Context lines (with -A/-B). Line-based; no effect on single-line/minified files — use -o.' },
                context: { type: 'number' },
                multiline: { type: 'boolean', description: 'Dot matches newlines; patterns span lines (rg -U). Pair with -o on single-line/minified files.' },
                '-o': { type: 'boolean', description: 'Only matching parts (rg --only-matching).' },
                type: { type: 'string' },
            },
            required: [],
        },
    },
    {
        name: 'glob',
        title: 'Mixdog Glob',
        annotations: { title: 'Mixdog Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Find files by glob pattern (mtime-sorted). For name/size/date filters use list mode:find.',
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
                head_limit: { type: 'number', description: 'Max entries returned (mtime-sorted). A truncated listing ends with "pass offset:N to continue" — re-call with that offset to page.' },
                offset: { type: 'number', description: 'Skip N entries before head_limit applies; use the footer-suggested value to page.' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'list',
        title: 'Mixdog List Directory',
        annotations: { title: 'Mixdog List Directory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'List or find directory entries. mode: list | tree | find (name/size/date filter). fuzzy ranks by partial name. Default cwd.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                mode: { type: 'string', enum: ['list', 'tree', 'find'], description: 'Default list (flat dir). tree = recursive tree; find = name/size/date filter.' },
                depth: { type: 'number' },
                hidden: { type: 'boolean' },
                sort: { type: 'string', enum: ['name', 'mtime', 'size'] },
                type: { type: 'string', enum: ['any', 'file', 'dir'] },
                head_limit: { type: 'number', description: 'Max entries returned. A truncated listing ends with "[entries X-Y of T; pass offset:N to continue]" — re-call with that offset to page.' },
                offset: { type: 'number', description: 'Skip N entries before head_limit applies; use the footer-suggested value to page.' },
                include_noise: { type: 'boolean' },
                name: { type: 'string' },
                min_size: { type: 'number' },
                max_size: { type: 'number' },
                modified_after: { type: 'string' },
                modified_before: { type: 'string' },
                fuzzy: { type: 'string', description: 'Rank files by subsequence match of this partial name; overrides mode. e.g. "edeng" -> edit-engine.mjs.' },
            },
            required: [],
        },
    },
];
