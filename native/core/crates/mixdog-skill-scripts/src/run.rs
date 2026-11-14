//! `mixdogd skill-run`: the program the `mixdog-skill-node` launchers start, the replacement of
//! `src/skill-script-entry.mjs`.

use std::ffi::OsString;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::ExitCode;

use mixdog_fsio::Unlaned;
use mixdog_js::nodepath;

use crate::Outcome;
use crate::argv::SKILL_ARGV_ENV;
use crate::argv::USAGE;
use crate::argv::decode_skill_argv;
use crate::argv::entry_arguments;
use crate::inventory::utc_today;
use crate::shipped::run_native;
use crate::shipped::shipped_script;
use crate::user::UserScriptRuntime;

/// Runs the skill script `args` names (what follows `skill-run` on the command line) and returns its exit
/// code. A shipped script with a native version runs in this process; any other goes to `user_runtime`.
pub fn skill_run(args: Vec<OsString>, user_runtime: UserScriptRuntime) -> ExitCode {
    let command_line: Vec<String> = args.iter().map(|arg| arg.to_string_lossy().into_owned()).collect();
    let carried_value = std::env::var_os(SKILL_ARGV_ENV).map(|value| value.to_string_lossy().into_owned());
    let carried = command_line.is_empty() && decode_skill_argv(carried_value.as_deref()).is_some();
    let entry = entry_arguments(&command_line, carried_value.as_deref());
    let Some(target) = entry.target.filter(|target| !target.is_empty()) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let script = script_path(&target);
    let skills_root = user_runtime.skills_root().unwrap_or_else(|| PathBuf::from("defaults").join("skills"));
    let code = match shipped_script(&Unlaned, &script, &skills_root).and_then(|shipped| shipped.native) {
        Some(native) => emit(&run_native(&Unlaned, native, &entry.args, &utc_today())),
        None => user_runtime.run(&script, &entry.args, carried),
    };
    exit_code(code)
}

/// The script against the working directory, then through its real path; a missing file keeps the resolved
/// path, which the failure then names.
fn script_path(target: &str) -> PathBuf {
    let resolved = PathBuf::from(nodepath::resolve_host(&[target]));
    match mixdog_fsio::canonicalize(&Unlaned, &resolved) {
        Ok(real) => without_verbatim_prefix(&real),
        Err(_) => resolved,
    }
}

/// Windows' `canonicalize` answers `\\?\C:\x`; the path a script sees is `C:\x`.
fn without_verbatim_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// Writes what the script printed, unbuffered, and returns its exit code. Stderr goes first: every native
/// script writes all of its stderr lines before its stdout line (validate-skill's warnings and errors before
/// "Valid skill", inventory prints one stream per run), so this is the order of the calls.
fn emit(outcome: &Outcome) -> i32 {
    let (mut stdout, mut stderr) = (std::io::stdout().lock(), std::io::stderr().lock());
    // A closed pipe ends the output, as it does a Node script's console.
    let _ = stderr.write_all(outcome.stderr.as_bytes());
    let _ = stderr.flush();
    let _ = stdout.write_all(outcome.stdout.as_bytes());
    let _ = stdout.flush();
    outcome.code
}

/// The process exit code: its low byte, never 0 for a failure.
fn exit_code(code: i32) -> ExitCode {
    match u8::try_from(code & 0xff) {
        Ok(0) if code != 0 => ExitCode::from(1),
        Ok(byte) => ExitCode::from(byte),
        Err(_) => ExitCode::from(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_exit_code_keeps_its_low_byte_and_a_failure_is_never_zero() {
        assert_eq!(exit_code(42), ExitCode::from(42));
        assert_eq!(exit_code(256), ExitCode::from(1));
        assert_eq!(exit_code(-1), ExitCode::from(255));
        assert_eq!(exit_code(0), ExitCode::from(0));
    }

    #[test]
    fn a_verbatim_prefix_is_dropped() {
        assert_eq!(without_verbatim_prefix(Path::new(r"\\?\C:\a\b.mjs")), PathBuf::from(r"C:\a\b.mjs"));
        assert_eq!(without_verbatim_prefix(Path::new(r"\\?\UNC\srv\share\b.mjs")), PathBuf::from(r"\\srv\share\b.mjs"));
        assert_eq!(without_verbatim_prefix(Path::new("/a/b.mjs")), PathBuf::from("/a/b.mjs"));
    }

    #[test]
    fn a_missing_script_keeps_its_resolved_path() {
        let path = script_path("no-such-dir-xyz/missing.mjs");
        assert!(path.is_absolute() && path.ends_with("missing.mjs"));
    }
}
