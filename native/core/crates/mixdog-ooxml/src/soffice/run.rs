//! One run of the LibreOffice program: started without a window, bounded by a time and by the caller's cancellation, its stderr
//! kept up to a cap, and the whole process tree stopped when the run is cancelled or out of time.
//!
//! soffice.com hands the work to a soffice.bin child, which a plain kill of the launcher leaves running (and holding the files it
//! was given). On Windows the launcher is therefore started suspended, put in a job object that kills what it holds, and only then
//! let run, so nothing it starts is outside the job; cancelling ends the job. Elsewhere the launcher is killed directly.

use std::future::Future;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use mixdog_js::js_trim;
use tokio::io::{AsyncRead, AsyncReadExt};

/// A converter can warn on every page of a long document; what it writes to stderr is kept up to this many characters, which is
/// plenty to say why it failed.
pub const MAX_STDERR_CHARS: usize = 64 * 1024;

/// How long a killed conversion is waited for before it is reported anyway.
pub const KILL_GRACE: Duration = Duration::from_secs(10);

/// How often a wait looks at the cancellation flag and the clock.
const POLL: Duration = Duration::from_millis(25);

/// What a run came to: `{ ok: true }` or `{ ok: false, error }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunResult {
    Done,
    Failed(String),
}

impl RunResult {
    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Done)
    }
}

/// How one run is bounded.
#[derive(Debug, Clone)]
pub struct RunOptions<'a> {
    /// Set by the caller to cancel the run.
    pub cancel: Option<&'a AtomicBool>,
    pub timeout: Duration,
    /// What a run that ran out of time is reported as.
    pub timeout_message: String,
    /// What a cancelled run is reported as.
    pub cancel_message: String,
    /// Variables added to the environment of the program.
    pub env: Vec<(String, String)>,
    /// How long a killed run is waited for; [`KILL_GRACE`].
    pub kill_grace: Duration,
}

impl RunOptions<'_> {
    pub fn new(timeout: Duration, timeout_message: impl Into<String>, cancel_message: impl Into<String>) -> Self {
        Self { cancel: None, timeout, timeout_message: timeout_message.into(), cancel_message: cancel_message.into(), env: Vec::new(), kill_grace: KILL_GRACE }
    }

    /// The same bounds, cancelled by `cancel`.
    pub fn cancelled_by<'b>(self, cancel: Option<&'b AtomicBool>) -> RunOptions<'b> {
        RunOptions {
            cancel,
            timeout: self.timeout,
            timeout_message: self.timeout_message,
            cancel_message: self.cancel_message,
            env: self.env,
            kill_grace: self.kill_grace,
        }
    }
}

fn cancelled(cancel: Option<&AtomicBool>) -> bool {
    cancel.is_some_and(|flag| flag.load(Ordering::SeqCst))
}

/// Runs `future` to its end on a runtime of its own, on a thread of its own (a caller that is already inside a runtime's context
/// cannot block on a second one).
pub(crate) fn block_on<T: Send, F: Future<Output = T> + Send>(future: F) -> Result<T, String> {
    std::thread::scope(|scope| {
        let worker = scope.spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map(|runtime| runtime.block_on(future))
                .map_err(|error| format!("The LibreOffice runtime did not start: {error}"))
        });
        match worker.join() {
            Ok(outcome) => outcome,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    })
}

/// What Node's failed `spawn` says: `spawn <program> <CODE>`.
fn spawn_message(program: &str, error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => format!("spawn {program} ENOENT"),
        std::io::ErrorKind::PermissionDenied => format!("spawn {program} EACCES"),
        _ => format!("spawn {program} failed: {error}"),
    }
}

/// Everything `stream` yields; the first characters are kept and the rest is read and dropped so the process is never blocked on
/// a full pipe.
async fn capture_text<R: AsyncRead + Unpin>(mut stream: R) -> String {
    // A UTF-16 unit is at most three bytes of UTF-8 (a pair of units, four).
    let keep = MAX_STDERR_CHARS * 4;
    let mut kept = Vec::new();
    let mut chunk = vec![0_u8; 16 * 1024];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let room = keep.saturating_sub(kept.len());
                kept.extend_from_slice(&chunk[..read.min(room)]);
            }
        }
    }
    let text = String::from_utf8_lossy(&kept);
    let mut units = 0;
    let mut end = text.len();
    for (at, character) in text.char_indices() {
        units += character.len_utf16();
        if units > MAX_STDERR_CHARS {
            end = at;
            break;
        }
    }
    text[..end].to_owned()
}

async fn drain<R: AsyncRead + Unpin>(mut stream: R) {
    let mut chunk = vec![0_u8; 16 * 1024];
    while matches!(stream.read(&mut chunk).await, Ok(read) if read > 0) {}
}

