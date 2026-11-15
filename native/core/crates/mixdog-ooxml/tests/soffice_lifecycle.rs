#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "fixtures are read and written directly and the fake program is a process of its own")]
//! `portable-soffice-lifecycle.test.mjs` and `portable-soffice-stderr.test.mjs` against `mixdog_ooxml::soffice::run`: a run that is
//! cancelled or out of time is reported only after its process has exited (and, on Windows, the processes it started with it), a
//! failed run reports a bounded slice of stderr, and the exit of the program is told as Node tells it.
//!
//! The fake LibreOffice is this test program itself: the `fake_*` tests below do nothing unless the run's environment names a job,
//! and the test starts the program with `--exact fake_...` so it does that job (they are ignored, so a plain run skips them).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use mixdog_ooxml::soffice::run::{MAX_STDERR_CHARS, RunOptions, RunResult, run_soffice_blocking};

const JOB: &str = "MIXDOG_FAKE_SOFFICE_JOB";
const PID_FILE: &str = "MIXDOG_FAKE_SOFFICE_PID_FILE";
const CHILD_PID_FILE: &str = "MIXDOG_FAKE_SOFFICE_CHILD_PID_FILE";

fn job_of(name: &str) -> bool {
    std::env::var(JOB).is_ok_and(|job| job == name)
}

fn write_pid(variable: &str) {
    let path = std::env::var(variable).expect("the pid file");
    std::fs::write(path, std::process::id().to_string()).expect("pid file");
}

/// Writes its pid and stays until killed.
#[test]
#[ignore = "the fake LibreOffice of the lifecycle tests"]
fn fake_sleeper() {
    if !job_of("sleep") {
        return;
    }
    write_pid(PID_FILE);
    std::thread::sleep(Duration::from_secs(120));
}

/// Starts a sleeper of its own, writes its pid, and stays until killed.
#[test]
#[ignore = "the fake LibreOffice of the lifecycle tests"]
fn fake_launcher() {
    if !job_of("launch") {
        return;
    }
    let me = std::env::current_exe().expect("the test program");
    std::process::Command::new(me)
        .args(["--exact", "fake_sleeper", "--ignored", "--nocapture"])
        .env(JOB, "sleep")
        .env(PID_FILE, std::env::var(CHILD_PID_FILE).expect("the child's pid file"))
        .spawn()
        .expect("the child");
    write_pid(PID_FILE);
    std::thread::sleep(Duration::from_secs(120));
}

/// Floods stderr far past the cap and fails.
#[test]
#[ignore = "the fake LibreOffice of the lifecycle tests"]
fn fake_flood() {
    use std::io::Write;
    if !job_of("flood") {
        return;
    }
    let mut stderr = std::io::stderr();
    stderr.write_all("w".repeat(MAX_STDERR_CHARS * 4).as_bytes()).expect("flood");
    stderr.flush().expect("flush");
    std::process::exit(3);
}

/// Fails with the exit code the environment names, saying `boom` on stderr when asked to.
#[test]
#[ignore = "the fake LibreOffice of the lifecycle tests"]
fn fake_exit() {
    use std::io::Write;
    if !job_of("exit") {
        return;
    }
    if std::env::var("MIXDOG_FAKE_SOFFICE_SAY").is_ok() {
        writeln!(std::io::stderr(), "  boom  ").expect("say");
    }
    // A megabyte on stdout that nobody reads must not hold the run up.
    std::io::stdout().write_all(&vec![b'o'; 1 << 20]).expect("stdout");
    std::process::exit(std::env::var("MIXDOG_FAKE_SOFFICE_CODE").ok().and_then(|code| code.parse().ok()).unwrap_or(0));
}

fn fake(job: &str, env: &[(&str, &str)], timeout: Duration) -> (String, Vec<String>, RunOptions<'static>) {
    let program = std::env::current_exe().expect("the test program").display().to_string();
    let name = match job {
        "sleep" => "fake_sleeper",
        "launch" => "fake_launcher",
        "flood" => "fake_flood",
        _ => "fake_exit",
    };
    let args = ["--exact", name, "--ignored", "--nocapture"].map(str::to_owned).to_vec();
    let mut options = RunOptions::new(timeout, "timed out", "cancelled");
    options.env = std::iter::once((JOB, job)).chain(env.iter().copied()).map(|(name, value)| (name.to_owned(), value.to_owned())).collect();
    (program, args, options)
}

fn alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        // SAFETY: plain Win32 calls on a handle opened and closed here.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code = 0;
            let asked = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            asked != 0 && code == 259
        }
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("kill").args(["-0", &pid.to_string()]).stderr(std::process::Stdio::null()).status().is_ok_and(|status| status.success())
    }
}

