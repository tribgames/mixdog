//! Shell integration for terminals Mixdog spawns itself: the shell is started with Mixdog's own
//! startup code (an encoded command, an init file, or a private ZDOTDIR) that first loads the
//! user's usual profile files and then prints the prompt and command markers `markers.rs` reads.
//! Nothing outside Mixdog's data directory is written. Shells and argument lists that cannot be
//! integrated are spawned unchanged and report no activity.

use std::path::Path;
use std::path::PathBuf;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Integration {
    Powershell,
    Bash,
    Zsh,
    Cmd,
}

/// A shell and its arguments, as the picker hands them over.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct SpawnProfile {
    pub path: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SpawnPlan {
    pub path: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub integration: Option<Integration>,
}

/// PowerShell: wraps the prompt (exit status, prompt) and PSReadLine's line reader (command
/// start). Without PSReadLine no command start is visible, so nothing is installed and the
/// terminal stays unknown. Writing the markers resets `$?`, so a failed status is re-created (a
/// silent, unrecorded error) right before the user's own prompt reads it.
const POWERSHELL_SCRIPT: &str = r##"
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
"##;

/// bash (Linux, macOS, Git Bash, MSYS2, Cygwin) adds PROMPT_COMMAND and PS0 hooks; PS0 needs
/// bash 4.4, so older bash gets no markers (unknown).
/// - A non-login shell starts with --init-file: the script first reads the files bash itself
///   would have read.
/// - A login shell keeps its own arguments and startup, so it stays a real login shell; the
///   script is sourced from the first prompt through an inherited PROMPT_COMMAND (BASH_BOOT). A
///   profile that replaces PROMPT_COMMAND outright leaves the terminal unintegrated (unknown).
const BASH_SCRIPT: &str = r##"# Mixdog terminal integration (bash)
if [ -z "$__mixdog_bash" ]; then
  __mixdog_bash=1
  if [ -n "$__mixdog_bash_boot" ]; then
    export -n PROMPT_COMMAND
  else
    [ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
    [ -r ~/.bashrc ] && . ~/.bashrc
  fi
  if [ "${BASH_VERSINFO[0]}" -gt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -ge 4 ]; }; then
    __mixdog_prompt() {
      local code=$?
      printf '\033]697;D;%s\007\033]697;P\007' "$code"
      return "$code"
    }
    PROMPT_COMMAND="__mixdog_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
    PS0="${PS0}"$'\033]697;C\007'
    # Sourced from this prompt's PROMPT_COMMAND: the hook starts with the next.
    [ -n "$__mixdog_bash_boot" ] && printf '\033]697;P\007'
  fi
  unset __mixdog_bash_boot
fi
"##;

/// zsh through a private ZDOTDIR: each startup file loads the user's own counterpart; .zshrc
/// hands ZDOTDIR back and adds precmd/preexec hooks. ZDOTDIR is unset at the end only when it
/// was unset at launch and no user file set it since: a ZDOTDIR the user's files chose is theirs
/// to keep.
fn zsh_forward(file: &str) -> String {
    format!(
        r##"# Mixdog terminal integration (zsh)
MIXDOG_ZDOTDIR=$ZDOTDIR
ZDOTDIR=${{MIXDOG_USER_ZDOTDIR:-$HOME}}
[[ -r $ZDOTDIR/{file} ]] && source $ZDOTDIR/{file}
if [[ $ZDOTDIR != ${{MIXDOG_USER_ZDOTDIR:-$HOME}} ]]; then unset MIXDOG_ZDOTDIR_UNSET; fi
MIXDOG_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$MIXDOG_ZDOTDIR
"##
    )
}

