//! What a spawn request means as a program, arguments and environment.

use std::ffi::OsString;
use std::process::Command;

use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;

/// A resolved command line.
pub(crate) struct Launch {
    pub program: String,
    pub args: Vec<String>,
    /// Windows `cmd`: text appended to the command line as is, because `cmd /s /c` parses its own
    /// quoting. Only the Windows spawn paths read it.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub raw_tail: Option<String>,
}

fn shell_stem(shell: &str) -> String {
    let file = shell.rsplit(['\\', '/']).next().unwrap_or(shell);
    let lower = file.to_ascii_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_owned()
}

impl Launch {
    pub fn of(command: &CommandSpec, default_shell: &str) -> Self {
        match command {
            CommandSpec::Argv { program, args } => Self {
                program: program.clone(),
                args: args.clone(),
                raw_tail: None,
            },
            CommandSpec::Shell { script, shell } => {
                let shell = shell.as_deref().unwrap_or(default_shell);
                match shell_stem(shell).as_str() {
                    "cmd" => Self {
                        program: shell.to_owned(),
                        args: vec!["/d".into(), "/s".into(), "/c".into()],
                        raw_tail: Some(format!("\"{script}\"")),
                    },
                    "powershell" | "pwsh" => Self {
                        program: shell.to_owned(),
                        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
                            .iter()
                            .map(|a| (*a).to_owned())
                            .chain([script.clone()])
                            .collect(),
                        raw_tail: None,
                    },
                    _ => Self {
                        program: shell.to_owned(),
                        args: vec!["-c".into(), script.clone()],
                        raw_tail: None,
                    },
                }
            }
        }
    }

    /// The program to report when it cannot be started.
    pub fn program(&self) -> &str {
        &self.program
    }

    pub fn command(&self, cwd: &std::path::Path, env: &[(OsString, OsString)]) -> Command {
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.args);
        #[cfg(windows)]
        if let Some(tail) = &self.raw_tail {
            use std::os::windows::process::CommandExt;
            cmd.raw_arg(tail);
        }
        cmd.current_dir(cwd);
        cmd.env_clear();
        cmd.envs(env.iter().map(|(k, v)| (k, v)));
        cmd
    }

    /// The Windows command line `CreateProcessW` takes (MSVCRT quoting rules).
    #[cfg(windows)]
    pub fn command_line(&self) -> String {
        let mut line = quote_windows_arg(&self.program);
        for arg in &self.args {
            line.push(' ');
            line.push_str(&quote_windows_arg(arg));
        }
        if let Some(tail) = &self.raw_tail {
            line.push(' ');
            line.push_str(tail);
        }
        line
    }
}

#[cfg(windows)]
fn quote_windows_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        return arg.to_owned();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// The launching process's OS-proxy decision (`HANDOFF_VAR` of `system-proxy.mjs`). Node consumes
/// and deletes it (`beginAdoption`) so no descendant sees a decision that was meant for this
/// process alone; a child that is meant to get one is given it in `set`.
const SYSTEM_PROXY_HANDOFF: &str = "MIXDOG_SYSTEM_PROXY_HANDOFF";

/// The child's environment: the core's own when `inherit` (without the system-proxy handoff),
/// minus `remove`, plus `set`.
pub(crate) fn environment(spec: &EnvSpec) -> Vec<(OsString, OsString)> {
    environment_of(spec, std::env::vars_os())
}

fn environment_of(spec: &EnvSpec, own: impl IntoIterator<Item = (OsString, OsString)>) -> Vec<(OsString, OsString)> {
    let same = |a: &OsString, b: &str| {
        if cfg!(windows) {
            a.to_string_lossy().eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    };
    let mut env: Vec<(OsString, OsString)> = if spec.inherit {
        own.into_iter().filter(|(k, _)| !same(k, SYSTEM_PROXY_HANDOFF)).collect()
    } else {
        Vec::new()
    };
    env.retain(|(k, _)| !spec.remove.iter().any(|r| same(k, r)));
    for (key, value) in &spec.set {
        env.retain(|(k, _)| !same(k, key));
        env.push((key.into(), value.into()));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(key: &str, value: &str) -> (OsString, OsString) {
        (key.into(), value.into())
    }

    fn spec(inherit: bool, set: &[(&str, &str)]) -> EnvSpec {
        EnvSpec { inherit, set: set.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(), remove: Vec::new() }
    }

    #[test]
    fn a_child_does_not_inherit_the_launchers_system_proxy_decision_unless_it_is_given_one() {
        let own = || [pair("PATH", "/bin"), pair(SYSTEM_PROXY_HANDOFF, r#"{"proxy":null}"#)];
        let inherited = environment_of(&spec(true, &[]), own());
        assert_eq!(inherited, vec![pair("PATH", "/bin")]);
        let given = environment_of(&spec(true, &[(SYSTEM_PROXY_HANDOFF, r#"{"proxy":{"https":"http://p:1"}}"#)]), own());
        assert_eq!(given, vec![pair("PATH", "/bin"), pair(SYSTEM_PROXY_HANDOFF, r#"{"proxy":{"https":"http://p:1"}}"#)]);
    }
}