fn pid_of(file: &Path) -> u32 {
    let until = Instant::now() + Duration::from_secs(20);
    while Instant::now() < until {
        if let Ok(text) = std::fs::read_to_string(file)
            && let Ok(pid) = text.trim().parse()
        {
            return pid;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("the child never started");
}

fn pid_file(dir: &tempfile::TempDir, name: &str) -> PathBuf {
    dir.path().join(name)
}

#[test]
fn a_cancelled_run_is_reported_only_after_its_process_has_exited() {
    let dir = tempfile::tempdir().expect("temp folder");
    let file = pid_file(&dir, "pid");
    let cancel = AtomicBool::new(false);
    let (program, args, options) = fake("sleep", &[(PID_FILE, file.to_str().expect("utf-8"))], Duration::from_secs(60));
    let options = options.cancelled_by(Some(&cancel));
    let result = std::thread::scope(|scope| {
        let run = scope.spawn(|| run_soffice_blocking(&program, &args, &options));
        let pid = pid_of(&file);
        cancel.store(true, Ordering::SeqCst);
        let result = run.join().expect("the run");
        assert!(!alive(pid), "the process is gone when the run is reported");
        result
    });
    assert_eq!(result, RunResult::Failed("cancelled".to_owned()));
}

#[test]
fn a_timed_out_run_is_reported_only_after_its_process_has_exited() {
    let dir = tempfile::tempdir().expect("temp folder");
    let file = pid_file(&dir, "pid");
    let (program, args, options) = fake("sleep", &[(PID_FILE, file.to_str().expect("utf-8"))], Duration::from_millis(700));
    let result = run_soffice_blocking(&program, &args, &options);
    assert_eq!(result, RunResult::Failed("timed out".to_owned()));
    assert!(!alive(pid_of(&file)));
}

#[test]
fn a_run_cancelled_before_it_starts_is_reported_cancelled() {
    let dir = tempfile::tempdir().expect("temp folder");
    let file = pid_file(&dir, "pid");
    let cancel = AtomicBool::new(true);
    let (program, args, options) = fake("sleep", &[(PID_FILE, file.to_str().expect("utf-8"))], Duration::from_secs(60));
    let result = run_soffice_blocking(&program, &args, &options.cancelled_by(Some(&cancel)));
    assert_eq!(result, RunResult::Failed("cancelled".to_owned()));
}

#[cfg(windows)]
#[test]
fn a_cancelled_run_on_windows_stops_what_the_launcher_started_with_it() {
    let dir = tempfile::tempdir().expect("temp folder");
    let (launcher_file, child_file) = (pid_file(&dir, "launcher"), pid_file(&dir, "child"));
    let cancel = AtomicBool::new(false);
    let (program, args, options) = fake(
        "launch",
        &[(PID_FILE, launcher_file.to_str().expect("utf-8")), (CHILD_PID_FILE, child_file.to_str().expect("utf-8"))],
        Duration::from_secs(60),
    );
    let options = options.cancelled_by(Some(&cancel));
    std::thread::scope(|scope| {
        let run = scope.spawn(|| run_soffice_blocking(&program, &args, &options));
        let (launcher, child) = (pid_of(&launcher_file), pid_of(&child_file));
        assert!(alive(launcher) && alive(child));
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(run.join().expect("the run"), RunResult::Failed("cancelled".to_owned()));
        assert!(!alive(launcher), "the launcher is gone");
        assert!(!alive(child), "what it started is gone too");
    });
}

#[test]
fn a_failed_run_reports_a_bounded_slice_of_what_it_wrote_to_stderr() {
    let (program, args, options) = fake("flood", &[], Duration::from_secs(60));
    let RunResult::Failed(error) = run_soffice_blocking(&program, &args, &options) else { panic!("the run failed") };
    assert!(!error.is_empty());
    assert!(error.chars().count() <= MAX_STDERR_CHARS, "error carried {} characters", error.chars().count());
    assert_eq!(error.len(), MAX_STDERR_CHARS, "the first characters are the ones kept");
}

#[test]
fn a_failed_run_says_what_the_program_wrote_trimmed_or_else_its_exit_code() {
    let (program, args, options) = fake("exit", &[("MIXDOG_FAKE_SOFFICE_CODE", "5"), ("MIXDOG_FAKE_SOFFICE_SAY", "1")], Duration::from_secs(60));
    assert_eq!(run_soffice_blocking(&program, &args, &options), RunResult::Failed("boom".to_owned()));
    let (program, args, options) = fake("exit", &[("MIXDOG_FAKE_SOFFICE_CODE", "5")], Duration::from_secs(60));
    assert_eq!(run_soffice_blocking(&program, &args, &options), RunResult::Failed("LibreOffice exited with code 5".to_owned()));
}

#[test]
fn a_run_that_succeeds_is_done_even_when_nobody_reads_its_output() {
    let (program, args, options) = fake("exit", &[("MIXDOG_FAKE_SOFFICE_CODE", "0")], Duration::from_secs(60));
    assert_eq!(run_soffice_blocking(&program, &args, &options), RunResult::Done);
}

#[test]
fn a_program_that_cannot_start_is_reported_as_node_reports_it() {
    let options = RunOptions::new(Duration::from_secs(5), "timed out", "cancelled");
    let missing = std::env::temp_dir().join("mixdog-no-such-soffice").display().to_string();
    let RunResult::Failed(error) = run_soffice_blocking(&missing, &[], &options) else { panic!("the run failed") };
    assert!(error.starts_with("spawn ") && error.ends_with(" ENOENT"), "{error}");
}