const ZSH_RC: &str = r##"# Mixdog terminal integration (zsh)
ZDOTDIR=${MIXDOG_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
if [[ -n $MIXDOG_ZDOTDIR_UNSET && $ZDOTDIR == ${MIXDOG_USER_ZDOTDIR:-$HOME} ]]; then unset ZDOTDIR; fi
unset MIXDOG_ZDOTDIR MIXDOG_USER_ZDOTDIR MIXDOG_ZDOTDIR_UNSET
__mixdog_precmd() {
  local code=$?
  print -rn -- $'\e]697;D;'"$code"$'\a\e]697;P\a'
  return $code
}
__mixdog_preexec() { print -rn -- $'\e]697;C\a'; }
precmd_functions=(__mixdog_precmd $precmd_functions)
preexec_functions=(__mixdog_preexec $preexec_functions)
"##;

/// The startup files, keyed by their path under the integration directory.
fn shell_files() -> Vec<(&'static str, String)> {
    vec![
        ("bash/mixdog.bash", BASH_SCRIPT.to_owned()),
        ("zsh/.zshenv", zsh_forward(".zshenv")),
        ("zsh/.zprofile", zsh_forward(".zprofile")),
        ("zsh/.zshrc", ZSH_RC.to_owned()),
    ]
}

/// Version of the file set, so a changed script gets a new directory (FNV-1a, 12 hex digits).
fn version(files: &[(&str, String)]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for (name, content) in files {
        for byte in name.bytes().chain([0]).chain(content.bytes()).chain([0]) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{hash:016x}")[..12].to_owned()
}

/// Writes the startup files under `root` (a versioned subdirectory, rewritten only when missing
/// or changed). `None` when they cannot be written: those shells then run without integration.
fn write_shell_files(root: &Path) -> Option<PathBuf> {
    let files = shell_files();
    let dir = root.join(version(&files));
    for (name, content) in &files {
        let file = dir.join(name);
        if std::fs::read_to_string(&file).is_ok_and(|existing| existing == *content) {
            continue;
        }
        std::fs::create_dir_all(file.parent()?).ok()?;
        std::fs::write(&file, content).ok()?;
    }
    Some(dir)
}

/// POSIX-style path for a bash that may be an MSYS/Cygwin build on Windows.
fn shell_path(file: &Path) -> String {
    file.to_string_lossy().replace('\\', "/")
}

/// The PROMPT_COMMAND a login bash inherits: sources the script once.
fn bash_boot(script: &str) -> String {
    format!(
        "[ -n \"$__mixdog_bash\" ] || {{ __mixdog_bash_boot=1; . '{}'; }}",
        script.replace('\'', "'\\''")
    )
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn lookup<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    env.iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
}

fn with_env(mut env: Vec<(String, String)>, key: &str, value: String) -> Vec<(String, String)> {
    env.retain(|(k, _)| k != key);
    env.push((key.to_owned(), value));
    env
}

fn is_subset(args: &[String], allowed: &[&str]) -> bool {
    args.iter().all(|arg| allowed.contains(&arg.as_str()))
}

/// How to spawn `spawn` so it reports activity. `root` is Mixdog's own directory for startup
/// files (`None`: only file-less integrations apply). `base_env` reads the environment the shell
/// will inherit.
pub fn plan_shell_integration(
    spawn: &SpawnProfile,
    root: Option<&Path>,
    base_env: &dyn Fn(&str) -> Option<String>,
    windows: bool,
) -> SpawnPlan {
    let args = spawn.args.clone();
    let env = spawn.env.clone();
    let unchanged = SpawnPlan {
        path: spawn.path.clone(),
        args: args.clone(),
        env: env.clone(),
        integration: None,
    };
    let normalized = spawn.path.replace('\\', "/");
    let name = normalized
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_lowercase()
        .trim_end_matches(".exe")
        .to_owned();
    if name == "pwsh" || name == "powershell" {
        if !args.is_empty() {
            return unchanged;
        }
        // An encoded command is not subject to the script execution policy, and the user's
        // profile still loads before it.
        let utf16: Vec<u8> = POWERSHELL_SCRIPT
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        return SpawnPlan {
            path: spawn.path.clone(),
            args: vec!["-NoExit".into(), "-EncodedCommand".into(), base64(&utf16)],
            env,
            integration: Some(Integration::Powershell),
        };
    }
    if name == "cmd" && windows {
        if !args.is_empty() {
            return unchanged;
        }
        // cmd has no command hooks; the prompt is its only report.
        let prompt = lookup(&env, "PROMPT")
            .map(str::to_owned)
            .or_else(|| base_env("PROMPT").filter(|v| !v.is_empty()))
            .unwrap_or_else(|| "$P$G".to_owned());
        return SpawnPlan {
            path: spawn.path.clone(),
            args,
            env: with_env(env, "PROMPT", format!("$e]697;P$e\\{prompt}")),
            integration: Some(Integration::Cmd),
        };
    }
    let Some(root) = root else {
        return unchanged;
    };
    if name == "bash" {
        // System32\bash.exe is the WSL launcher: its bash cannot read a Windows path.
        if windows && spawn.path.to_lowercase().replace('/', "\\").contains("\\system32\\") {
            return unchanged;
        }
        if !is_subset(&args, &["--login", "-l", "-i"]) {
            return unchanged;
        }
        let Some(dir) = write_shell_files(root) else {
            return unchanged;
        };
        let script = shell_path(&dir.join("bash").join("mixdog.bash"));
        if args.iter().any(|a| a == "--login" || a == "-l") {
            let inherited = lookup(&env, "PROMPT_COMMAND")
                .map(str::to_owned)
                .or_else(|| base_env("PROMPT_COMMAND").filter(|v| !v.is_empty()))
                .unwrap_or_default();
            let boot = bash_boot(&script);
            let value = if inherited.is_empty() {
                boot
            } else {
                format!("{boot}; {inherited}")
            };
            return SpawnPlan {
                path: spawn.path.clone(),
                args,
                env: with_env(env, "PROMPT_COMMAND", value),
                integration: Some(Integration::Bash),
            };
        }
        return SpawnPlan {
            path: spawn.path.clone(),
            args: vec!["--init-file".into(), script, "-i".into()],
            env,
            integration: Some(Integration::Bash),
        };
    }
    if name == "zsh" && !windows {
        if !is_subset(&args, &["--login", "-l", "-i"]) {
            return unchanged;
        }
        let Some(dir) = write_shell_files(root) else {
            return unchanged;
        };
        let user_dir = lookup(&env, "ZDOTDIR")
            .map(str::to_owned)
            .or_else(|| base_env("ZDOTDIR").filter(|v| !v.is_empty()))
            .unwrap_or_default();
        let user = if user_dir.is_empty() {
            base_env("HOME").unwrap_or_default()
        } else {
            user_dir.clone()
        };
        let mut env = with_env(env, "ZDOTDIR", dir.join("zsh").to_string_lossy().into_owned());
        env = with_env(env, "MIXDOG_USER_ZDOTDIR", user);
        if user_dir.is_empty() {
            env = with_env(env, "MIXDOG_ZDOTDIR_UNSET", "1".to_owned());
        }
        return SpawnPlan {
            path: spawn.path.clone(),
            args,
            env,
            integration: Some(Integration::Zsh),
        };
    }
    unchanged
}
