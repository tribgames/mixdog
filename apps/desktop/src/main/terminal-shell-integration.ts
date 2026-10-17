// Shell integration for terminals Mixdog spawns itself: the shell is started
// with Mixdog's own startup code (an encoded command, an init file, or a
// private ZDOTDIR) that first loads the user's usual profile files and then
// prints the prompt and command markers terminal-activity.ts reads. Nothing
// outside Mixdog's data directory is written. Shells and argument lists that
// cannot be integrated are spawned unchanged and report no activity.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type TerminalShellIntegration = 'powershell' | 'bash' | 'zsh' | 'cmd';

export interface TerminalSpawnPlan {
  path: string;
  args: string[];
  env: Record<string, string>;
  integration: TerminalShellIntegration | null;
}

/** PowerShell: wraps the prompt (exit status, prompt) and PSReadLine's line
 *  reader (command start). Without PSReadLine no command start is visible,
 *  so nothing is installed and the terminal stays unknown. Writing the
 *  markers resets $?, so a failed status is re-created (a silent, unrecorded
 *  error) right before the user's own prompt reads it. */
const POWERSHELL_SCRIPT = `
if (Get-Command PSConsoleHostReadLine -CommandType Function -ErrorAction SilentlyContinue) {
  $global:__mixdogMark = { param($body) [Console]::Write("$([char]27)]697;$body$([char]7)") }
  $global:__mixdogPrompt = $function:prompt
  $global:__mixdogReadLine = $function:PSConsoleHostReadLine
  function global:prompt {
    $ok = $global:?
    $code = if ($ok) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }
    & $global:__mixdogMark "D;$code"
    & $global:__mixdogMark 'P'
    if (-not $ok) { Write-Error -Message 'failed' -ErrorAction Ignore }
    & $global:__mixdogPrompt
  }
  function global:PSConsoleHostReadLine {
    $line = & $global:__mixdogReadLine
    & $global:__mixdogMark 'C'
    $line
  }
}
`;

/** bash (Linux, macOS, Git Bash, MSYS2, Cygwin) adds PROMPT_COMMAND and PS0
 *  hooks; PS0 needs bash 4.4, so older bash gets no markers (unknown).
 *  - A non-login shell starts with --init-file: the script first reads the
 *    files bash itself would have read.
 *  - A login shell keeps its own arguments and startup, so it stays a real
 *    login shell; the script is sourced from the first prompt through an
 *    inherited PROMPT_COMMAND (BASH_BOOT). A profile that replaces
 *    PROMPT_COMMAND outright leaves the terminal unintegrated (unknown). */
const BASH_SCRIPT = `# Mixdog terminal integration (bash)
if [ -z "$__mixdog_bash" ]; then
  __mixdog_bash=1
  if [ -n "$__mixdog_bash_boot" ]; then
    export -n PROMPT_COMMAND
  else
    [ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
    [ -r ~/.bashrc ] && . ~/.bashrc
  fi
  if [ "\${BASH_VERSINFO[0]}" -gt 4 ] || { [ "\${BASH_VERSINFO[0]}" -eq 4 ] && [ "\${BASH_VERSINFO[1]}" -ge 4 ]; }; then
    __mixdog_prompt() {
      local code=$?
      printf '\\033]697;D;%s\\007\\033]697;P\\007' "$code"
      return "$code"
    }
    PROMPT_COMMAND="__mixdog_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
    PS0="\${PS0}"$'\\033]697;C\\007'
    # Sourced from this prompt's PROMPT_COMMAND: the hook starts with the next.
    [ -n "$__mixdog_bash_boot" ] && printf '\\033]697;P\\007'
  fi
  unset __mixdog_bash_boot
fi
`;

