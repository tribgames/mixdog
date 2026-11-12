//! The effort judge's model runs in a host process of its own (`mixdogd effort-judge-host`), so a
//! native fault in ONNX Runtime ends that process and not the core: the judge's thread talks to it
//! over its stdin and stdout, one request and one reply at a time, and the host's death shows as the
//! end of its stdout the moment it happens (no exit notification is waited for). Killing the host is
//! also what ends a stuck inference, and dropping the client unloads the model: the 146 MB live in
//! the host only.
//!
//! Every reply line carries [`TAG`] and the reply follows it; other output on stdout (a native
//! library printing, a test harness's banner, which may stand in front of the tag on its line) is
//! not the protocol and is skipped.

use std::ffi::OsString;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use mixdog_exthost::Containment;
use mixdog_agent::step_effort::{StepCall, StepInput};
use mixdog_rt::{JudgeThread, TaskClass};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

use crate::effort_judge::error::JudgeError;
use crate::effort_judge::input::TurnInput;
use crate::effort_judge::judge::Resident;
use crate::effort_judge::model::{JudgeModel, ModelConfig, OrtRuntime};
use crate::effort_judge::worker::{Alarm, Stopper};

/// The subcommand of `mixdogd` that serves as the host.
pub const HOST_COMMAND: &str = "effort-judge-host";

/// Starts every reply line of the host.
const TAG: &str = "MIXDOG-EFFORT-JUDGE ";

#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Request {
    Turn { request: String, prev: String, prev_request: String },
    Step { request: String, step: u32, plan: String, calls: Vec<[String; 3]> },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Reply {
    Ready,
    LoadFailed { kind: String, message: String },
    Probs { probs: Vec<f64> },
    Failed { kind: String, message: String },
}

fn failure(error: &JudgeError) -> (String, String) {
    let (kind, message) = match error {
        JudgeError::Load(message) => ("load", message.clone()),
        JudgeError::NotInstalled(message) => ("notInstalled", message.clone()),
        JudgeError::Unsupported => ("unsupported", String::new()),
        JudgeError::StepsUnsupported => ("stepsUnsupported", String::new()),
        JudgeError::Run(message) => ("run", message.clone()),
        other => ("run", other.to_string()),
    };
    (kind.to_owned(), message)
}

fn send(output: &mut impl Write, reply: &Reply) -> bool {
    let line = serde_json::to_string(reply).expect("a reply serializes");
    writeln!(output, "{TAG}{line}").and_then(|()| output.flush()).is_ok()
}

/// The host process: loads the model with `load`, says so, then answers one request line at a time
/// until its input ends. Answers the process's exit status.
pub(crate) fn serve_resident(
    load: impl FnOnce() -> Result<Arc<dyn Resident>, JudgeError>,
    input: impl BufRead,
    mut output: impl Write,
) -> i32 {
    let model = match load() {
        Ok(model) => model,
        Err(error) => {
            let (kind, message) = failure(&error);
            send(&mut output, &Reply::LoadFailed { kind, message });
            return 1;
        }
    };
    if !send(&mut output, &Reply::Ready) {
        return 1;
    }
    for line in input.lines() {
        let Ok(line) = line else { return 1 };
        let Ok(request) = serde_json::from_str::<Request>(&line) else { return 1 };
        let outcome = match request {
            Request::Turn { request, prev, prev_request } => model.turn_probs(&TurnInput { request, prev, prev_request }),
            Request::Step { request, step, plan, calls } => {
                let calls = calls.into_iter().map(|[name, args, result]| StepCall { name, args, result }).collect();
                model.probs(&StepInput { request, step, plan, calls })
            }
        };
        let reply = match outcome {
            Ok(probs) => Reply::Probs { probs },
            Err(error) => {
                let (kind, message) = failure(&error);
                Reply::Failed { kind, message }
            }
        };
        if !send(&mut output, &reply) {
            return 1;
        }
    }
    0
}

/// The core's process id, handed to the host so it can watch for the core's exit.
const PARENT_ENV: &str = "MIXDOG_EFFORT_JUDGE_PARENT";

/// How long a host may take to say it is ready (the model's load included), on the judge's clock.
/// Node's load has no bound; a host that hangs here would hold the judge's gate and its thread for
/// ever, so it is killed and the next judgment starts a new one.
pub(crate) const START_LIMIT: Duration = Duration::from_secs(60);

