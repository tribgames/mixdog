// Pre-execution rewrite of bash-isms that ALWAYS fail in Windows PowerShell, so
// the first attempt succeeds instead of costing a failed call and a retry.
// Same placement and reporting as the wmic rewrite: the caller swaps in
// `command` and prints `note` above the output.
//
// What is rewritten (only outside quotes, here-strings and comments):
//   <cmd> <<'EOF'\n…\nEOF   → @'\n…\n'@ | <cmd>        (python/python3/py/node only)
//   2>/dev/null  >/dev/null  &>/dev/null  → 2>$null  >$null  *>$null
//   </dev/null                                  → removed (the shell's stdin is already at EOF)
// `| head`/`| tail`/`| wc` are deliberately NOT rewritten: any wrapper that
// could fall back to a cmdlet changes the streaming semantics of an existing
// `head`. They only get the failure hint (result-format.mjs).
//
// Anything not exactly one of these forms (`<<-`, `cat <<EOF > file`, an
// expanding unquoted heredoc body, unbalanced quotes, ...) makes the whole
// command pass through untouched.

const PYTHON_STAGE = /^(?:python3?|py)(?:\.exe)?(?:\s+-[uBsSEIOqbd]+)*(?:\s+-)?$/i;
const NODE_STAGE = /^node(?:\.exe)?(?:\s+--[\w-]+(?:=[\w.-]+)?)*(?:\s+-)?$/i;

const HEREDOC_OPENER = /^<<-?[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))/;

/** Marks each character 1 when it is live PowerShell code and 0 when it sits in a
 *  string, here-string, comment or after a backtick. null when the text cannot be
 *  tokenised with confidence (unterminated string, `$(` inside a double quote). */
