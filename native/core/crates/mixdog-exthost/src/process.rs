//! Child processes and the I/O tasks of one worker: spawn under containment, a writer task that
//! owns stdin, a stderr drain, and the reader task that owns stdout and the child. The reader
//! always reads (RL §11.2): it delivers chunks and results the moment they arrive, so a slow
//! consumer of one call never holds up another call's frames or a worker's exit.

use std::ffi::OsString;
use std::path::Path;
use std::process::ExitStatus;
use std::process::Stdio;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use bytes::Bytes;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtExit;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_rt::TaskClass;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::process::Child;
use tokio::process::Command;
use tokio::runtime::Handle;
use tokio::sync::mpsc;
use tokio::sync::mpsc::UnboundedSender;

use crate::browser::BrowserHandle;
use crate::browser::BrowserLease;
use crate::containment::Containment;
use crate::containment::exit_of;
use crate::exits::ChildExits;
use crate::owner;
use crate::owner::ChildOps;
use crate::owner::Kill;
use crate::owner::Owner;
use crate::frame;
use crate::frame::CALL_WINDOW_BYTES;
use crate::frame::FrameReader;
use crate::frame::Inbound;
use crate::shared::Event;
use crate::shared::Slot;

pub(crate) struct Proc {
    pub(crate) child: Child,
    pub(crate) containment: Containment,
}

/// Spawns `program args…` with piped stdio under containment. Runs on the io-spawn lane; `rt` is
/// the async runtime the child's pipes register with.
pub(crate) fn spawn_command(
    program: &Path,
    args: &[OsString],
    envs: &[(&str, &str)],
    rt: &Handle,
) -> std::io::Result<Proc> {
    let _entered = rt.enter();
    spawn_contained(worker_command(program, args, envs)).map_err(|(error, _child)| error)
}

/// Creates `command` and puts it under containment. The child of a failed attach (created suspended, never resumed) is
/// ended and handed back with the error.
fn spawn_contained(mut command: Command) -> Result<Proc, (std::io::Error, Option<Child>)> {
    let mut child = command.spawn().map_err(|error| (error, None))?;
    match Containment::attach(&child) {
        Ok(containment) => Ok(Proc { child, containment }),
        Err(error) => {
            let _ = child.start_kill();
            Err((error, Some(child)))
        }
    }
}

/// The launcher's OS-proxy decision. Node deletes it from `process.env` when it adopts it
/// (`system-proxy.mjs:461`), so no worker it starts ever sees it.
const SYSTEM_PROXY_HANDOFF: &str = "MIXDOG_SYSTEM_PROXY_HANDOFF";

fn worker_command(program: &Path, args: &[OsString], envs: &[(&str, &str)]) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .env_remove(SYSTEM_PROXY_HANDOFF)
        .envs(envs.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    // CREATE_NO_WINDOW | CREATE_SUSPENDED: `Containment::attach` resumes the child once it is in its job.
    command.creation_flags(0x0800_0000 | 0x0000_0004);
    #[cfg(unix)]
    command.process_group(0);
    command
}

/// A child as its owner (`owner::Owner`) drives it: the real [`ChildOps`].
pub(crate) struct ProcOps {
    child: Child,
    containment: Containment,
    #[cfg(unix)]
    exits: ChildExits,
    /// Windows has no SIGCHLD: the owner learns of the exit by waiting on the child itself, and
    /// keeps the status here until the reap asks for it.
    #[cfg(windows)]
    status: Option<std::io::Result<ExitStatus>>,
}

impl ProcOps {
    #[cfg_attr(not(unix), allow(unused_variables, reason = "only Unix waits on SIGCHLD"))]
    pub(crate) fn new(proc: Proc, exits: ChildExits) -> Self {
        Self {
            child: proc.child,
            containment: proc.containment,
            #[cfg(unix)]
            exits,
            #[cfg(windows)]
            status: None,
        }
    }
}

impl ChildOps for ProcOps {
    type Exit = std::io::Result<ExitStatus>;

    fn signal_group(&mut self) {
        self.containment.kill_group();
    }

    #[cfg(unix)]
    fn leader_exited(&mut self) -> bool {
        self.containment.exited_unreaped()
    }

    #[cfg(windows)]
    fn leader_exited(&mut self) -> bool {
        if self.status.is_none() {
            self.status = self.child.try_wait().transpose();
        }
        self.status.is_some()
    }

    #[cfg(unix)]
    async fn changed(&mut self) -> bool {
        self.exits.changed().await
    }

    #[cfg(windows)]
    async fn changed(&mut self) -> bool {
        self.status = Some(self.child.wait().await);
        true
    }

    async fn reap(&mut self) -> Self::Exit {
        #[cfg(windows)]
        if let Some(status) = self.status.take() {
            return status;
        }
        self.child.wait().await
    }
}

