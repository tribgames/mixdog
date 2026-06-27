/**
 * Shell file-lookup classifier + soft-warn marker stripper.
 *
 * The tool-loop guard subsystem (repeated/fanned-out tool-use detection and its
 * soft-warn sidecars) was removed once every warn path had been disabled. Two
 * standalone utilities remain:
 *   • classifyBashFileLookupCommand — detects a `bash` call whose first token is
 *     a file-lookup that has a dedicated in-process tool (read/grep/find/glob/list).
 *     Used by the bridge-worker permission gate to block the shell route.
 *   • classifyBridgeWorkerGitMutationCommand — detects bridge-worker shell
 *     calls that try to run git operations reserved for Lead.
 *   • stripSoftWarns — strips legacy soft-warn marker blocks from outbound
 *     bodies so older transcripts that still carry them stay clean.
 */

// File-lookup-via-shell detector. Matches a `bash` command whose first token
// is a unix find/grep/cat/ls/head/tail OR a powershell file-discovery cmdlet
// (Get-ChildItem / Select-String / Get-Content). These have dedicated tools
// (find / glob / grep / read / list) per rules/shared/01-tool.md; using bash routes
// around the in-process tool cache and the path-permission check, and the
// outputs were observed in PG telemetry running 100x slower than the dedicated
// path. Get-CimInstance / Win32_Process etc. are NOT matched — process
// enumeration genuinely needs the shell. One advisory per session per matched
// command class; subsequent matches stay silent so the model isn't drowned.
const SHELL_FILE_LOOKUP_COMMANDS = [
    'find', 'ls', 'grep', 'rg', 'fd', 'cat', 'head', 'tail',
    'sed', 'awk', 'less', 'more', 'wc', 'tree',
    // File-metadata mirror paths called out in rules/shared/01-tool.md
    // Tool Routing section. Added after probe HS-A3 surfaced that the
    // rule explicitly lists `stat`, `du`, `file`, and `ls -l` as
    // forbidden mirror paths but the policy under-enforced them.
    'stat', 'du', 'file',
    'dir', 'type', 'findstr',
    'Get-ChildItem', 'gci', 'Select-String', 'sls', 'Get-Content', 'gc',
].join('|');
const BASH_FILE_LOOKUP_RE = new RegExp(
    `^\\s*(?:git\\s+(?:grep|ls-files)\\b|(?:${SHELL_FILE_LOOKUP_COMMANDS})\\b)`,
    'i',
);
// Wrapper / eval forms that route the same file-lookup intent through a host
// shell (`bash -c "grep ..."`, `pwsh -Command Get-Content ...`) or an
// inline interpreter eval (`node -e fs.readFileSync(...)`,
// `python -c "open(...)"`). Without these the advisory was bypassable just
// by quoting the call inside another command.
const BASH_WRAPPER_FILE_LOOKUP_RE = new RegExp(
    `^\\s*(?:bash|sh|zsh|fish|dash)\\b[^\\n]*\\s-\\w*c\\w*\\s+["']?\\s*(?:${SHELL_FILE_LOOKUP_COMMANDS})\\b`,
    'i',
);
const CMD_WRAPPER_FILE_LOOKUP_RE = /^\s*cmd(?:\.exe)?\s+\/[cs]\s+["']?\s*(?:dir|type|findstr)\b/i;
const PWSH_WRAPPER_FILE_LOOKUP_RE = /^\s*(?:pwsh|powershell)(?:\.exe)?\b[\s\S]*?(?:-|\/)(?:Command|c)\s+["']?\s*(?:Get-ChildItem|gci|dir|ls|Select-String|sls|Get-Content|gc|cat|type)\b/i;
const NODE_FS_EVAL_RE = /^\s*node(?:\.exe)?\b[\s\S]*?\s-e\s+["'](?![\s\S]*\bJSON\.parse\s*\()[\s\S]*?\b(?:fs\.|readFileSync|readFile|readdirSync|readdir|statSync|stat)\b/i;
const PYTHON_OPEN_EVAL_RE = /^\s*python3?(?:\.exe)?\b[\s\S]*?\s-c\s+["'][\s\S]*?\b(?:open\s*\(|Path\s*\(|read_text\s*\(|read_bytes\s*\(|iterdir\s*\()/i;
function _classifyBashFileLookup(command) {
    if (typeof command !== 'string' || !command) return null;
    const direct = command.match(BASH_FILE_LOOKUP_RE);
    if (direct) return direct[0].trim().toLowerCase();
    if (BASH_WRAPPER_FILE_LOOKUP_RE.test(command)) return 'bash-wrapped';
    if (CMD_WRAPPER_FILE_LOOKUP_RE.test(command)) return 'cmd-wrapped';
    if (PWSH_WRAPPER_FILE_LOOKUP_RE.test(command)) return 'pwsh-wrapped';
    if (NODE_FS_EVAL_RE.test(command)) return 'node-fs-eval';
    if (PYTHON_OPEN_EVAL_RE.test(command)) return 'python-open-eval';
    return null;
}

export function classifyBashFileLookupCommand(command) {
    return _classifyBashFileLookup(command);
}

const SHELL_WRAPPER_COMMANDS = new Set([
    'bash', 'sh', 'zsh', 'fish', 'dash',
    'cmd', 'cmd.exe',
    'pwsh', 'pwsh.exe', 'powershell', 'powershell.exe',
]);
const POSIX_SHELL_WRAPPER_COMMANDS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash']);
const CMD_SHELL_WRAPPER_COMMANDS = new Set(['cmd', 'cmd.exe']);
const POWERSHELL_WRAPPER_COMMANDS = new Set(['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe']);
const SHELL_SEPARATORS = new Set([';', '\n', '&&', '||', '|', '&']);
const READONLY_GIT_SUBCOMMANDS = new Set([
    'status', 'diff', 'show', 'log', 'rev-parse', 'ls-files', 'grep', 'blame', 'describe', 'merge-base',
]);

function shellTokenizeLoose(command) {
    const tokens = [];
    let current = '';
    let quote = null;
    let escape = false;
    const push = () => {
        if (current !== '') tokens.push(current);
        current = '';
    };
    const pushSep = (sep) => {
        push();
        tokens.push(sep);
    };
    for (let i = 0; i < command.length; i += 1) {
        const ch = command[i];
        if (escape) {
            current += ch;
            escape = false;
            continue;
        }
        if (ch === '\\') {
            escape = true;
            continue;
        }
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
            continue;
        }
        if (ch === '\'' || ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === '\n') {
            pushSep('\n');
            continue;
        }
        if (ch === ';') {
            pushSep(';');
            continue;
        }
        if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
            pushSep(`${ch}${ch}`);
            i += 1;
            continue;
        }
        if (ch === '|' || ch === '&') {
            pushSep(ch);
            continue;
        }
        if (/\s/.test(ch)) {
            push();
            continue;
        }
        current += ch;
    }
    push();
    return tokens;
}

function isCommandPosition(tokens, index) {
    for (let i = index - 1; i >= 0; i -= 1) {
        if (!tokens[i]) continue;
        return SHELL_SEPARATORS.has(tokens[i]);
    }
    return true;
}

function skipGitGlobalOptions(tokens, index) {
    let i = index;
    while (i < tokens.length) {
        const token = String(tokens[i] || '');
        const lower = token.toLowerCase();
        if (!token || SHELL_SEPARATORS.has(token)) return i;
        if (lower === '-c' || lower === '-C' || lower === '--git-dir' || lower === '--work-tree' || lower === '--namespace') {
            i += 2;
            continue;
        }
        if (/^(?:--git-dir|--work-tree|--namespace)=/i.test(token)) {
            i += 1;
            continue;
        }
        if (lower === '--no-pager' || lower === '-p' || lower === '--literal-pathspecs' || lower === '--glob-pathspecs' || lower === '--noglob-pathspecs' || lower === '--icase-pathspecs') {
            i += 1;
            continue;
        }
        if (/^-/.test(token)) {
            i += 1;
            continue;
        }
        return i;
    }
    return i;
}

function readonlyGitInvocation(tokens, subIndex) {
    const sub = String(tokens[subIndex] || '').toLowerCase();
    if (!READONLY_GIT_SUBCOMMANDS.has(sub)) return false;
    if (sub === 'remote') {
        const next = String(tokens[subIndex + 1] || '').toLowerCase();
        return !next || next === '-v' || next === '--verbose' || next === 'show';
    }
    if (sub === 'branch') {
        const rest = tokens.slice(subIndex + 1).filter((token) => token && !SHELL_SEPARATORS.has(token));
        return rest.length === 0 || rest.every((token) => ['--show-current', '-a', '-r', '-v', '-vv', '--all', '--remotes', '--verbose', '--contains', '--merged', '--no-merged'].includes(String(token).toLowerCase()));
    }
    return true;
}

function isShellCommandArgFlag(wrapper, flag) {
    const lower = String(flag || '').toLowerCase();
    if (POSIX_SHELL_WRAPPER_COMMANDS.has(wrapper)) return /^-\w*c\w*$/.test(lower);
    if (CMD_SHELL_WRAPPER_COMMANDS.has(wrapper)) return lower === '/c';
    if (POWERSHELL_WRAPPER_COMMANDS.has(wrapper)) return lower === '-command' || lower === '/command' || lower === '-c';
    return false;
}

export function classifyBridgeWorkerGitMutationCommand(command) {
    if (typeof command !== 'string' || !command.trim()) return null;
    const tokens = shellTokenizeLoose(command);
    for (let i = 0; i < tokens.length; i += 1) {
        const token = String(tokens[i] || '').toLowerCase();
        if (!token || SHELL_SEPARATORS.has(token) || !isCommandPosition(tokens, i)) continue;
        if (SHELL_WRAPPER_COMMANDS.has(token)) {
            for (let j = i + 1; j < tokens.length; j += 1) {
                const flag = String(tokens[j] || '').toLowerCase();
                if (SHELL_SEPARATORS.has(flag)) break;
                if (!isShellCommandArgFlag(token, flag)) continue;
                const nested = tokens.slice(j + 1).join(' ');
                const nestedHit = classifyBridgeWorkerGitMutationCommand(nested || '');
                if (nestedHit) return nestedHit;
                break;
            }
            continue;
        }
        if (token !== 'git' && token !== 'git.exe') continue;
        const subIndex = skipGitGlobalOptions(tokens, i + 1);
        const sub = String(tokens[subIndex] || '').toLowerCase();
        if (!sub || SHELL_SEPARATORS.has(sub)) return 'git';
        if (readonlyGitInvocation(tokens, subIndex)) continue;
        return `git ${sub}`;
    }
    return null;
}

// Strip soft-warn marker blocks (header ⚠ <label> through next blank line / EOF)
// from outbound bodies. Never call on tool-result bodies fed back to the model.
// New compact format: each warn is a single line starting with `⚠ <Label>(` and ending at newline.
// Legacy multi-line markers retained for older transcripts: `⚠ ... soft-warn ...` block until blank line.
const SOFT_WARN_RE = /⚠\s+(?:Tool-loop|Repeated-tool|Repeated-input|Tool-budget|Same-file\s+multi-chunk|Same-file\s+reads|Same-slice\s+reads|Edit-miss|Mixed-tool|Bash\s+file-lookup|Iteration|0-match)\([^\n]*\n?|⚠\s+(?:(?:Tool-loop|Repeated-tool|Repeated-input|Tool-budget|Same-file\s+multi-chunk|Same-file\s+reads|Same-slice\s+reads|Edit-miss|Mixed-tool|Bash\s+file-lookup|Iteration)\s+soft-warn|0-match\s+(?:family-switch\s+advisory|ESCALATED))[^]*?(?:\n\s*\n|$)/g;
export function stripSoftWarns(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    return text.replace(SOFT_WARN_RE, '');
}
