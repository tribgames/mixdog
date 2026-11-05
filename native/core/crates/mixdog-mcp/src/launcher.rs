//! The `mixdog-skill-node` launcher (T §5). Skill scripts are run by the model through `shell`;
//! this module generates, per installation, the small launcher files that run the bundled JS
//! runtime on the skill-script entry, and puts their directory first on a model shell's PATH.
//! Where no bundled runtime exists the `jsRuntime` feature is off and no launcher is written —
//! a script that needs Node then fails with the shell's own "command not found".
//! Launchers carry two paths and nothing else: no credentials, no daemon identity.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use sha2::Digest;
use sha2::Sha256;

/// The one command word `${MIXDOG_SKILL_NODE}` renders to, in every shell.
pub const SKILL_LAUNCHER_COMMAND: &str = "mixdog-skill-node";
/// Carries a PowerShell caller's arguments to the entry (UTF-8 base64, tagged).
pub const SKILL_ARGV_ENV: &str = "MIXDOG_SKILL_ARGV";
const SKILL_ARGV_TAG: &str = "mixdog1";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Platform {
    Windows,
    Posix,
}

impl Platform {
    pub const fn current() -> Self {
        if cfg!(windows) { Self::Windows } else { Self::Posix }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Windows => "win32",
            Self::Posix => "posix",
        }
    }
}

/// The runtime a skill script is handed to.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SkillRuntime {
    pub platform: Platform,
    pub interpreter: String,
    /// `src/skill-script-entry.mjs` of the bundled runtime.
    pub entry: String,
    /// The interpreter is an Electron binary that needs node mode.
    pub electron: bool,
}

impl SkillRuntime {
    /// The runtime of this host: `interpreter` runs `entry` (`src/skill-script-entry.mjs` of the
    /// bundled runtime); `electron` when the interpreter is an Electron binary that needs node mode.
    pub fn new(interpreter: impl Into<String>, entry: impl Into<String>, electron: bool) -> Self {
        Self { platform: Platform::current(), interpreter: interpreter.into(), entry: entry.into(), electron }
    }

    /// Writes (or refreshes) the launchers under `data_dir` on the durability lane and returns
    /// their directory, to put first on model shells' PATH with [`with_launcher_path`].
    pub async fn ensure_dir(&self, io: DurabilityIo, data_dir: &Path) -> std::io::Result<PathBuf> {
        use mixdog_rt::LaneToken;
        let (runtime, data) = (self.clone(), data_dir.to_path_buf());
        let job = io
            .submit(&tokio_util::sync::CancellationToken::new(), move |lane| ensure_launcher_dir(lane, &runtime, &data))
            .map_err(|_| std::io::Error::other("the durability lane is full"))?;
        job.await.map_err(std::io::Error::other)?
    }
}

fn batch_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('%', "%%"))
}

fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn ps_quote(value: &str) -> String {
    let mut out = String::from("'");
    for c in value.chars() {
        out.push(c);
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}') {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// sh launcher text. Node mode for Electron is set only inside the launcher, for the one child
/// it execs; every argument and the exit code pass through.
pub fn render_posix(runtime: &SkillRuntime) -> String {
    let mut lines = vec![
        "#!/bin/sh".to_owned(),
        "# Mixdog skill-script launcher, generated for one installation. Do not edit.".to_owned(),
    ];
    if runtime.electron {
        lines.push("ELECTRON_RUN_AS_NODE=1".to_owned());
        lines.push("export ELECTRON_RUN_AS_NODE".to_owned());
    }
    lines.push(format!("exec {} {} \"$@\"", posix_quote(&runtime.interpreter), posix_quote(&runtime.entry)));
    lines.join("\n") + "\n"
}

/// `.cmd` launcher text, same contract as the sh launcher.
pub fn render_windows(runtime: &SkillRuntime) -> String {
    // cmd decodes a batch file in the console code page line by line, so a non-ASCII path needs
    // UTF-8 for the lines after chcp; the caller's code page is restored before exit.
    let unicode = !(runtime.interpreter.is_ascii() && runtime.entry.is_ascii());
    let mut lines: Vec<String> = vec![
        "@echo off".to_owned(),
        "rem Mixdog skill-script launcher, generated for one installation. Do not edit.".to_owned(),
        "setlocal EnableExtensions DisableDelayedExpansion".to_owned(),
    ];
    if unicode {
        lines.push("for /f \"tokens=2 delims=:.\" %%C in ('chcp') do set \"MIXDOG_SKILL_CP=%%C\"".to_owned());
        lines.push("chcp 65001 >nul".to_owned());
    }
    if runtime.electron {
        lines.push("set \"ELECTRON_RUN_AS_NODE=1\"".to_owned());
    }
    lines.push(format!("{} {} %*", batch_quote(&runtime.interpreter), batch_quote(&runtime.entry)));
    lines.push("set \"MIXDOG_SKILL_EXIT=%ERRORLEVEL%\"".to_owned());
    if unicode {
        lines.push("if defined MIXDOG_SKILL_CP chcp %MIXDOG_SKILL_CP% >nul".to_owned());
    }
    lines.push("exit /b %MIXDOG_SKILL_EXIT%".to_owned());
    lines.join("\r\n") + "\r\n"
}

/// One-line PowerShell definition of `mixdog-skill-node`, prepended to every PowerShell model
/// command. Through PATH, PowerShell would reach the `.cmd` via `cmd.exe /c` with arguments it
/// does not quote; the function runs the interpreter as a plain native command instead, so
/// streaming, `$LASTEXITCODE` and redirection behave. The caller's arguments travel in
/// [`SKILL_ARGV_ENV`] (UTF-8 base64) because Windows PowerShell 5.1 drops empty native
/// arguments and does not escape embedded double quotes.
pub fn render_powershell_function(runtime: &SkillRuntime) -> String {
    let mut names = vec![SKILL_ARGV_ENV];
    let mut values = vec!["$__mxa"];
    if runtime.electron {
        names.push("ELECTRON_RUN_AS_NODE");
        values.push("'1'");
    }
    let saves = names
        .iter()
        .enumerate()
        .map(|(i, n)| format!("$__mxo{i} = $env:{n}"))
        .collect::<Vec<_>>()
        .join("; ");
    let sets: String = names
        .iter()
        .zip(&values)
        .map(|(n, v)| format!("$env:{n} = {v};"))
        .collect::<Vec<_>>()
        .join(" ");
    let restores = names
        .iter()
        .enumerate()
        .map(|(i, n)| format!("$env:{n} = $__mxo{i}"))
        .collect::<Vec<_>>()
        .join("; ");
    let body = [
        format!("$__mxa = '{SKILL_ARGV_TAG}'"),
        "foreach ($__mxv in $args) { foreach ($__mxe in @($__mxv)) { if ($null -ne $__mxe) { $__mxa += ',' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$__mxe)) } } }".to_owned(),
        saves,
        format!(
            "try {{ {sets} & {} {} }} finally {{ {restores} }}",
            ps_quote(&runtime.interpreter),
            ps_quote(&runtime.entry)
        ),
        "if ($LASTEXITCODE) { exit $LASTEXITCODE }".to_owned(),
    ];
    format!("function {SKILL_LAUNCHER_COMMAND} {{ {} }}", body.join("; "))
}

/// The arguments a PowerShell caller sent through [`SKILL_ARGV_ENV`]; `None` when the value is
/// not ours.
pub fn decode_argv(value: &str) -> Option<Vec<String>> {
    use base64::Engine;
    let rest = value.strip_prefix(SKILL_ARGV_TAG)?;
    if rest.is_empty() {
        return Some(Vec::new());
    }
    rest.strip_prefix(',')?
        .split(',')
        .map(|item| {
            let bytes = base64::engine::general_purpose::STANDARD.decode(item).ok()?;
            String::from_utf8(bytes).ok()
        })
        .collect()
}

/// `(file name, content)` of every launcher file: the sh script everywhere, plus the `.cmd` on
/// Windows.
pub fn launcher_files(runtime: &SkillRuntime) -> Vec<(String, String)> {
    let mut files = vec![(SKILL_LAUNCHER_COMMAND.to_owned(), render_posix(runtime))];
    if runtime.platform == Platform::Windows {
        files.push((format!("{SKILL_LAUNCHER_COMMAND}.cmd"), render_windows(runtime)));
    }
    files
}

/// Private per-installation directory under the data dir, named by a digest of the runtime.
pub fn launcher_dir(runtime: &SkillRuntime, data_dir: &Path) -> PathBuf {
    let mut hasher = Sha256::new();
    for part in [
        runtime.platform.name(),
        runtime.interpreter.as_str(),
        runtime.entry.as_str(),
        if runtime.electron { "electron" } else { "node" },
    ] {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    let digest: String = hasher.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect();
    data_dir.join("skill-launchers").join(digest)
}

/// Writes (atomically) or refreshes the launchers and returns their directory.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job (InLane proof)")]
pub fn ensure_launcher_dir(
    _lane: &InLane<DurabilityIo>,
    runtime: &SkillRuntime,
    data_dir: &Path,
) -> std::io::Result<PathBuf> {
    let dir = launcher_dir(runtime, data_dir);
    std::fs::create_dir_all(&dir)?;
    for (name, content) in launcher_files(runtime) {
        let target = dir.join(&name);
        if std::fs::read_to_string(&target).is_ok_and(|current| current == content) {
            continue;
        }
        let staging = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
        std::fs::write(&staging, &content)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o700))?;
        }
        std::fs::rename(&staging, &target)?;
    }
    Ok(dir)
}

