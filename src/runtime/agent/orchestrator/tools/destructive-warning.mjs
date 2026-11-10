// Destructive command detector.
//
// Returns a short human-readable warning string when the command matches
// a known data-loss / hard-to-reverse pattern. Purely informational —
// the caller (case 'shell' in builtin.mjs) prepends the warning to the result
// envelope so the agent sees the risk inline. Does NOT block execution;
// hard blocks remain in the shared shell policy scan.

import { SHELL_NAMES as _SHELL_NAMES, WRAPPER_NAMES as _WRAPPER_NAMES } from './shell-policy.mjs';
import { extractPowerShellCommandInner } from './shell-powershell.mjs';

// A `#` (or PowerShell `<#`) starts a comment only at the start of a word:
// line start, after whitespace, or after a command operator. Inside a word or
// URL (`a#b`, `http://x/#y`, `$#`, `${#v}`) it is an ordinary character.
function _isCommentStart(text, i) {
  return i === 0 || /[\s;&|(]/.test(text[i - 1]);
}

const _PS_HERE_SQ = /@'[ \t]*\r?\n[\s\S]*?\r?\n'@/y;
const _PS_HERE_DQ = /@"[ \t]*\r?\n[\s\S]*?\r?\n"@/y;
const _HEREDOC_START = /<<-?\s*['"]?(\w+)['"]?/y;

function _closingQuote(text, from, quote, escapes) {
  let j = from;
  while (j < text.length && text[j] !== quote) j += escapes && text[j] === '\\' ? 2 : 1;
  return j < text.length ? j : -1;
}

// Single left-to-right scan so each construct is recognised by what the shell
// would see at that position (a `'` inside a comment, a `#` inside a word or a
// quote inside a here-string never mis-pair later delimiters). Any construct
// that cannot be closed (unterminated quote, `<#` without `#>`, heredoc without
// terminator) is left in the output verbatim, so uncertain text stays visible
// to the policy checks instead of being dropped.
export function stripQuotedAndHeredoc(s) {
  const text = String(s || '');
  const n = text.length;
  const pendingHeredocs = [];
  let out = '';
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '\\') {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '@' && (text[i + 1] === "'" || text[i + 1] === '"')) {
      const re = text[i + 1] === "'" ? _PS_HERE_SQ : _PS_HERE_DQ;
      re.lastIndex = i;
      const m = re.exec(text);
      if (m) {
        out += text[i + 1] === "'" ? "''" : '""';
        i += m[0].length;
        continue;
      }
    }
    if (ch === '<' && text[i + 1] === '<' && text[i - 1] !== '<') {
      _HEREDOC_START.lastIndex = i;
      const m = _HEREDOC_START.exec(text);
      if (m && new RegExp(`\\n${m[1]}\\b`).test(text.slice(i + m[0].length))) {
        // The rest of the opening line stays visible; the body is skipped at
        // the next newline.
        pendingHeredocs.push(m[1]);
        out += '<<HEREDOC>>';
        i += m[0].length;
        continue;
      }
    }
    if (ch === '<' && text[i + 1] === '#' && _isCommentStart(text, i)) {
      const end = text.indexOf('#>', i + 2);
      if (end >= 0) {
        out += ' ';
        i = end + 2;
        continue;
      }
    }
    if (ch === '#' && _isCommentStart(text, i)) {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (ch === "'" || ch === '"' || (ch === '$' && text[i + 1] === "'")) {
      const ansiC = ch === '$';
      const quote = ansiC ? "'" : ch;
      const open = ansiC ? i + 2 : i + 1;
      const close = _closingQuote(text, open, quote, ch !== "'");
      if (close >= 0) {
        out += (ansiC ? '$' : '') + quote + quote;
        i = close + 1;
        continue;
      }
    }
    if (ch === '\n' && pendingHeredocs.length) {
      let at = i;
      let found = true;
      for (const delimiter of pendingHeredocs) {
        const re = new RegExp(`\\n${delimiter}\\b`, 'g');
        re.lastIndex = at;
        const m = re.exec(text);
        if (!m) {
          found = false;
          break;
        }
        at = m.index + m[0].length;
      }
      pendingHeredocs.length = 0;
      if (found) {
        i = at;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// Heredoc bodies (shell-exec contexts route the body through scanning).
export function extractHeredocBodies(s) {
  const out = [];
  const re = /<<-?\s*['"]?(\w+)['"]?([\s\S]*?)\n\1\b/g;
  for (const m of String(s || '').matchAll(re)) out.push(m[2]);
  return out;
}

// Shell-aware tokenizer. Quoted spans stay intact; separators become
// their own token so callers can split pipeline segments cleanly.
function _tokenize(s) {
  const t = [],
    src = String(s || '');
  let cur = '',
    i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'") {
      const e = src.indexOf("'", i + 1);
      if (e === -1) {
        // Unterminated: an apostrophe inside a PowerShell word is literal, so
        // keep tokenizing instead of swallowing the rest of the command.
        cur += c;
        i++;
        continue;
      }
      cur += src.slice(i, e + 1);
      i = e + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\' && j + 1 < src.length) {
          j += 2;
          continue;
        }
        if (src[j] === '"') break;
        j++;
      }
      if (j >= src.length) {
        cur += c;
        i++;
        continue;
      }
      cur += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '\\' && i + 1 < src.length) {
      cur += src[i] + src[i + 1];
      i += 2;
      continue;
    }
    // `cur` is empty exactly at a word start (after whitespace or an operator),
    // the only place `#` / PowerShell `<#` begins a comment.
    if (!cur && c === '#') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (!cur && c === '<' && src[i + 1] === '#') {
      const end = src.indexOf('#>', i + 2);
      if (end >= 0) {
        i = end + 2;
        continue;
      }
    }
    if (c === ' ' || c === '\t') {
      if (cur) {
        t.push(cur);
        cur = '';
      }
      i++;
      continue;
    }
    if (c === '\n' || c === ';') {
      if (cur) {
        t.push(cur);
        cur = '';
      }
      t.push(c);
      i++;
      continue;
    }
    if (c === '&' || c === '|') {
      if (cur) {
        t.push(cur);
        cur = '';
      }
      if (src[i + 1] === c) {
        t.push(c + c);
        i += 2;
      } else {
        t.push(c);
        i++;
      }
      continue;
    }
    cur += c;
    i++;
  }
  if (cur) t.push(cur);
  return t;
}

function _splitSegments(tokens) {
  const segs = [],
    SEP = new Set([';', '&', '&&', '|', '||', '\n']);
  let cur = [];
  for (const t of tokens) {
    if (SEP.has(t)) {
      if (cur.length) segs.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

function _stripQuotes(t) {
  if (t.length >= 2) {
    const a = t[0],
      b = t[t.length - 1];
    if ((a === "'" && b === "'") || (a === '"' && b === '"')) return t.slice(1, -1);
  }
  return t;
}

// Skip env-var assignments and known wrapper commands (with their
// option arguments) so the underlying program reaches classification.
function _peelWrappers(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    if (_WRAPPER_NAMES.has(t)) {
      i++;
      while (
        i < tokens.length &&
        (/^[-+]/.test(tokens[i]) || /^\d+[smhd]?$/.test(tokens[i]) || /^\d+m\d+s?$/.test(tokens[i]))
      ) {
        // Long option `--key value` — consume the value too when not `=`-joined and the value is non-flag / non-assignment.
        if (
          /^--[A-Za-z0-9][\w-]*$/.test(tokens[i]) &&
          i + 1 < tokens.length &&
          !/^[-+]/.test(tokens[i + 1]) &&
          !/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i + 1])
        ) {
          i += 2;
          continue;
        }
        i++;
      }
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

// Extended: leaf commands that embed an inner command/payload. The caller
// re-scans each entry via isBlockedCommand, so we just surface the payload
// as a synthetic command string.
function _collectLeafEmbeddedPayloads(peeled, out) {
  const leaf = peeled[0];
  if (leaf === 'xargs' || leaf === 'parallel') {
    let j = 1;
    while (j < peeled.length && /^[-+]/.test(peeled[j])) {
      if (/^--[A-Za-z0-9][\w-]*$/.test(peeled[j]) && j + 1 < peeled.length && !/^[-+]/.test(peeled[j + 1])) {
        j += 2;
        continue;
      }
      j++;
    }
    if (j < peeled.length) out.push(peeled.slice(j).map(_stripQuotes).join(' '));
  } else if (leaf === 'find') {
    for (let j = 1; j < peeled.length; j++) {
      if (peeled[j] === '-exec' || peeled[j] === '-execdir') {
        const cmd = [];
        let k = j + 1;
        while (k < peeled.length && peeled[k] !== ';' && peeled[k] !== '\\;' && peeled[k] !== '+') {
          cmd.push(_stripQuotes(peeled[k]));
          k++;
        }
        if (cmd.length) out.push(cmd.join(' '));
        j = k;
      }
    }
  } else if (leaf === 'awk') {
    for (let j = 1; j < peeled.length; j++) {
      const t = peeled[j];
      if (t === '-f' || t === '-v' || t === '-F') {
        j++;
        continue;
      }
      if (t.startsWith('-')) continue;
      const body = _stripQuotes(t);
      const m = body.match(/system\s*\(\s*(['"])([\s\S]*?)\1\s*\)/);
      if (m) out.push(m[2]);
      break;
    }
  } else if (leaf === 'perl' || leaf === 'node' || leaf === 'python' || leaf === 'python3') {
    const flag = leaf === 'python' || leaf === 'python3' ? '-c' : '-e';
    for (let j = 1; j < peeled.length; j++) {
      const t = peeled[j];
      if (t === flag || (leaf === 'perl' && t === '-E')) {
        const arg = peeled[j + 1];
        if (arg) out.push(_stripQuotes(arg));
        break;
      }
      if (t.startsWith('-')) continue;
      break;
    }
  }
}

// Extract `-c <payload>` (and `--command <payload>`) for shell invocations.
// Walks options including combined short flags like `-lc`, `-ic`, `-ec`.
export function extractShellCInner(s) {
  const out = [];
  const tokens = _tokenize(s);
  const segs = _splitSegments(tokens);
  for (const seg of segs) {
    const peeled = _peelWrappers(seg);
    if (!peeled.length) continue;
    if (!_SHELL_NAMES.has(peeled[0])) {
      _collectLeafEmbeddedPayloads(peeled, out);
      continue;
    }
    for (let i = 1; i < peeled.length; i++) {
      const t = peeled[i];
      if (t === '-c' || t === '--command' || /^-[a-zA-Z]+c$/.test(t)) {
        const arg = peeled[i + 1];
        if (arg) out.push(_stripQuotes(arg));
        break;
      }
      if (t === '--rcfile' || t === '--init-file' || t === '-O' || t === '+O') {
        i++;
        continue;
      }
      if (t.startsWith('-') || t.startsWith('+')) continue;
      break;
    }
  }
  return out;
}

function _removalWarning(recursive, force) {
  if (recursive && force) return 'may recursively force-remove files';
  if (recursive) return 'may recursively remove files';
  if (force) return 'may force-remove files';
  return null;
}

// rm: detect -r/-R/--recursive AND -f/--force across split or combined
// short-flag tokens.
function _classifyRm(args) {
  let r = false,
    f = false;
  for (const t of args) {
    if (t === '--') break;
    if (t === '--recursive' || t === '-r' || t === '-R') {
      r = true;
      continue;
    }
    if (t === '--force' || t === '-f') {
      f = true;
      continue;
    }
    if (/^-[a-zA-Z]+$/.test(t)) {
      if (/[rR]/.test(t)) r = true;
      if (/f/.test(t)) f = true;
      continue;
    }
    if (t.startsWith('-')) continue;
    break;
  }
  return _removalWarning(r, f);
}

// PowerShell Remove-Item (and aliases): -Recurse/-Force, including :$true forms.
// Parity with shell-policy.mjs _removeItemRecursiveForceUnsafe switch matching.
const _PS_REMOVE_CMDS = new Set(['remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']);

function _classifyRemoveItem(args) {
  let r = false,
    f = false;
  for (const t of args) {
    if (t === '--') break;
    const low = String(t).toLowerCase();
    if (low.startsWith('-')) {
      if (/^-r(ec(urse)?)?(:\$true)?$/.test(low) || low === '-recursive') {
        r = true;
        continue;
      }
      if (/^-fo(rce)?(:\$true)?$/.test(low)) {
        f = true;
        continue;
      }
      continue;
    }
    break;
  }
  return _removalWarning(r, f);
}

// git: skip global options (-C path, -c key=val, --git-dir=..., --no-pager
// etc.) before reading the subcommand.
function _classifyGit(args) {
  let i = 0;
  while (i < args.length) {
    const t = args[i];
    if (t === '-C' || t === '-c') {
      i += 2;
      continue;
    }
    if (/^--(git-dir|work-tree|namespace)(=|$)/.test(t)) {
      i += t.includes('=') ? 1 : 2;
      continue;
    }
    if (
      t === '--no-pager' ||
      t === '--paginate' ||
      t === '--bare' ||
      t === '--exec-path' ||
      /^--(?:literal|glob|noglob|icase)-pathspecs$/.test(t)
    ) {
      i++;
      continue;
    }
    if (/^--exec-path=|^--list-cmds=/.test(t)) {
      i++;
      continue;
    }
    break;
  }
  const sub = args[i];
  if (!sub) return null;
  const rest = args.slice(i + 1);
  if (sub === 'reset' && rest.includes('--hard')) return 'may discard uncommitted changes';
  if (
    sub === 'push' &&
    rest.some(
      (t) =>
        t === '--force' ||
        t === '-f' ||
        t === '--force-with-lease' ||
        t.startsWith('--force-with-lease=') ||
        /^\+[\w/.-]+/.test(t)
    )
  )
    return 'may overwrite remote history';
  if (sub === 'clean') {
    const dry = rest.some((t) => t === '-n' || t === '--dry-run' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(t));
    const force = rest.some((t) => t === '-f' || t === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t));
    if (!dry && force) return 'may permanently delete untracked files';
  }
  if ((sub === 'checkout' || sub === 'restore') && rest.includes('.')) return 'may discard all working tree changes';
  if (sub === 'stash' && (rest[0] === 'drop' || rest[0] === 'clear')) return 'may permanently remove stashed changes';
  if (sub === 'branch' && (rest.includes('-D') || (rest.includes('--delete') && rest.includes('--force'))))
    return 'may force-delete a branch';
  if ((sub === 'commit' || sub === 'push' || sub === 'merge') && rest.includes('--no-verify'))
    return 'may skip safety hooks';
  if (sub === 'commit' && rest.includes('--amend')) return 'may rewrite the last commit';
  return null;
}

const _KUBECTL_VAL = new Set([
  '--context',
  '--cluster',
  '--namespace',
  '-n',
  '--user',
  '--kubeconfig',
  '--token',
  '--server',
  '--as',
  '--as-group',
  '--certificate-authority',
  '--client-certificate',
  '--client-key',
  '--request-timeout',
  '--cache-dir',
  '--v',
  '-v',
  '--profile',
  '--profile-output',
]);

function _classifyKubectl(args) {
  let i = 0;
  while (i < args.length) {
    const t = args[i];
    if (_KUBECTL_VAL.has(t)) {
      i += 2;
      continue;
    }
    if (t.startsWith('--') && t.includes('=')) {
      i++;
      continue;
    }
    if (t.startsWith('-')) {
      i++;
      continue;
    }
    break;
  }
  return args[i] === 'delete' ? 'may delete Kubernetes resources' : null;
}

function _classifyTerraform(args) {
  let i = 0;
  while (i < args.length) {
    const t = args[i];
    if (/^-chdir=/.test(t) || t === '-help' || t === '-version' || t === '-h') {
      i++;
      continue;
    }
    break;
  }
  return args[i] === 'destroy' ? 'may destroy Terraform infrastructure' : null;
}

function _classifyDd(args) {
  for (const t of args) {
    if (/^if=\/dev\//.test(t)) return 'may read from a raw device';
    if (/^of=\/dev\//.test(t)) return 'may write to a raw device';
  }
  return null;
}

// DB destructive pattern baseline — security policy, not a heuristic
// classifier. DROP/TRUNCATE/DELETE without WHERE are unambiguously
// data-destructive regardless of context; this list is a floor, not a
// complete SQL auditor.
const _DB_PATTERNS = [
  [/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, 'may drop or truncate database objects'],
  [/\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i, 'may delete all rows from a database table'],
];

function _classifySegment(tokens) {
  const peeled = _peelWrappers(tokens);
  if (!peeled.length) return null;
  const cmd = peeled[0],
    rest = peeled.slice(1);
  const cmdLow = cmd.toLowerCase();
  if (cmd === 'rm') return _classifyRm(rest);
  if (_PS_REMOVE_CMDS.has(cmdLow)) {
    const w = _classifyRemoveItem(rest);
    if (w) return w;
  }
  if (cmd === 'git') return _classifyGit(rest);
  if (cmd === 'kubectl') return _classifyKubectl(rest);
  if (cmd === 'terraform') return _classifyTerraform(rest);
  if (cmd === 'dd') return _classifyDd(rest);
  if (cmd === 'rmdir' || cmd === 'rd') {
    const hasS = rest.some((t) => /^\/s$/i.test(t));
    const hasDriveRoot = rest.some((t) => /^[A-Za-z]:\\?$/.test(t));
    if (hasS && hasDriveRoot) return 'may recursively remove a drive root';
  }
  return null;
}

export function getDestructiveCommandWarning(command) {
  const raw = String(command || '');
  // Per-statement DB scan (split on `;`, `&&`, `||`, `|`, `\n`) so a
  // destructive statement past a separator still surfaces.
  const cleaned = stripQuotedAndHeredoc(raw);
  for (const stmt of cleaned.split(/[;&|\n]+/)) {
    for (const [re, warning] of _DB_PATTERNS) if (re.test(stmt)) return warning;
  }
  // Tokenized walk per pipeline segment.
  const segs = _splitSegments(_tokenize(raw));
  for (const seg of segs) {
    const peeled = _peelWrappers(seg);
    if (!peeled.length) continue;
    if (_SHELL_NAMES.has(peeled[0])) {
      for (const inner of extractShellCInner(seg.join(' '))) {
        const w = getDestructiveCommandWarning(inner);
        if (w) return w;
      }
      for (const body of extractHeredocBodies(raw)) {
        const w = getDestructiveCommandWarning(body);
        if (w) return w;
      }
      continue;
    }
    const w = _classifySegment(seg);
    if (w) return w;
  }
  for (const inner of extractShellCInner(raw)) {
    const w = getDestructiveCommandWarning(inner);
    if (w) return w;
  }
  for (const inner of extractPowerShellCommandInner(raw)) {
    const w = getDestructiveCommandWarning(inner);
    if (w) return w;
  }
  return null;
}
