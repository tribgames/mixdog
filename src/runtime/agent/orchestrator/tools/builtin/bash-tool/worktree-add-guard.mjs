// Whether a shell command mentions `git … worktree add`. A worktree added from
// the shell is invisible to the managed cleanup and outlives the session that
// made it, so the shell guard refuses it and points to the git tool.
//
// Deliberately textual, conservative and linear-time: no shell is parsed. The
// command is normalized once (escape and quote characters of every shell
// dropped, whitespace collapsed; a PowerShell -EncodedCommand decoded), then
// refused when `git` is followed anywhere later by `worktree … add`. Commands
// that only mention the phrase as data (echo, grep, a heredoc, a commit
// message) are refused too; the refusal says how to proceed.

const QUOTES = /['"\u2018\u2019\u201a\u201b\u201c\u201d\u201e]/g;
const GIT_WORD = /\bgit\b/i;
// `worktree` ending a token that is not an option: `worktree`, `$(worktree`, `alias.wa=worktree`.
const WORKTREE_TOKEN = /(?:^|[^\w-])worktree$/i;
const ADD_TOKEN = /^add\b/i;
// powershell/pwsh -EncodedCommand (any accepted prefix: -e, -ec, -enc, …) and its base64 argument.
const ENCODED_COMMAND = /(?:^|[\s'"])[-/]e(?:c|n[a-z]*)?\s+['"]?([A-Za-z0-9+/]{4,}={0,2})/gi;

/** The command with every shell's escapes and quotes dropped and whitespace collapsed.
 *  `joiner` replaces a line continuation: '' as POSIX joins `a\<newline>dd` into one
 *  word, ' ' where the continuation separates words. */
function normalize(text, joiner) {
  return (
    text
      .replace(/[\\`]\r?\n/g, joiner)
      // Hex escapes ($'\x61dd', "\x61dd").
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      // The `$` of a POSIX $'…' / $"…" string.
      .replace(/\$(?=['"])/g, '')
      // PowerShell backtick and cmd caret escapes.
      .replace(/[`^]/g, '')
      .replace(QUOTES, '')
      .replace(/\s+/g, ' ')
  );
}

/** True when some `git` word comes before a `worktree … add` in `text`. One pass
 *  over the tokens: options (`-…`) between `worktree` and `add` are skipped and
 *  never start a match, so every token is visited once. */
function gitThenWorktreeAdd(text) {
  const tokens = text.split(/[\s,]+/);
  let gitSeen = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!gitSeen) {
      gitSeen = GIT_WORD.test(token);
      continue;
    }
    if (token.startsWith('-') || !WORKTREE_TOKEN.test(token)) continue;
    let next = i + 1;
    while (next < tokens.length && tokens[next].startsWith('-')) next += 1;
    if (next < tokens.length && ADD_TOKEN.test(tokens[next])) return true;
    i = next - 1;
  }
  return false;
}

/** True when `command` would (or might) run `git … worktree add`. */
export function addsUnmanagedWorktree(command) {
  const raw = String(command ?? '');
  const texts = [raw];
  for (const [, encoded] of raw.matchAll(ENCODED_COMMAND)) {
    texts.push(Buffer.from(encoded, 'base64').toString('utf16le'));
  }
  return texts.some((text) =>
    ['', ' '].some((joiner) => {
      const normalized = normalize(text, joiner);
      // A backslash is a POSIX escape (`a\dd` is `add`) or a Windows path separator
      // (`C:\Git\cmd\git.exe`): both readings are checked.
      return (
        gitThenWorktreeAdd(normalized.replace(/\\(?=[A-Za-z])/g, '')) ||
        gitThenWorktreeAdd(normalized.replaceAll('\\', '/'))
      );
    })
  );
}
