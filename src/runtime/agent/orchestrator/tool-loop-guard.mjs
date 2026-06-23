/**
 * Shell file-lookup classifier + soft-warn marker stripper.
 *
 * The tool-loop guard subsystem (repeated/fanned-out tool-use detection and its
 * soft-warn sidecars) was removed once every warn path had been disabled. Two
 * standalone utilities remain:
 *   • classifyBashFileLookupCommand — detects a `bash` call whose first token is
 *     a file-lookup that has a dedicated in-process tool (read/grep/glob/list).
 *     Used by the bridge-worker permission gate to block the shell route.
 *   • stripSoftWarns — strips legacy soft-warn marker blocks from outbound
 *     bodies so older transcripts that still carry them stay clean.
 */

// File-lookup-via-shell detector. Matches a `bash` command whose first token
// is a unix find/grep/cat/ls/head/tail OR a powershell file-discovery cmdlet
// (Get-ChildItem / Select-String / Get-Content). These have dedicated tools
// (glob / grep / read / list) per rules/shared/01-tool.md; using bash routes
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

// Strip soft-warn marker blocks (header ⚠ <label> through next blank line / EOF)
// from outbound bodies. Never call on tool-result bodies fed back to the model.
// New compact format: each warn is a single line starting with `⚠ <Label>(` and ending at newline.
// Legacy multi-line markers retained for older transcripts: `⚠ ... soft-warn ...` block until blank line.
const SOFT_WARN_RE = /⚠\s+(?:Tool-loop|Repeated-tool|Repeated-input|Tool-budget|Same-file\s+multi-chunk|Same-file\s+reads|Same-slice\s+reads|Edit-miss|Mixed-tool|Bash\s+file-lookup|Iteration|0-match)\([^\n]*\n?|⚠\s+(?:(?:Tool-loop|Repeated-tool|Repeated-input|Tool-budget|Same-file\s+multi-chunk|Same-file\s+reads|Same-slice\s+reads|Edit-miss|Mixed-tool|Bash\s+file-lookup|Iteration)\s+soft-warn|0-match\s+(?:family-switch\s+advisory|ESCALATED))[^]*?(?:\n\s*\n|$)/g;
export function stripSoftWarns(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    return text.replace(SOFT_WARN_RE, '');
}