#[cfg(windows)]
mod job {
    use std::ffi::c_void;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
    };

    #[link(name = "ntdll")]
    unsafe extern "system" {
        /// Resumes every thread of a process created suspended.
        fn NtResumeProcess(process: HANDLE) -> i32;
    }

    /// A job object that ends everything in it when it is terminated or closed.
    pub(super) struct Job(HANDLE);

    // SAFETY: a job handle is a kernel object identifier; the calls made on it are thread-safe.
    unsafe impl Send for Job {}

    /// Puts `child` (created suspended) in a job and lets it run. A job that cannot be made or joined is answered by `None`; the
    /// child runs all the same, and the caller kills the launcher alone.
    pub(super) fn start(child: &tokio::process::Child) -> Result<Option<Job>, String> {
        let Some(process) = child.raw_handle() else { return Ok(None) };
        let process = process as HANDLE;
        // SAFETY: plain Win32 calls on a handle created here and on the live child's handle.
        let job = unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                None
            } else {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&info).cast::<c_void>(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if set == 0 || AssignProcessToJobObject(job, process) == 0 {
                    CloseHandle(job);
                    None
                } else {
                    Some(Job(job))
                }
            }
        };
        // SAFETY: the child's process handle is open for as long as `child` is.
        let status = unsafe { NtResumeProcess(process) };
        if status < 0 {
            return Err(format!("the LibreOffice process could not be resumed (NTSTATUS 0x{status:08x})"));
        }
        Ok(job)
    }

    impl Job {
        pub(super) fn terminate(&self) {
            // SAFETY: the job handle is open until the job is dropped.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closed once; kill-on-close ends anything the job still holds.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// The process tree of a run, as far as the system lets it be held.
struct Tree {
    #[cfg(windows)]
    job: Option<job::Job>,
}

impl Tree {
    /// Stops the tree: the job on Windows, else the launcher alone. A launcher that has already exited is not a failure.
    fn stop(&self, child: &mut tokio::process::Child) {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
            return;
        }
        drop(child.start_kill());
    }
}

/// `runSoffice(program, args, { signal, timeoutMs, timeoutMessage, cancelMessage, env })`: one run, reported as [`RunResult`] once
/// the process has closed, so the caller never removes files it still holds. A run that is cancelled or out of time is stopped
/// and reported after at most `kill_grace`.
pub async fn run_soffice(program: &str, args: &[String], options: &RunOptions<'_>) -> RunResult {
    let mut command = tokio::process::Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for (name, value) in &options.env {
        command.env(name, value);
    }
    #[cfg(windows)]
    // CREATE_NO_WINDOW (`windowsHide`) and CREATE_SUSPENDED (so the job holds the launcher before it runs).
    command.creation_flags(0x0800_0000 | 0x0000_0004);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return RunResult::Failed(spawn_message(program, &error)),
    };
    #[cfg(windows)]
    let tree = match job::start(&child) {
        Ok(job) => Tree { job },
        Err(reason) => {
            drop(child.start_kill());
            return RunResult::Failed(reason);
        }
    };
    #[cfg(not(windows))]
    let tree = Tree {};
    let discarded = child.stdout.take().map(|stream| tokio::spawn(drain(stream)));
    let captured = child.stderr.take().map(|stream| tokio::spawn(capture_text(stream)));
    let started = Instant::now();
    let mut stopped: Option<(RunResult, Instant)> = None;
    let mut status = None;
    loop {
        if stopped.is_none() {
            let reason = if cancelled(options.cancel) {
                Some(&options.cancel_message)
            } else if started.elapsed() >= options.timeout {
                Some(&options.timeout_message)
            } else {
                None
            };
            if let Some(message) = reason {
                stopped = Some((RunResult::Failed(message.clone()), Instant::now() + options.kill_grace));
                tree.stop(&mut child);
            }
        }
        if status.is_none() {
            if let Ok(waited) = mixdog_rt::time::timeout(POLL, child.wait()).await {
                status = Some(waited);
            }
        } else {
            mixdog_rt::time::sleep(POLL).await;
        }
        let streams_closed = discarded.as_ref().is_none_or(|task| task.is_finished()) && captured.as_ref().is_none_or(|task| task.is_finished());
        if status.is_some() && streams_closed {
            break;
        }
        if stopped.as_ref().is_some_and(|(_, until)| Instant::now() >= *until) {
            break;
        }
    }
    if let Some((result, _)) = stopped {
        for task in discarded.iter() {
            task.abort();
        }
        for task in captured.iter() {
            task.abort();
        }
        return result;
    }
    let stderr = match captured {
        Some(task) => task.await.unwrap_or_default(),
        None => String::new(),
    };
    match status {
        Some(Ok(exit)) if exit.success() => RunResult::Done,
        Some(Ok(exit)) => {
            let reported = js_trim(&stderr);
            RunResult::Failed(if reported.is_empty() {
                format!("LibreOffice exited with code {}", exit.code().map_or_else(|| "null".to_owned(), |code| code.to_string()))
            } else {
                reported.to_owned()
            })
        }
        Some(Err(error)) => RunResult::Failed(error.to_string()),
        None => RunResult::Failed(options.timeout_message.clone()),
    }
}

/// [`run_soffice`] on a runtime of its own: the run the driver makes from a thread of a job.
pub fn run_soffice_blocking(program: &str, args: &[String], options: &RunOptions<'_>) -> RunResult {
    match block_on(run_soffice(program, args, options)) {
        Ok(result) => result,
        Err(reason) => RunResult::Failed(reason),
    }
}

/// Whether `program` answers `--version` with success. A detection probe must always answer: soffice.exe is a GUI launcher that can
/// sit forever without exiting, which deadlocked detection before the rendering call was ever reached, so the probe is bounded and
/// the child killed on expiry.
pub async fn command_exists(program: &str, probe_timeout: Duration) -> bool {
    let mut command = tokio::process::Command::new(program);
    command.arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let Ok(mut child) = command.spawn() else { return false };
    match mixdog_rt::time::timeout(probe_timeout, child.wait()).await {
        Ok(Ok(status)) => status.success(),
        Ok(Err(_)) => false,
        Err(_) => {
            drop(child.kill().await);
            false
        }
    }
}

/// The standard output of `program args` when it succeeds within `limit`, else nothing (`execFile` answering `''` on any error).
pub async fn command_output(program: &str, args: &[&str], limit: Duration) -> String {
    let mut command = tokio::process::Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let Ok(child) = command.spawn() else { return String::new() };
    match mixdog_rt::time::timeout(limit, child.wait_with_output()).await {
        Ok(Ok(output)) if output.status.success() => String::from_utf8_lossy(&output.stdout).into_owned(),
        _ => String::new(),
    }
}