/** The PROMPT_COMMAND a login bash inherits: sources the script once. */
const bashBoot = (script: string): string =>
  `[ -n "$__mixdog_bash" ] || { __mixdog_bash_boot=1; . '${script.replace(/'/g, `'\\''`)}'; }`;

/** zsh through a private ZDOTDIR: each startup file loads the user's own
 *  counterpart; .zshrc hands ZDOTDIR back and adds precmd/preexec hooks.
 *  ZDOTDIR is unset at the end only when it was unset at launch and no user
 *  file set it since: a ZDOTDIR the user's files chose is theirs to keep. */
const zshForward = (file: string): string => `# Mixdog terminal integration (zsh)
MIXDOG_ZDOTDIR=$ZDOTDIR
ZDOTDIR=\${MIXDOG_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/${file} ]] && source $ZDOTDIR/${file}
if [[ $ZDOTDIR != \${MIXDOG_USER_ZDOTDIR:-$HOME} ]]; then unset MIXDOG_ZDOTDIR_UNSET; fi
MIXDOG_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$MIXDOG_ZDOTDIR
`;
const ZSH_RC = `# Mixdog terminal integration (zsh)
ZDOTDIR=\${MIXDOG_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
if [[ -n $MIXDOG_ZDOTDIR_UNSET && $ZDOTDIR == \${MIXDOG_USER_ZDOTDIR:-$HOME} ]]; then unset ZDOTDIR; fi
unset MIXDOG_ZDOTDIR MIXDOG_USER_ZDOTDIR MIXDOG_ZDOTDIR_UNSET
__mixdog_precmd() {
  local code=$?
  print -rn -- $'\\e]697;D;'"$code"$'\\a\\e]697;P\\a'
  return $code
}
__mixdog_preexec() { print -rn -- $'\\e]697;C\\a'; }
precmd_functions=(__mixdog_precmd $precmd_functions)
preexec_functions=(__mixdog_preexec $preexec_functions)
`;

/** The startup files, keyed by their path under the integration directory. */
const SHELL_FILES: Record<string, string> = {
  'bash/mixdog.bash': BASH_SCRIPT,
  'zsh/.zshenv': zshForward('.zshenv'),
  'zsh/.zprofile': zshForward('.zprofile'),
  'zsh/.zshrc': ZSH_RC,
};

/** Write the startup files under `root` (a versioned subdirectory, rewritten
 *  only when missing or changed). Returns that subdirectory, or null when
 *  the files cannot be written: those shells then run without integration. */
function writeShellFiles(root: string): string | null {
  const version = createHash('sha256').update(JSON.stringify(SHELL_FILES)).digest('hex').slice(0, 12);
  const dir = path.join(root, version);
  try {
    for (const [name, content] of Object.entries(SHELL_FILES)) {
      const file = path.join(dir, name);
      let existing: string | null = null;
      try {
        existing = fs.readFileSync(file, 'utf8');
      } catch {
        /* first use */
      }
      if (existing === content) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    return dir;
  } catch {
    return null;
  }
}

const isSubset = (args: readonly string[], allowed: readonly string[]): boolean =>
  args.every((arg) => allowed.includes(arg));

/** POSIX-style path for a bash that may be an MSYS/Cygwin build on Windows. */
const shellPath = (file: string): string => file.replace(/\\/g, '/');

/** How to spawn `shell` so it reports activity. `root` is Mixdog's own
 *  directory for startup files (null: only file-less integrations apply). */
export function planShellIntegration(
  spawn: { path: string; args?: readonly string[]; env?: Record<string, string> },
  root: string | null,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): TerminalSpawnPlan {
  const args = [...(spawn.args ?? [])];
  const env = { ...(spawn.env ?? {}) };
  const unchanged: TerminalSpawnPlan = { path: spawn.path, args, env, integration: null };
  const name = path
    .basename(spawn.path.replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (name === 'pwsh' || name === 'powershell') {
    if (args.length) return unchanged;
    // An encoded command is not subject to the script execution policy, and
    // the user's profile still loads before it.
    const encoded = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64');
    return { path: spawn.path, args: ['-NoExit', '-EncodedCommand', encoded], env, integration: 'powershell' };
  }
  if (name === 'cmd' && platform === 'win32') {
    if (args.length) return unchanged;
    // cmd has no command hooks; the prompt is its only report.
    const prompt = env.PROMPT || baseEnv.PROMPT || '$P$G';
    return { path: spawn.path, args, env: { ...env, PROMPT: `$e]697;P$e\\${prompt}` }, integration: 'cmd' };
  }
  if (!root) return unchanged;
  if (name === 'bash') {
    // System32\bash.exe is the WSL launcher: its bash cannot read a Windows path.
    if (platform === 'win32' && /[\\/]system32[\\/]/i.test(spawn.path)) return unchanged;
    if (!isSubset(args, ['--login', '-l', '-i'])) return unchanged;
    const dir = writeShellFiles(root);
    if (!dir) return unchanged;
    const script = shellPath(path.join(dir, 'bash', 'mixdog.bash'));
    if (args.includes('--login') || args.includes('-l')) {
      const inherited = env.PROMPT_COMMAND || baseEnv.PROMPT_COMMAND || '';
      const boot = bashBoot(script);
      return {
        path: spawn.path,
        args,
        env: { ...env, PROMPT_COMMAND: inherited ? `${boot}; ${inherited}` : boot },
        integration: 'bash',
      };
    }
    return { path: spawn.path, args: ['--init-file', script, '-i'], env, integration: 'bash' };
  }
  if (name === 'zsh' && platform !== 'win32') {
    if (!isSubset(args, ['--login', '-l', '-i'])) return unchanged;
    const dir = writeShellFiles(root);
    if (!dir) return unchanged;
    const userDir = env.ZDOTDIR || baseEnv.ZDOTDIR || '';
    return {
      path: spawn.path,
      args,
      env: {
        ...env,
        ZDOTDIR: path.join(dir, 'zsh'),
        MIXDOG_USER_ZDOTDIR: userDir || baseEnv.HOME || '',
        ...(userDir ? {} : { MIXDOG_ZDOTDIR_UNSET: '1' }),
      },
      integration: 'zsh',
    };
  }
  return unchanged;
}