/// The host's end of "the host ends when the core ends". Windows and Linux enforce it from the
/// core's side when the host is started (a kill-on-close job object; the parent-death signal); macOS
/// has neither, so the host watches its parent on a thread of its own, which does not wait on the
/// inference thread and ends the process with no unwinding the moment the parent exits.
pub fn end_with_parent() {
    #[cfg(target_os = "macos")]
    {
        let Some(parent) = std::env::var(PARENT_ENV).ok().and_then(|pid| pid.parse::<libc::pid_t>().ok()) else { return };
        drop(std::thread::Builder::new().name("effort-judge-parent-watch".into()).spawn(move || {
            // SAFETY: kqueue and kevent on a descriptor and structures owned by this thread; `_exit`
            // runs no destructor, which a load blocked in the runtime could never finish.
            unsafe {
                let queue = libc::kqueue();
                if queue < 0 {
                    return;
                }
                let watch = libc::kevent {
                    ident: parent as usize,
                    filter: libc::EVFILT_PROC,
                    flags: libc::EV_ADD | libc::EV_ONESHOT,
                    fflags: libc::NOTE_EXIT,
                    data: 0,
                    udata: std::ptr::null_mut(),
                };
                let mut seen: libc::kevent = std::mem::zeroed();
                let count = libc::kevent(queue, &watch, 1, &mut seen, 1, std::ptr::null());
                // A parent that is already gone answers ESRCH, as an error event or as the call's error.
                let gone = (count > 0 && (seen.flags & libc::EV_ERROR == 0 || seen.data == libc::ESRCH as isize))
                    || (count < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH))
                    || libc::getppid() != parent;
                if gone {
                    libc::_exit(1);
                }
            }
        }));
    }
}

/// `mixdogd effort-judge-host`: the real model over the process's stdin and stdout. `threads` starts
/// the session's intra-op threads.
pub fn serve(config: &ModelConfig, threads: JudgeThread, input: impl BufRead, output: impl Write) -> i32 {
    end_with_parent();
    serve_resident(|| JudgeModel::load(config, threads).map(|model| Arc::new(model) as Arc<dyn Resident>), input, output)
}

/// How the host process is started.
#[derive(Clone, Debug)]
pub(crate) struct HostLaunch {
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<OsString>,
    pub(crate) env: Vec<(String, String)>,
}

impl HostLaunch {
    /// This executable as `mixdogd effort-judge-host` over `config`'s model.
    pub(crate) fn of(config: &ModelConfig) -> Result<Self, JudgeError> {
        let OrtRuntime::Library(library) = &config.ort_library else { return Err(JudgeError::Unsupported) };
        let program = std::env::current_exe().map_err(|error| JudgeError::Worker(format!("effort judge host: {error}")))?;
        let mut args: Vec<OsString> =
            vec![HOST_COMMAND.into(), "--dir".into(), config.dir.clone().into(), "--ort-library".into(), library.clone().into()];
        if config.explicit {
            args.push("--explicit".into());
        }
        Ok(Self { program, args, env: Vec::new() })
    }
}

fn dead() -> JudgeError {
    JudgeError::Worker("the effort judge host exited".to_owned())
}

/// The judge thread's end of a running host. Dropping it, or [`Resident::stopper`], kills the host.
pub(crate) struct HostClient {
    to_host: tokio::sync::mpsc::UnboundedSender<String>,
    replies: Mutex<mpsc::Receiver<Reply>>,
    kill: CancellationToken,
    /// Windows: the job the host runs in, which ends it whenever this process does (and when this
    /// client is dropped).
    _contained: Containment,
}

impl Drop for HostClient {
    fn drop(&mut self) {
        self.kill.cancel();
    }
}

