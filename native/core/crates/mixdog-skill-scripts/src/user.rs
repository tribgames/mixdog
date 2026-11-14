//! What runs a skill script that is not one of the shipped, natively run ones.

use std::path::Path;
use std::path::PathBuf;

use crate::argv::SKILL_ARGV_ENV;
use crate::argv::encode_skill_argv;

/// The runtime a user's skill script is handed to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UserScriptRuntime {
    /// No interpreter is installed: a script that is not shipped fails with `reason` and exit code 1.
    Unavailable { reason: String },
    /// The bundled interpreter runs `entry` (`src/skill-script-entry.mjs`) on the script, exactly as the
    /// launcher did before `skill-run` existed. Removed with `nr-exthost-jsrt-skill-scripts`.
    Interpreter { program: PathBuf, entry: PathBuf, electron: bool },
}

impl UserScriptRuntime {
    /// The built-in skills root of the install this runtime belongs to (`<package root>/src/defaults/skills`),
    /// when it has one.
    pub(crate) fn skills_root(&self) -> Option<PathBuf> {
        match self {
            Self::Interpreter { entry, .. } => Some(entry.parent()?.join("defaults").join("skills")),
            Self::Unavailable { .. } => None,
        }
    }

    /// Runs `script` with `args` and returns the exit code. `carried` is whether the arguments came in
    /// `MIXDOG_SKILL_ARGV`; the entry is then handed them the same way.
    pub(crate) fn run(&self, script: &Path, args: &[String], carried: bool) -> i32 {
        match self {
            Self::Unavailable { reason } => {
                eprintln!("{reason}: cannot run {}", script.display());
                1
            }
            Self::Interpreter { program, entry, electron } => run_interpreter(program, entry, *electron, script, args, carried),
        }
    }
}

#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the skill-run process starts the interpreter it waits on with inherited stdio; it has no runtime or lane")]
fn run_interpreter(program: &Path, entry: &Path, electron: bool, script: &Path, args: &[String], carried: bool) -> i32 {
    let mut command = std::process::Command::new(program);
    command.arg(entry);
    let script = script.to_string_lossy().into_owned();
    if carried {
        let mut all = vec![script];
        all.extend_from_slice(args);
        command.env(SKILL_ARGV_ENV, encode_skill_argv(&all));
    } else {
        command.env_remove(SKILL_ARGV_ENV).arg(script).args(args);
    }
    if electron {
        command.env("ELECTRON_RUN_AS_NODE", "1");
    } else {
        command.env_remove("ELECTRON_RUN_AS_NODE");
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("cannot start {}: {error}", program.display());
            return 1;
        }
    };
    #[cfg(unix)]
    let forwarding = forward_signals(child.id());
    let status = child.wait();
    #[cfg(unix)]
    if let Some((handle, thread)) = forwarding {
        handle.close();
        let _ = thread.join();
    }
    match status {
        Ok(status) => exit_code(status),
        Err(error) => {
            eprintln!("waiting for {}: {error}", program.display());
            1
        }
    }
}

/// The code a shell reports: the exit code, or 128 plus the signal that ended the process.
fn exit_code(status: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    status.code().unwrap_or(1)
}

/// SIGINT and SIGTERM sent to this process reach the interpreter too (on Windows the console control event
/// reaches every process sharing the console).
#[cfg(unix)]
fn forward_signals(pid: u32) -> Option<(signal_hook::iterator::Handle, std::thread::JoinHandle<()>)> {
    use signal_hook::consts::SIGINT;
    use signal_hook::consts::SIGTERM;
    let pid = libc::pid_t::try_from(pid).ok()?;
    let mut signals = signal_hook::iterator::Signals::new([SIGINT, SIGTERM]).ok()?;
    let handle = signals.handle();
    let thread = std::thread::spawn(move || {
        for signal in signals.forever() {
            // SAFETY: `kill` takes plain integers; a pid that has exited is an ESRCH error, ignored.
            unsafe { libc::kill(pid, signal) };
        }
    });
    Some((handle, thread))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_skills_root_is_beside_the_entry() {
        let runtime = UserScriptRuntime::Interpreter { program: "node".into(), entry: PathBuf::from("/p/src/skill-script-entry.mjs"), electron: false };
        assert_eq!(runtime.skills_root(), Some(PathBuf::from("/p/src").join("defaults").join("skills")));
        assert_eq!(UserScriptRuntime::Unavailable { reason: "x".into() }.skills_root(), None);
    }

    #[test]
    fn an_unavailable_runtime_fails_with_exit_code_one() {
        let runtime = UserScriptRuntime::Unavailable { reason: "no runtime".into() };
        assert_eq!(runtime.run(Path::new("a.mjs"), &[], false), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_signal_death_is_128_plus_the_signal() {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(exit_code(std::process::ExitStatus::from_raw(15)), 143);
        assert_eq!(exit_code(std::process::ExitStatus::from_raw(42 << 8)), 42);
    }
}
