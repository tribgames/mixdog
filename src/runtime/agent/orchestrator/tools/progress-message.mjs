// Per-tool live-status message builder (ported from claude-code's progress
// generalization / getActivityDescription). Dependency-light and
// side-effect-free: given a tool name + its raw args, return a short
// human-readable "what's happening now" string. Used by the central dispatch
// path to emit a single start-of-tool progress notification. Every tool gets a
// meaningful verb; `running ${name}` is only the last-resort fallback.
//
// Verbs are kept symmetric with claude-code's wording: Read→"reading",
// Edit→"editing", Write→"writing", Grep→"searching for", Glob→"finding",
// web search→"searching web for", web fetch→"fetching".

// Truncate long arg values so a progress line never blows past ~60 chars.
function _t(value, max = 60) {
    const s = String(value ?? '');
    return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

// Count-aware noun so a label never reads "1 files" or "3 query/queries".
// English progress strings only; default plural appends "s".
function _plural(n, one, many) {
    return `${n} ${n === 1 ? one : (many || one + 's')}`;
}

export function formatToolStartProgress(name, args = {}) {
    const a = args || {};
    switch (name) {
        // ── builtin: files / shell ───────────────────────────────────────
        case 'read':
            return a.symbol ? `reading symbol ${_t(a.symbol)}` : `reading ${_t(a.path)}`;
        case 'apply_patch':
            return a.dry_run ? 'validating patch' : 'applying patch';
        case 'shell':
            return a.command ? `running ${_t(a.command)}` : 'running shell';
        case 'task': {
            const action = a.action || 'wait';
            return action === 'list'
                ? 'listing background tasks'
                : `${action === 'wait' ? 'waiting for' : action} task ${_t(a.task_id)}`;
        }
        case 'diagnostics':
            return `running diagnostics${a.path ? ` for ${_t(a.path)}` : ''}`;

        // ── builtin / code_graph: search & navigation ────────────────────
        case 'grep':
            return Array.isArray(a.pattern) ? `searching for ${_plural(a.pattern.length, 'pattern')}` : `searching for ${_t(a.pattern)}`;
        case 'glob':
            return Array.isArray(a.pattern) ? `finding ${_plural(a.pattern.length, 'glob')}` : `finding ${_t(a.pattern)}`;
        case 'find':
            return `finding ${_t(a.query || 'files')}`;
        case 'list':
            return a.mode === 'find' ? 'finding files' : `listing ${_t(a.path || 'cwd')}`;
        case 'code_graph':
            if (a.symbol) return `locating ${_t(a.symbol)}`;
            return a.file ? `mapping ${_t(a.file)}` : 'analyzing code graph';

        // ── search module: web ───────────────────────────────────────────
        case 'search':
            return Array.isArray(a.query) ? `searching web (${_plural(a.query.length, 'query', 'queries')})` : `searching web for ${_t(a.query || a.keywords)}`;
        case 'web_fetch':
            return Array.isArray(a.url) ? `fetching ${_plural(a.url.length, 'URL')}` : `fetching ${_t(a.url)}`;

        // ── agent module: explore / agent / models ───────────────────────
        case 'explore': {
            const n = Array.isArray(a.query) ? a.query.length : (a.query ? 1 : 0);
            return `exploring ${_plural(n, 'query', 'queries')}`;
        }
        case 'agent': {
            const route = [a.preset, [a.provider, a.model].filter(Boolean).join('/')].filter(Boolean).join(' ');
            const suffix = route ? ` (${_t(route, 32)})` : '';
            if (a.role) return `dispatching ${_t(a.role)}${suffix}`;
            if (a.tag) return `messaging ${_t(a.tag)}${suffix}`;
            return 'dispatching agent';
        }
        case 'list_models':
            return 'listing models';

        // ── memory module ────────────────────────────────────────────────
        case 'recall':
            return 'recalling memory';
        case 'memory':
            return 'managing memory';

        // ── channels module ──────────────────────────────────────────────
        case 'reply':
            return 'replying';
        case 'react':
            return 'reacting';
        case 'edit_message':
            return 'editing message';
        case 'download_attachment':
            return 'downloading attachment';
        case 'fetch':
            return 'fetching messages';
        case 'schedule_status':
            return 'checking schedules';
        case 'trigger_schedule':
            return a.name ? `triggering ${_t(a.name)}` : 'triggering schedule';
        case 'schedule_control':
            return 'scheduling';
        case 'activate_channel_bridge':
            return 'activating channel';
        case 'reload_config':
            return 'reloading config';
        case 'inject_command':
            return 'injecting command';

        // ── host_input / cwd ─────────────────────────────────────────────
        case 'inject_input':
            return 'injecting input';
        case 'cwd':
            return a.action === 'set' ? 'setting cwd' : 'resolving cwd';

        default:
            return `running ${name}`;
    }
}