impl HostClient {
    /// Starts the host and waits for its model to load. Runs on the judge's thread, which is no
    /// async context: `runtime` carries the host's pipes.
    ///
    /// The host is killed when it is not ready [`START_LIMIT`] after this starts, on `alarm`.
    pub(crate) fn start(launch: &HostLaunch, runtime: &tokio::runtime::Handle, alarm: &dyn Alarm) -> Result<Self, JudgeError> {
        let _context = runtime.enter();
        let mut command = tokio::process::Command::new(&launch.program);
        command
            .args(&launch.args)
            .envs(launch.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .env(PARENT_ENV, std::process::id().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // CREATE_NO_WINDOW | CREATE_SUSPENDED: the host joins its job before it runs an instruction.
        #[cfg(windows)]
        command.creation_flags(0x0800_0000 | 0x0000_0004);
        #[cfg(target_os = "linux")]
        {
            let parent = std::process::id() as libc::pid_t;
            // SAFETY: between fork and exec only async-signal-safe calls run (prctl, getppid). The
            // signal follows the thread that started the host; a parent that died before the signal
            // was set shows as a different parent, and the start fails.
            unsafe {
                command.pre_exec(move || {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::getppid() != parent {
                        return Err(std::io::Error::other("the effort judge host's parent exited"));
                    }
                    Ok(())
                });
            }
        }
        let mut child = command.spawn().map_err(|error| JudgeError::Load(format!("effort judge host: {error}")))?;
        let contained = match Containment::attach(&child) {
            Ok(contained) => contained,
            Err(error) => {
                drop(child.start_kill());
                return Err(JudgeError::Load(format!("effort judge host: {error}")));
            }
        };
        let (stdin, stdout) = (child.stdin.take().expect("piped"), child.stdout.take().expect("piped"));
        let kill = CancellationToken::new();
        let ready = Arc::new(AtomicBool::new(false));
        let timed_out = Arc::new(AtomicBool::new(false));
        {
            let (kill, ready, timed_out) = (kill.clone(), ready.clone(), timed_out.clone());
            alarm.after(
                START_LIMIT,
                Box::new(move || {
                    if !ready.load(Ordering::Acquire) {
                        timed_out.store(true, Ordering::Release);
                        kill.cancel();
                    }
                }),
            );
        }
        let (to_host, mut lines) = tokio::sync::mpsc::unbounded_channel::<String>();
        let (replies_tx, replies) = mpsc::channel();
        drop(mixdog_rt::spawn("services.effort-judge.host-write", TaskClass::Work, async move {
            let mut stdin = stdin;
            while let Some(line) = lines.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    return;
                }
            }
        }));
        drop(mixdog_rt::spawn("services.effort-judge.host-read", TaskClass::Work, async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Some(reply) = line.split_once(TAG).and_then(|(_, json)| serde_json::from_str::<Reply>(json).ok()) else { continue };
                if replies_tx.send(reply).is_err() {
                    return;
                }
            }
            // The sender goes with the task: a judgment waiting for a reply learns the host is gone.
        }));
        let reaper = kill.clone();
        drop(mixdog_rt::spawn("services.effort-judge.host-reap", TaskClass::Work, async move {
            tokio::select! {
                _ = child.wait() => {}
                () = reaper.cancelled() => drop(child.kill().await),
            }
        }));
        let client = Self { to_host, replies: Mutex::new(replies), kill, _contained: contained };
        let first = client.replies.lock().unwrap_or_else(PoisonError::into_inner).recv();
        if timed_out.load(Ordering::Acquire) {
            // Not a load failure: nothing is remembered, and the next judgment starts a new host.
            return Err(JudgeError::Worker("the effort judge host did not become ready in time".to_owned()));
        }
        match first {
            Ok(Reply::Ready) => ready.store(true, Ordering::Release),
            Ok(Reply::LoadFailed { kind, message }) => {
                return Err(match kind.as_str() {
                    "notInstalled" => JudgeError::NotInstalled(message),
                    "unsupported" => JudgeError::Unsupported,
                    _ => JudgeError::Load(message),
                });
            }
            _ => return Err(JudgeError::Load("effort judge host exited while loading".to_owned())),
        }
        Ok(client)
    }

    fn ask(&self, request: &Request) -> Result<Vec<f64>, JudgeError> {
        let line = serde_json::to_string(request).expect("a request serializes");
        self.to_host.send(format!("{line}\n")).map_err(|_| dead())?;
        match self.replies.lock().unwrap_or_else(PoisonError::into_inner).recv() {
            Ok(Reply::Probs { probs }) => Ok(probs),
            Ok(Reply::Failed { kind, message }) => Err(if kind == "stepsUnsupported" { JudgeError::StepsUnsupported } else { JudgeError::Run(message) }),
            Ok(_) | Err(_) => Err(dead()),
        }
    }
}

impl Resident for HostClient {
    fn probs(&self, input: &StepInput) -> Result<Vec<f64>, JudgeError> {
        let calls = input.calls.iter().map(|call| [call.name.clone(), call.args.clone(), call.result.clone()]).collect();
        self.ask(&Request::Step { request: input.request.clone(), step: input.step, plan: input.plan.clone(), calls })
    }

    fn turn_probs(&self, input: &TurnInput) -> Result<Vec<f64>, JudgeError> {
        self.ask(&Request::Turn { request: input.request.clone(), prev: input.prev.clone(), prev_request: input.prev_request.clone() })
    }

    fn stopper(&self) -> Stopper {
        let kill = self.kill.clone();
        Arc::new(move || kill.cancel())
    }
}