/// What the dispatcher keeps of a running worker.
pub(crate) struct WorkerIo {
    pub(crate) writer: UnboundedSender<Bytes>,
    pub(crate) slot: Arc<Slot>,
    /// Asks the owner to end the worker's job or group; the owner signals, then reaps.
    pub(crate) kill: Kill,
    /// Set before an operator-requested termination so the exit reads as `Stopped`.
    pub(crate) stopped: Arc<AtomicBool>,
}

pub(crate) fn start_worker(
    worker: u32,
    proc: Proc,
    events: UnboundedSender<Event>,
    browser: BrowserHandle,
    exits: ChildExits,
) -> WorkerIo {
    let mut proc = proc;
    let stdin = proc.child.stdin.take();
    let stdout = proc.child.stdout.take();
    let stderr = proc.child.stderr.take();
    let (owner, kill) = owner::owner(ProcOps::new(proc, exits));
    let (writer, mut outbox) = mpsc::unbounded_channel::<Bytes>();
    let slot = Arc::new(Slot::default());
    let stopped = Arc::new(AtomicBool::new(false));

    // Dropping the last writer closes stdin, which ends the worker.
    mixdog_rt::spawn("exthost.worker.write", TaskClass::Work, async move {
        let Some(mut stdin) = stdin else { return };
        while let Some(bytes) = outbox.recv().await {
            if stdin.write_all(&bytes).await.is_err() {
                break;
            }
        }
    });

    mixdog_rt::spawn("exthost.worker.stderr", TaskClass::Work, async move {
        let Some(mut stderr) = stderr else { return };
        let mut buf = [0u8; 4096];
        while let Ok(n) = stderr.read(&mut buf).await {
            if n == 0 {
                break;
            }
            tracing::debug!(worker, "{}", String::from_utf8_lossy(&buf[..n]).trim_end());
        }
    });

    let reader = Reader {
        worker,
        slot: slot.clone(),
        writer: writer.clone(),
        events,
        browser,
        leases: Arc::default(),
        kill: kill.clone(),
    };
    let stopped_flag = stopped.clone();
    mixdog_rt::spawn("exthost.worker.read", TaskClass::Work, async move {
        let Some(stdout) = stdout else { return };
        reader.run(owner, FrameReader::new(stdout), stopped_flag).await;
    });

    WorkerIo {
        writer,
        slot,
        kill,
        stopped,
    }
}

struct Reader {
    worker: u32,
    slot: Arc<Slot>,
    writer: UnboundedSender<Bytes>,
    events: UnboundedSender<Event>,
    browser: BrowserHandle,
    /// Browser leases of the calls running now, released when each call ends (or the worker does).
    leases: Arc<Mutex<HashMap<u32, BrowserLease>>>,
    /// The reader asks the owner (the same task) to end the worker; it never signals itself.
    kill: Kill,
}

