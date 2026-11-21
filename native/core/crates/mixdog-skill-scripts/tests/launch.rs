//! The launchers `mixdog_mcp::launcher` writes, run through the shells that use them (sh on POSIX; cmd.exe and
//! Windows PowerShell 5.1 and 7 on Windows) with a test build of `skill-run`. A shell that is not installed is
//! skipped, and so is the transitional user-script variant when `MIXDOG_TEST_SKILL_INTERPRETER` names no
//! interpreter.
#![cfg(feature = "test-support")]
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the test starts real launchers: process spawning and temp-file output are the subject"
)]

use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;

use mixdog_fsio::Unlaned;
use mixdog_mcp::launcher;
use mixdog_skill_scripts::Outcome;
use mixdog_skill_scripts::validate_skill::run_validate_skill;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Shell {
    Sh,
    Cmd,
    WindowsPowerShell,
    PowerShell7,
}

impl Shell {
    /// Whether arguments may carry a double quote: a `.cmd` launcher cannot pass one on.
    fn passes_quotes(self) -> bool {
        self != Self::Cmd
    }
}

/// The shells this machine has.
fn shells() -> Vec<Shell> {
    let mut found = Vec::new();
    if cfg!(unix) {
        found.push(Shell::Sh);
    }
    if cfg!(windows) {
        found.push(Shell::Cmd);
        for (shell, program) in [(Shell::WindowsPowerShell, "powershell.exe"), (Shell::PowerShell7, "pwsh.exe")] {
            let present = Command::new(program)
                .args(["-NoProfile", "-Command", "exit 0"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success());
            if present {
                found.push(shell);
            }
        }
    }
    found
}

fn probe() -> String {
    mixdog_testkit::bin_exe!("skill-run-probe")
}

fn repo_file(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..").join(relative)
}

fn validate_script() -> PathBuf {
    repo_file("src/defaults/skills/skill-creator/scripts/validate-skill.mjs")
}

/// The interpreter and entry of the user-script variant, when the test environment has them.
fn interpreter() -> Option<(String, PathBuf)> {
    let program = std::env::var("MIXDOG_TEST_SKILL_INTERPRETER").ok().filter(|program| !program.is_empty())?;
    let entry = repo_file("src/skill-script-entry.mjs");
    entry.is_file().then_some((program, entry))
}

fn runtime() -> launcher::SkillRuntime {
    launcher::SkillRuntime::new(probe(), "skill-run", false)
}

/// Writes the launchers of [`runtime`] under `dir` and returns the one `shell` runs.
fn write_launchers(dir: &Path, shell: Shell) -> PathBuf {
    for (name, content) in launcher::launcher_files(&runtime()) {
        let path = dir.join(name);
        mixdog_testkit::write(&path, content);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).expect("launcher is executable");
        }
    }
    dir.join(if shell == Shell::Cmd { "mixdog-skill-node.cmd" } else { "mixdog-skill-node" })
}

fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(windows)]
fn command_for(shell: Shell, launcher_file: &Path, args: &[String]) -> Command {
    use std::os::windows::process::CommandExt;
    match shell {
        Shell::Cmd => {
            let quoted: Vec<String> = args.iter().map(|arg| format!("\"{arg}\"")).collect();
            let mut command = Command::new("cmd.exe");
            command.raw_arg(format!("/d /s /c \"\"{}\" {}\"", launcher_file.display(), quoted.join(" ")));
            command
        }
        Shell::WindowsPowerShell | Shell::PowerShell7 => {
            let program = if shell == Shell::PowerShell7 { "pwsh.exe" } else { "powershell.exe" };
            let words: Vec<String> = args.iter().map(|arg| ps_quote(arg)).collect();
            let text = format!(
                "[Console]::OutputEncoding = [Text.Encoding]::UTF8; {}; {} {}",
                launcher::render_powershell_function(&runtime()),
                launcher::SKILL_LAUNCHER_COMMAND,
                words.join(" ")
            );
            let mut command = Command::new(program);
            command.args(["-NoProfile", "-NonInteractive", "-Command", &text]);
            command
        }
        Shell::Sh => unreachable!("sh is a POSIX shell"),
    }
}

