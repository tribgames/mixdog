// --- Tool definitions for external models ---
//
// CANONICAL SOURCE for built-in tool schemas and annotations (compressible,
// readOnlyHint, destructiveHint, etc.). A description carries the tool's
// behavior, argument shapes, and the usage boundaries that only apply to that
// tool; cross-tool policy lives in rules/shared/*.md.
// Platform-specific command syntax belongs next to the command argument.
import { GIT_STAGE_TOOL_DEF, GIT_TOOL_DEF } from './git-command-tool.mjs';
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
        description: 'Read-only; safe to batch in parallel. Known-file contents or line ranges. Read only lines not already returned by another tool, using the smallest anchored range needed; never read an entire file when an existing result provides the relevant location. Do not read an output artifact after a still-valid passed check has established the needed facts. Images render for viewing; not directories. Replaces cat/head/tail.',
        inputSchema: {
            type: 'object',
            properties: {
                file_path: {
                    type: 'string',                    description: 'Known file path as plain text. A glob (e.g. "logs/*.log") fans out to per-file results (cap 10 files, newest first; limit applies per file and is capped at 25 lines; all files share a 10 KB output budget); literal-named files win over expansion.',
                },
                offset: {
                    type: 'integer',
                    minimum: 1,
                    description: '1-based start line as a bare integer; default 1.',
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Maximum line count as a bare integer; default 500 for one exact file, capped at 25 per file for glob expansion.',
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
        description: `Run programs, runtime/state operations, calculations, transformations, file generation, and unsupported-format inspection. ${_shellToolRouting} ${_shellBackgroundDisabled ? 'Commands run in the foreground until completion.' : 'Commands use a 10s foreground window by default—not a timeout. Still-running work continues as a tracked task_id. Completion is automatic; unless periodic task reports were requested, continue independent work or end the turn. When the next step needs the result or the next report interval, call task wait instead of polling task read: it returns the moment the task settles, or hands back the current output at its ceiling so you can re-decide.'}`,
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: `Command.${_shellSyntaxCheat}` },
                timeout_ms: {
                    type: 'number',
                    minimum: 0,
                    description: 'Hard process-kill deadline in ms; unrelated to the automatic 10s foreground window and still applies after background promotion. Omit for normal builds/tests; use only when forced termination is intended. Omit or 0 = no deadline.',
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
        description: 'List shell tasks, read one snapshot, wait for one to finish, or cancel by task_id. Replaces shell job control (jobs/wait/Start-Job). Completion is automatic; unless periodic task reports were requested, continue independent work or end the turn. Never repeat read to watch a task: use wait when the next step needs the result or the next report interval, and read for a one-shot current status.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'Shell task_id; required for read/wait/cancel.' },
                action: { type: 'string', enum: ['list', 'read', 'wait', 'cancel'], description: 'list all; read snapshot; wait for completion; cancel task.' },
                timeout_ms: {
                    type: 'integer',
                    minimum: 0,
                    description: `Ceiling for action=wait; returns as soon as the task settles, and a still-running task comes back with its current output. Default ${TASK_WAIT_TIMEOUT_DEFAULT_MS}, clamped to ${TASK_WAIT_TIMEOUT_MIN_MS}-${TASK_WAIT_TIMEOUT_MAX_MS}.`,
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
        description: 'Read-only; safe to batch in parallel. Search file contents for literal or regex matches and return contextual path:line blocks that are directly usable; read only the lines they omit. All rendered output is capped at 10 KB. A wide reconnaissance pattern goes to mode:files first; context:0 when only the location is needed. Ripgrep-dialect regex (e.g. "log.*Error"; escape literal braces; patterns match within one line). Replaces grep/rg.',
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
                    type: 'string',                    description: 'Relative file-path glob filter evaluated inside path (e.g. "*.cs", "src/**/*.ts"). Never pass an absolute or exact file path here; use path instead.',
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
                limit: { type: 'integer', minimum: 0, maximum: 100, description: 'Max entries; default 100; 0 = no page cap (absolute cap still applies).' },
                offset: { type: 'integer', minimum: 0, description: 'Entry offset.' },
            },
            required: [],
            additionalProperties: false,
        },
    },
];