/// A frame the protocol forbids; the worker is terminated and its exit is the outcome.
struct Violation(&'static str);

impl Reader {
    async fn run(
        self,
        mut owner: Owner<ProcOps>,
        mut frames: FrameReader<tokio::process::ChildStdout>,
        stopped: Arc<AtomicBool>,
    ) {
        let mut reading = true;
        let wait = owner.until_exit();
        tokio::pin!(wait);
        let status = loop {
            tokio::select! {
                biased;
                frame = frames.next(), if reading => match frame {
                    Ok(Some(frame)) => {
                        if let Err(Violation(why)) = self.handle(frame) {
                            tracing::warn!(worker = self.worker, why, "extension worker violated the protocol");
                            self.kill.kill();
                            reading = false;
                        }
                    }
                    Ok(None) => reading = false,
                    Err(error) => {
                        tracing::warn!(worker = self.worker, %error, "extension worker pipe failed");
                        self.kill.kill();
                        reading = false;
                    }
                },
                status = &mut wait => break status,
            }
        };
        // Whatever the worker wrote before it exited is still in the pipe.
        if reading {
            while let Ok(Some(frame)) = frames.next_buffered() {
                if self.handle(frame).is_err() {
                    break;
                }
            }
        }
        let exit = if stopped.load(Ordering::Acquire) {
            ExtExit::Stopped
        } else {
            status.map_or(ExtExit::Code(-1), exit_of)
        };
        if let Some(out) = self.slot.take_any() {
            let _ = out
                .frames
                .send(ExtFrame::Done(Err(ExtError::HostExited { exit })));
        }
        let _ = self.events.send(Event::Exited(self.worker));
    }

    fn handle(&self, frame: Inbound) -> Result<(), Violation> {
        match frame {
            Inbound::Ready => {
                let _ = self.events.send(Event::Ready(self.worker));
            }
            Inbound::Chunk { call, bytes } => {
                let out = self.slot.current(call).ok_or(Violation("chunk for a call that is not running"))?;
                let len = bytes.len() as u64;
                if out.outstanding.fetch_add(len, Ordering::AcqRel) + len > CALL_WINDOW_BYTES {
                    return Err(Violation("chunk beyond the call window"));
                }
                if out.frames.send(ExtFrame::Chunk(bytes.to_vec())).is_err() {
                    out.outstanding.fetch_sub(len, Ordering::AcqRel);
                }
            }
            Inbound::Result { call, pin, outcome } => {
                let out = self.slot.take(call).ok_or(Violation("result for a call that is not running"))?;
                let done = match outcome {
                    Ok(value) => Ok(value),
                    Err(error) if error.code == frame::CANCELLED_CODE => Err(ExtError::Cancelled),
                    Err(error) => Err(ExtError::Failed {
                        code: error.code,
                        message: error.message,
                    }),
                };
                self.leases.lock().unwrap_or_else(|e| e.into_inner()).remove(&call);
                let _ = out.frames.send(ExtFrame::Done(done));
                let _ = self.events.send(Event::Finished {
                    worker: self.worker,
                    call,
                    pin,
                });
            }
            Inbound::NeedBrowser { call } => {
                self.slot.current(call).ok_or(Violation("browser request outside a call"))?;
                let browser = self.browser.clone();
                let writer = self.writer.clone();
                let leases = self.leases.clone();
                let slot = self.slot.clone();
                mixdog_rt::spawn("exthost.browser.answer", TaskClass::Work, async move {
                    // The browser stays open for as long as the call that asked for it runs.
                    let answer = match browser.lease().await {
                        Ok((ws, lease)) => {
                            let mut held = leases.lock().unwrap_or_else(|e| e.into_inner());
                            if slot.current(call).is_some() {
                                held.insert(call, lease);
                            }
                            Ok(ws)
                        }
                        Err(error) => Err(error.to_string()),
                    };
                    let _ = writer.send(frame::browser(call, &answer));
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_worker_does_not_inherit_the_launchers_system_proxy_decision() {
        let command = worker_command(Path::new("node"), &[], &[("OTHER", "1")]);
        let envs: Vec<_> = command.as_std().get_envs().collect();
        assert!(envs.contains(&(std::ffi::OsStr::new(SYSTEM_PROXY_HANDOFF), None)), "removed from the child");
        assert!(envs.contains(&(std::ffi::OsStr::new("OTHER"), Some(std::ffi::OsStr::new("1")))), "the given env stays");
    }

    /// A worker that starts a grandchild (holding the worker's stdout) at once, then prints `ready` and stays alive.
    fn starts_a_grandchild() -> Command {
        #[cfg(windows)]
        let (program, args) = ("cmd", ["/d", "/c", "start /b ping -n 100 127.0.0.1 & echo ready & ping -n 100 127.0.0.1 >nul"]);
        #[cfg(unix)]
        let (program, args) = ("sh", ["-c", "sleep 100 & echo ready; wait"]);
        let args: Vec<OsString> = args.iter().map(OsString::from).collect();
        worker_command(Path::new(program), &args, &[])
    }

    /// A worker that starts a grandchild at its first instruction is ended, grandchild included, when its containment
    /// ends: the grandchild holds the worker's stdout, so the pipe reaches its end only once the whole tree is gone.
    #[tokio::test]
    async fn a_worker_that_starts_a_grandchild_at_once_ends_with_its_job() {
        use tokio::io::AsyncBufReadExt;
        let Ok(mut proc) = spawn_contained(starts_a_grandchild()) else {
            panic!("the start failed");
        };
        let mut stdout = tokio::io::BufReader::new(proc.child.stdout.take().unwrap());
        let mut line = String::new();
        mixdog_rt::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                line.clear();
                assert!(stdout.read_line(&mut line).await.unwrap() > 0, "the worker ended before it said ready");
                if line.trim() == "ready" {
                    break;
                }
            }
        })
        .await
        .expect("the worker says ready (its grandchild runs) in 30 s");
        proc.containment.kill_group();
        let mut rest = Vec::new();
        mixdog_rt::time::timeout(std::time::Duration::from_secs(30), stdout.read_to_end(&mut rest))
            .await
            .expect("the grandchild ended with the job: its end of the stdout pipe closed in 30 s")
            .unwrap();
        mixdog_rt::time::timeout(std::time::Duration::from_secs(30), proc.child.wait())
            .await
            .expect("the worker ended in 30 s")
            .unwrap();
    }

    /// A worker the job refuses is not started: the start fails and the child, created suspended and never resumed, is
    /// ended.
    #[tokio::test]
    async fn a_failed_attach_fails_the_start_with_the_worker_ended() {
        crate::containment::FAIL_NEXT_ATTACH.with(|fail| fail.set(true));
        let (error, child) = match spawn_contained(starts_a_grandchild()) {
            Ok(_) => panic!("a worker that could not be contained was started"),
            Err(failed) => failed,
        };
        assert!(error.to_string().contains("attach failed"), "{error}");
        let mut child = child.expect("the child was created");
        mixdog_rt::time::timeout(std::time::Duration::from_secs(30), child.wait())
            .await
            .expect("the child of a failed attach ended in 30 s, not left suspended")
            .unwrap();
    }
}