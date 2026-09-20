import {
  shellSplitSegments,
  shellSplitPipelineSegments,
  shellTokenize,
  stripShellProbeWrappers,
} from '../shell-analysis.mjs';

// Search-style commands and `git diff --exit-code` use exit 1 as a SIGNAL
// (no match / has diff), not a failure. Benign ONLY when exitCode===1, no
// signal, stderr blank, AND the exit status provably comes from a search-style
// stage: the LAST segment of a `;`/`&&` chain (its status IS the chain's) whose
// last pipeline stage is a search head. `||` chains stay ambiguous (either
// branch can supply the status) and stay Error. Quote/comment aware via the
// shared shell tokenizers, so quoted/commented `;` `|` `grep` can never
// masquerade as a connector/command and hide a real failure.
const _SEARCH_HEADS = new Set(['select-string', 'sls', 'grep', 'egrep', 'fgrep', 'findstr']);
const _GIT_GLOBAL_VALUE_OPTS = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);
// Command/process/subshell substitution or a backslash/backtick-escaped pipe
// or connector can make the shared tokenizer mis-split the top level and hide
// the failing stage. If any such construct is present, refuse benign (Error).
const _AMBIGUOUS_SYNTAX = /\$\(|\$\{|<\(|>\(|`|\\\s*(?:\||&|;|\n)/;

function _stripShellComment(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) break;
    out += ch;
  }
  return out;
}

function _normalizeHead(tok) {
  return String(tok || '')
    .replace(/\.exe$/i, '')
    .split(/[\\/]/)
    .pop()
    .toLowerCase();
}

export function _isBenignSearchExitOne(command, exitCode, signal, stderr) {
  if (signal || exitCode !== 1) return false;
  if (stderr?.trim()) return false;
  const text = _stripShellComment(String(command || ''));
  if (_AMBIGUOUS_SYNTAX.test(text)) return false; // subshell/subst/escaped pipe → ambiguous
  const segments = shellSplitSegments(text);
  if (segments.length === 0) return false;
  if (segments.length > 1 && /\|\|/.test(text)) return false; // || → which branch exited 1?
  const lastSegment = segments[segments.length - 1];
  const stages = shellSplitPipelineSegments(lastSegment);
  const last = stages[stages.length - 1] || lastSegment;
  const raw = shellTokenize(last);
  if (!raw) return false; // unbalanced quotes
  const tokens = stripShellProbeWrappers(raw);
  if (!tokens.length) return false;
  const head = _normalizeHead(tokens[0]);
  if (_SEARCH_HEADS.has(head)) return true;
  if (head !== 'git') return false;
  // `git [global-opts] diff ...` only — exact `diff` subcommand, never
  // diff-index/diff-files/difftool — with exit-code semantics.
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    i += _GIT_GLOBAL_VALUE_OPTS.has(tokens[i]) && !tokens[i].includes('=') ? 2 : 1;
  }
  if (tokens[i] !== 'diff') return false;
  return tokens.slice(i + 1).some((t) => t === '--exit-code' || t === '--quiet' || t === '--check');
}