#[cfg(not(windows))]
fn command_for(_shell: Shell, launcher_file: &Path, args: &[String]) -> Command {
    let mut command = Command::new("sh");
    command.arg(launcher_file).args(args);
    command
}

/// What a launcher run printed: one file receives both streams, so their order is the order they were written in.
struct Run {
    merged: String,
    stdout: String,
    stderr: String,
    code: i32,
}

fn run_launcher(shell: Shell, args: &[String], envs: &[(&str, String)]) -> Run {
    let dir = tempfile::tempdir().expect("temp dir");
    let launcher_file = write_launchers(dir.path(), shell);
    let (out_path, err_path, merged_path) = (dir.path().join("out.txt"), dir.path().join("err.txt"), dir.path().join("merged.txt"));
    let run = |stdout: &Path, stderr: Option<&Path>| {
        let out = std::fs::File::create(stdout).expect("output file");
        let err = match stderr {
            Some(path) => std::fs::File::create(path).expect("error file"),
            None => out.try_clone().expect("shared handle"),
        };
        let mut command = command_for(shell, &launcher_file, args);
        command.stdin(Stdio::null()).stdout(out).stderr(err);
        for (name, value) in envs {
            command.env(name, value);
        }
        command.status().expect("the launcher starts").code().expect("an exit code")
    };
    let code = run(&out_path, Some(&err_path));
    let merged_code = run(&merged_path, None);
    assert_eq!(code, merged_code, "{shell:?}: the exit code is the same on both runs");
    let text = |path: &Path| String::from_utf8_lossy(&mixdog_testkit::read(path)).into_owned();
    Run { merged: text(&merged_path), stdout: text(&out_path), stderr: text(&err_path), code }
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

/// A tree with one valid skill at `dir/<name>`.
fn write_skill(dir: &Path, name: &str) -> PathBuf {
    let skill = dir.join(name);
    mixdog_testkit::create_dir_all(&skill);
    mixdog_testkit::write(skill.join("SKILL.md"), "---\nname: probe\ndescription: Use when probing.\n---\n\nbody\n");
    skill
}

fn same_output(shell: Shell, run: &Run, expected: &Outcome) {
    assert_eq!(run.stdout.replace("\r\n", "\n"), expected.stdout, "{shell:?}: stdout");
    assert_eq!(run.stderr.replace("\r\n", "\n"), expected.stderr, "{shell:?}: stderr");
    assert_eq!(run.code, expected.code, "{shell:?}: exit code");
}

#[test]
fn no_arguments_print_the_usage_and_exit_with_two() {
    for shell in shells() {
        let run = run_launcher(shell, &[], &[]);
        assert_eq!((run.stdout.as_str(), run.code), ("", 2), "{shell:?}");
        assert_eq!(run.stderr.trim_end(), "Usage: <skill launcher> <script.mjs> [args...]", "{shell:?}");
    }
}

#[test]
fn an_empty_argument_is_no_script() {
    for shell in shells() {
        let run = run_launcher(shell, &strings(&[""]), &[]);
        assert_eq!(run.code, 2, "{shell:?}: an empty target is no target");
    }
}

#[test]
fn spaces_and_non_ascii_reach_the_script_unchanged() {
    for shell in shells() {
        let root = tempfile::tempdir().expect("temp dir");
        let skill = write_skill(root.path(), "스킬 폴더 caf\u{e9}");
        let args = vec![validate_script().display().to_string(), skill.display().to_string()];
        let run = run_launcher(shell, &args, &[]);
        same_output(shell, &run, &run_validate_skill(&Unlaned, &[skill.display().to_string()]));
    }
}

#[test]
fn quotes_in_an_argument_reach_the_script_unchanged() {
    for shell in shells().into_iter().filter(|shell| shell.passes_quotes()) {
        let argument = "no \"such\" skill dir".to_owned();
        let args = vec![validate_script().display().to_string(), argument.clone()];
        let run = run_launcher(shell, &args, &[]);
        same_output(shell, &run, &run_validate_skill(&Unlaned, &[argument]));
    }
}

#[test]
fn a_missing_script_is_not_a_shipped_one_and_fails_with_its_path() {
    for shell in shells() {
        let root = tempfile::tempdir().expect("temp dir");
        let script = root.path().join("missing.mjs").display().to_string();
        let run = run_launcher(shell, &[script.clone()], &[]);
        assert_eq!(run.code, 1, "{shell:?}");
        assert!(run.stderr.contains("missing.mjs"), "{shell:?}: {}", run.stderr);
    }
}

#[test]
fn the_carrier_is_read_when_it_has_the_tag_and_no_argument_was_given() {
    let root = tempfile::tempdir().expect("temp dir");
    let skill = write_skill(root.path(), "carried");
    let carried = mixdog_skill_scripts::argv::encode_skill_argv(&[validate_script().display().to_string(), skill.display().to_string()]);
    for shell in shells().into_iter().filter(|shell| *shell == Shell::Sh || *shell == Shell::Cmd) {
        let run = run_launcher(shell, &[], &[("MIXDOG_SKILL_ARGV", carried.clone())]);
        same_output(shell, &run, &run_validate_skill(&Unlaned, &[skill.display().to_string()]));
        let given = run_launcher(shell, &strings(&[]), &[("MIXDOG_SKILL_ARGV", "other".to_owned())]);
        assert_eq!(given.code, 2, "{shell:?}: a value without the tag is ignored");
    }
}

fn node_script(dir: &Path, name: &str, body: &str) -> String {
    let path = dir.join(name);
    mixdog_testkit::write(&path, body);
    path.display().to_string()
}

fn with_interpreter() -> Option<Vec<(&'static str, String)>> {
    let Some((program, entry)) = interpreter() else {
        eprintln!("skipped: MIXDOG_TEST_SKILL_INTERPRETER names no interpreter");
        return None;
    };
    Some(vec![("MIXDOG_TEST_SKILL_INTERPRETER", program), ("MIXDOG_TEST_SKILL_ENTRY", entry.display().to_string())])
}

#[test]
fn a_user_script_runs_on_the_interpreter_with_its_arguments_and_exit_code() {
    let Some(envs) = with_interpreter() else { return };
    for shell in shells() {
        let root = tempfile::tempdir().expect("temp dir");
        let script =
            node_script(root.path(), "스크립트 probe.mjs", "console.log(JSON.stringify(process.argv.slice(2)));process.exitCode=Number(process.argv[2]);");
        for code in [0, 1, 2, 42] {
            let mut args = vec![script.clone(), code.to_string(), "a b".to_owned(), "caf\u{e9}".to_owned()];
            if shell.passes_quotes() {
                args.push("he said \"hi\"".to_owned());
            }
            let run = run_launcher(shell, &args, &envs);
            assert_eq!(run.code, code, "{shell:?}");
            let printed: Vec<String> = serde_json::from_str(run.stdout.trim()).expect("the script printed its arguments");
            assert_eq!(printed, args[1..], "{shell:?}");
        }
        if shell != Shell::Cmd {
            let empty = run_launcher(shell, &[script.clone(), "0".to_owned(), String::new()], &envs);
            let printed: Vec<String> = serde_json::from_str(empty.stdout.trim()).expect("arguments");
            assert_eq!(printed, ["0", ""], "{shell:?}: an empty argument is kept");
        }
    }
}

#[test]
fn stdout_and_stderr_of_a_user_script_keep_the_order_they_were_written_in() {
    let Some(envs) = with_interpreter() else { return };
    for shell in shells() {
        let root = tempfile::tempdir().expect("temp dir");
        let script = node_script(
            root.path(),
            "order.mjs",
            "import { writeSync } from 'node:fs';\nfor (let i = 0; i < 6; i += 1) writeSync(i % 2 === 0 ? 1 : 2, `${i % 2 === 0 ? 'out' : 'err'}${i}\\n`);\n",
        );
        let run = run_launcher(shell, &[script], &envs);
        let lines: Vec<&str> = run.merged.lines().collect();
        assert_eq!(lines, ["out0", "err1", "out2", "err3", "out4", "err5"], "{shell:?}");
    }
}