export function codeMask(text) {
  const mask = new Uint8Array(text.length);
  // Bash heredoc bodies start on the line after their `<<DELIM` opener and are
  // opaque text (quotes inside them must not be tokenised).
  const pending = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '`') {
      i += 2;
      continue;
    }
    if (ch === '<' && text[i + 1] === '<') {
      mask[i] = mask[i + 1] = 1;
      const opener = HEREDOC_OPENER.exec(text.slice(i));
      if (opener) pending.push(opener[1] || opener[2] || opener[3]);
      i += 2;
      continue;
    }
    if (ch === '\n' && pending.length) {
      mask[i++] = 1;
      for (const delimiter of pending.splice(0)) {
        for (;;) {
          if (i >= text.length) return null;
          const nl = text.indexOf('\n', i);
          const stop = nl < 0 ? text.length : nl;
          const isTerminator = text.slice(i, stop).replace(/\r$/, '') === delimiter;
          i = nl < 0 ? text.length : nl + 1;
          if (isTerminator) break;
        }
      }
      continue;
    }
    if (ch === '<' && text[i + 1] === '#') {
      const end = text.indexOf('#>', i + 2);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    if (ch === '#' && (i === 0 || /[\s;({|]/.test(text[i - 1]))) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (ch === '@' && (text[i + 1] === "'" || text[i + 1] === '"')) {
      const quote = text[i + 1];
      const open = /^[ \t]*\r?\n/.exec(text.slice(i + 2));
      if (open) {
        const close = text.indexOf(`\n${quote}@`, i + 2 + open[0].length - 1);
        if (close < 0) return null;
        i = close + 3;
        continue;
      }
    }
    if (ch === "'") {
      i++;
      for (;;) {
        const end = text.indexOf("'", i);
        if (end < 0) return null;
        if (text[end + 1] === "'") {
          i = end + 2;
          continue;
        }
        i = end + 1;
        break;
      }
      continue;
    }
    if (ch === '"') {
      i++;
      for (;;) {
        if (i >= text.length) return null;
        const c = text[i];
        if (c === '`') {
          i += 2;
          continue;
        }
        if (c === '$' && text[i + 1] === '(') return null;
        if (c === '"') {
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    mask[i++] = 1;
  }
  return mask;
}

// The text with every non-code character replaced by NUL, offsets unchanged, so
// regexes only ever see live code.
function codeOnly(text, mask) {
  let out = '';
  for (let i = 0; i < text.length; i++) out += mask[i] ? text[i] : '\0';
  return out;
}

/** One heredoc → here-string rewrite, or { skip } when the heredoc is not one of
 *  the exactly-safe shapes. */
function rewriteOneHeredoc(text, at) {
  const opener = /^<<(?![<-])[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))/.exec(text.slice(at));
  if (!opener) return { skip: true };
  const delimiter = opener[1] || opener[2] || opener[3];
  const expanding = Boolean(opener[3]);
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const lineEnd = text.indexOf('\n', at) < 0 ? text.length : text.indexOf('\n', at);
  const before = text.slice(lineStart, at);
  const rest = text.slice(at + opener[0].length, lineEnd).replace(/\r$/, '');
  if (/['"`$<]/.test(rest) || lineEnd >= text.length) return { skip: true };
  // The stage is what follows the last live `;` / `&&` on the opener line.
  const beforeMask = codeMask(before);
  if (!beforeMask) return { skip: true };
  let stageFrom = 0;
  for (let i = 0; i < before.length; i++) {
    if (!beforeMask[i]) continue;
    if (before[i] === ';') stageFrom = i + 1;
    else if (before[i] === '&' && before[i + 1] === '&') stageFrom = ++i + 1;
    else if (before[i] === '|' || before[i] === '&') return { skip: true };
  }
  const stage = before.slice(stageFrom).trim();
  if (!PYTHON_STAGE.test(stage) && !NODE_STAGE.test(stage)) return { skip: true };
  // Body: the lines up to the first line that is exactly the delimiter.
  const bodyStart = lineEnd + 1;
  let cursor = bodyStart;
  let termStart = -1;
  let termEnd = text.length;
  while (cursor <= text.length) {
    const nl = text.indexOf('\n', cursor);
    const lineStop = nl < 0 ? text.length : nl;
    if (text.slice(cursor, lineStop).replace(/\r$/, '') === delimiter) {
      termStart = cursor;
      termEnd = lineStop;
      break;
    }
    if (nl < 0) break;
    cursor = nl + 1;
  }
  if (termStart < 0) return { skip: true };
  const body = text.slice(bodyStart, termStart).replace(/\r?\n$/, '');
  // `'@` at a line start would end the here-string early; an unquoted heredoc
  // body is only literal when bash would expand nothing in it.
  if (/^'@/m.test(body)) return { skip: true };
  if (expanding && /[$`]|\\[\\$`\n]|\\$/.test(body)) return { skip: true };
  const prefix = before.slice(0, stageFrom);
  const replacement = `${prefix}${prefix && !/\s$/.test(prefix) ? ' ' : ''}@'\n${body}\n'@ | ${stage}${rest ? ` ${rest.trim()}` : ''}`;
  return {
    text: text.slice(0, lineStart) + replacement + text.slice(termEnd),
    note: `[rewritten: "${stage} <<${opener[1] || opener[2] ? `'${delimiter}'` : delimiter}" → "@'…'@ | ${stage}"]`,
  };
}

function rewriteHeredocs(text, notes) {
  let current = text;
  for (let guard = 0; guard < 20; guard++) {
    const mask = codeMask(current);
    if (!mask) return null;
    let at = -1;
    for (let i = current.indexOf('<<'); i >= 0; i = current.indexOf('<<', i + 1)) {
      if (mask[i]) {
        at = i;
        break;
      }
    }
    if (at < 0) return current;
    const done = rewriteOneHeredoc(current, at);
    if (done.skip) return null;
    notes.push(done.note);
    current = done.text;
  }
  return null;
}

const DEVNULL_REDIRECT = /(>>?)[ \t]*\/dev\/null(?![\w/.\\-])/g;
const DEVNULL_STDIN = /[ \t]*(?<!<)<[ \t]*\/dev\/null(?![\w/.\\-])/g;

// All edits are computed on the code-only view and applied back to front.
function collectEdits(text, mask, notes) {
  const code = codeOnly(text, mask);
  const edits = [];
  for (const m of code.matchAll(DEVNULL_REDIRECT)) {
    // `&>` (both streams) and a 1>/2> stream prefix belong to the redirection.
    const before = code[m.index - 1];
    const prefixed = before === '&' || ((before === '1' || before === '2') && !/\w/.test(code[m.index - 2] ?? ''));
    const start = prefixed ? m.index - 1 : m.index;
    let streamPrefix = '';
    if (prefixed) streamPrefix = before === '&' ? '*' : before;
    const next = `${streamPrefix}${m[1]}$null`;
    edits.push({ start, end: m.index + m[0].length, text: next });
    notes.push(`[rewritten: "${text.slice(start, m.index + m[0].length)}" → "${next}"]`);
  }
  for (const m of code.matchAll(DEVNULL_STDIN)) {
    edits.push({ start: m.index, end: m.index + m[0].length, text: '' });
    notes.push('[rewritten: "</dev/null" → "" (stdin is already at EOF)]');
  }
  return edits.sort((a, b) => b.start - a.start);
}

/** `{ command, note }` when something was rewritten, else null. Callers gate on
 *  Windows + a PowerShell shell; nothing here inspects the platform. */
export function rewritePowerShellBashisms(command) {
  const original = typeof command === 'string' ? command : '';
  if (!original.includes('/dev/null') && !original.includes('<<')) return null;
  const notes = [];
  const text = rewriteHeredocs(original, notes);
  if (text === null) return null;
  const mask = codeMask(text);
  if (!mask) return null;
  let out = text;
  for (const edit of collectEdits(text, mask, notes)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  if (out === original) return null;
  return { command: out, note: [...new Set(notes)].join('\n') };
}