/// `env` with `dir` first on PATH. Only model shell environments call this, so the daemon's own
/// environment, hooks and workers keep their PATH; the directory holds nothing but launchers.
pub fn with_launcher_path(env: &mut HashMap<String, String>, platform: Platform, dir: &Path) {
    let delimiter = if platform == Platform::Windows { ';' } else { ':' };
    // Windows variable names are case-insensitive and usually spelled `Path`.
    let key = if platform == Platform::Windows {
        env.keys().find(|k| k.eq_ignore_ascii_case("PATH")).cloned()
    } else {
        None
    }
    .unwrap_or_else(|| "PATH".to_owned());
    let dir = dir.to_string_lossy().into_owned();
    let existing = env.get(&key).cloned().unwrap_or_default();
    let mut entries = vec![dir.clone()];
    entries.extend(existing.split(delimiter).filter(|e| !e.is_empty() && *e != dir).map(str::to_owned));
    env.insert(key, entries.join(&delimiter.to_string()));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime(electron: bool) -> SkillRuntime {
        SkillRuntime {
            platform: Platform::Posix,
            interpreter: "/opt/it's/node".to_owned(),
            entry: "/opt/app/src/skill-script-entry.mjs".to_owned(),
            electron,
        }
    }

    #[test]
    fn posix_launcher_quotes_and_scopes_electron_mode() {
        let text = render_posix(&runtime(true));
        assert!(text.contains("export ELECTRON_RUN_AS_NODE"));
        assert!(text.contains("exec '/opt/it'\\''s/node' '/opt/app/src/skill-script-entry.mjs' \"$@\""));
        assert!(!render_posix(&runtime(false)).contains("ELECTRON"));
    }

    #[test]
    fn windows_launcher_switches_code_page_only_for_non_ascii() {
        let mut r = runtime(false);
        r.interpreter = "C:\\Program Files\\node.exe".to_owned();
        r.entry = "C:\\app\\entry.mjs".to_owned();
        assert!(!render_windows(&r).contains("chcp"));
        r.entry = "C:\\앱\\entry.mjs".to_owned();
        let text = render_windows(&r);
        assert!(text.contains("chcp 65001") && text.ends_with("exit /b %MIXDOG_SKILL_EXIT%\r\n"));
    }

    #[test]
    fn argv_round_trips_through_the_env_encoding() {
        use base64::Engine;
        let enc = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
        let value = format!("mixdog1,{},{}", enc("a b"), enc(""));
        assert_eq!(decode_argv(&value), Some(vec!["a b".to_owned(), String::new()]));
        assert_eq!(decode_argv("mixdog1"), Some(Vec::new()));
        assert_eq!(decode_argv("other"), None);
    }

    #[test]
    fn launcher_dir_is_first_on_path_once() {
        let mut env = HashMap::from([("Path".to_owned(), "C:\\a;C:\\L;C:\\b".to_owned())]);
        with_launcher_path(&mut env, Platform::Windows, Path::new("C:\\L"));
        assert_eq!(env["Path"], "C:\\L;C:\\a;C:\\b");
    }

    #[test]
    fn digest_distinguishes_runtimes() {
        let a = launcher_dir(&runtime(false), Path::new("/d"));
        let b = launcher_dir(&runtime(true), Path::new("/d"));
        assert_ne!(a, b);
    }
}
