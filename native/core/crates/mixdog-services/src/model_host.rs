//! Contained, headless model processes, with tagged JSON lines on their standard pipes.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};

use mixdog_exthost::Containment;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub(crate) struct HostLaunch {
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<OsString>,
    pub(crate) env: Vec<(String, String)>,
}

/// Why the reaper could not read the host's exit status.
pub(crate) type WaitError = Arc<str>;

/// A host's one lifecycle value (Rule B). EOF on its output, a writer failure or a kill request make it `Stopping`, which classifies nothing;
/// only the reaper publishes `Ended`, once `wait()` returned, with the exit status (or the wait's failure) and whether the host's owner retired it.
#[derive(Clone, Debug)]
pub(crate) enum Lifecycle {
    Running,
    Stopping,
    Ended { generation: u64, exit: Result<std::process::ExitStatus, WaitError>, retired: bool },
}

/// Hosts started so far in this process: each host is one generation.
static GENERATIONS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Observes a particular child without keeping its pipes or containment alive.
#[cfg(test)]
#[derive(Clone)]
pub(crate) struct ChildExit {
    pub(crate) pid: u32,
    pub(crate) generation: u64,
    result: tokio::sync::watch::Receiver<Option<Result<std::process::ExitStatus, WaitError>>>,
}

#[cfg(test)]
impl ChildExit {
    pub(crate) async fn wait(&mut self) -> std::process::ExitStatus {
        self.result
            .wait_for(Option::is_some)
            .await
            .expect("child reaper stopped without reporting exit")
            .as_ref()
            .expect("exit published")
            .clone()
            .expect("waiting for the child failed")
    }
}

pub(crate) struct Pipes {
    to_host: tokio::sync::mpsc::UnboundedSender<String>,
    replies: Mutex<mpsc::Receiver<String>>,
    pub(crate) kill: CancellationToken,
    generation: u64,
    state: tokio::sync::watch::Receiver<Lifecycle>,
    /// Set by [`Pipes::retire`] before its kill: the host's end is its owner's choice, not a failure.
    retired: Arc<AtomicBool>,
    /// Held by a test to withhold the reaper's publication of `Ended`.
    #[cfg(test)]
    pub(crate) end_gate: Arc<tokio::sync::Semaphore>,
    #[cfg(test)]
    pub(crate) child_exit: ChildExit,
    _contained: Containment,
}

impl Drop for Pipes {
    fn drop(&mut self) {
        self.kill.cancel();
    }
}

impl Pipes {
    pub(crate) fn start(launch: &HostLaunch, tag: &'static str, runtime: &tokio::runtime::Handle) -> Result<Self, String> {
        Self::start_at(launch, tag, runtime, false)
    }

    /// [`Pipes::start`] for a host that runs below normal priority, as Node's memory process did (`os.setPriority(PRIORITY_BELOW_NORMAL)`): the host
    /// and every thread and child it makes start at it.
    pub(crate) fn start_below_normal(launch: &HostLaunch, tag: &'static str, runtime: &tokio::runtime::Handle) -> Result<Self, String> {
        Self::start_at(launch, tag, runtime, true)
    }

    fn host_command(launch: &HostLaunch, below_normal: bool) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(&launch.program);
        command
            .args(&launch.args)
            .envs(launch.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .env("MIXDOG_EFFORT_JUDGE_PARENT", std::process::id().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // Containment must be attached before the child executes, including during model loading.
        #[cfg(windows)]
        command.creation_flags(0x0800_0000 | 0x0000_0004 | if below_normal { 0x0000_4000 } else { 0 });
        // libuv's PRIORITY_BELOW_NORMAL on POSIX.
        #[cfg(unix)]
        {
            // A session of its own, which the core's warden ends with the core.
            // SAFETY: enter_session is async-signal-safe.
            unsafe {
                command.pre_exec(mixdog_spawn::warden::enter_session);
            }
            if below_normal {
                // SAFETY: only async-signal-safe operations run between fork and exec.
                unsafe {
                    command.pre_exec(|| {
                        libc::setpriority(libc::PRIO_PROCESS, 0, 10);
                        Ok(())
                    });
                }
            }
        }
        #[cfg(target_os = "linux")]
        {
            let parent = std::process::id() as libc::pid_t;
            // SAFETY: only async-signal-safe operations run between fork and exec.
            unsafe {
                command.pre_exec(move || {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::getppid() != parent {
                        return Err(std::io::Error::other("model host parent exited"));
                    }
                    Ok(())
                });
            }
        }
        command
    }

    fn start_at(launch: &HostLaunch, tag: &'static str, runtime: &tokio::runtime::Handle, below_normal: bool) -> Result<Self, String> {
        let _context = runtime.enter();
        let mut child = Self::host_command(launch, below_normal).spawn().map_err(|e| e.to_string())?;
        let contained = match Containment::attach(&child) {
            Ok(contained) => contained,
            Err(error) => {
                drop(child.start_kill());
                return Err(error.to_string());
            }
        };
        let (mut stdin, stdout) = (child.stdin.take().expect("piped"), child.stdout.take().expect("piped"));
        let kill = CancellationToken::new();
        let generation = GENERATIONS.fetch_add(1, Ordering::Relaxed) + 1;
        #[cfg(test)]
        let (exit_report, child_exit) = {
            let (report, result) = tokio::sync::watch::channel(None);
            (report, ChildExit { pid: child.id().expect("spawned child"), generation, result })
        };
        let (publish, state) = tokio::sync::watch::channel(Lifecycle::Running);
        let publish = Arc::new(publish);
        // EOF, a writer failure or a kill request: the host is stopping, nothing more (the reaper alone says how it ended).
        let stopping = |publish: &tokio::sync::watch::Sender<Lifecycle>| {
            publish.send_if_modified(|state| {
                matches!(state, Lifecycle::Running) && {
                    *state = Lifecycle::Stopping;
                    true
                }
            });
        };
        let (to_host, mut lines) = tokio::sync::mpsc::unbounded_channel::<String>();
        let (replies_tx, replies) = mpsc::channel();
        let (writer_kill, writer_state) = (kill.clone(), publish.clone());
        drop(mixdog_rt::spawn("services.model-host.write", mixdog_rt::TaskClass::Work, async move {
            loop {
                let line = tokio::select! {
                    () = writer_kill.cancelled() => return,
                    line = lines.recv() => match line { Some(line) => line, None => return },
                };
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    stopping(&writer_state);
                    writer_kill.cancel();
                    return;
                }
            }
        }));
        let (reader_kill, reader_state) = (kill.clone(), publish.clone());
        drop(mixdog_rt::spawn("services.model-host.read", mixdog_rt::TaskClass::Work, async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Some((_, json)) = line.split_once(tag) else { continue };
                if replies_tx.send(json.to_owned()).is_err() {
                    break;
                }
            }
            stopping(&reader_state);
            reader_kill.cancel();
        }));
        let (reaper, reaper_state) = (kill.clone(), publish);
        let retired = Arc::new(AtomicBool::new(false));
        let reaper_retired = retired.clone();
        #[cfg(test)]
        let end_gate = Arc::new(tokio::sync::Semaphore::new(1));
        #[cfg(test)]
        let reaper_gate = end_gate.clone();
        drop(mixdog_rt::spawn("services.model-host.reap", mixdog_rt::TaskClass::Work, async move {
            // The exit status is read in both cases: a host we killed did not exit cleanly, one that had already exited with zero did.
            let status = tokio::select! {
                status = child.wait() => status,
                () = reaper.cancelled() => {
                    stopping(&reaper_state);
                    drop(child.start_kill());
                    child.wait().await
                }
            };
            let exit = status.map_err(|error| WaitError::from(error.to_string()));
            #[cfg(test)]
            let _gate = {
                // Distinguish the OS wait from publication of the state-machine
                // transition, which some tests intentionally delay.
                exit_report.send_replace(Some(exit.clone()));
                reaper_gate.acquire().await
            };
            reaper_state.send_replace(Lifecycle::Ended { generation, exit, retired: reaper_retired.load(Ordering::Acquire) });
        }));
        Ok(Self {
            to_host,
            replies: Mutex::new(replies),
            kill,
            generation,
            state,
            retired,
            #[cfg(test)]
            end_gate,
            #[cfg(test)]
            child_exit,
            _contained: contained,
        })
    }

    /// This host's generation.
    #[cfg(test)]
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    /// The host's lifecycle now: a kill already requested reads as `Stopping` until the reaper publishes the end.
    pub(crate) fn lifecycle(&self) -> Lifecycle {
        match &*self.state.borrow() {
            Lifecycle::Running if self.kill.is_cancelled() => Lifecycle::Stopping,
            state => state.clone(),
        }
    }

    /// Resolves with the reaper's `Ended` once `wait()` returned.
    pub(crate) async fn ended(&self) -> Lifecycle {
        let mut state = self.state.clone();
        let ended = state.wait_for(|state| matches!(state, Lifecycle::Ended { .. })).await.map(|state| state.clone());
        // The sender lives in the reaper until it publishes; it never drops without `Ended`.
        ended.unwrap_or_else(|_| Lifecycle::Ended {
            generation: self.generation,
            exit: Err(WaitError::from("the reaper ended without the exit")),
            retired: false,
        })
    }

    /// The owner ends the host (an idle release, a disposal): its end is then `retired` and never counted as a failure or a clean exit.
    pub(crate) fn retire(&self) {
        self.retired.store(true, Ordering::Release);
        self.kill.cancel();
    }

    pub(crate) fn alive(&self) -> bool {
        matches!(self.lifecycle(), Lifecycle::Running)
    }

    pub(crate) fn receive(&self) -> Result<String, String> {
        self.replies.lock().unwrap_or_else(std::sync::PoisonError::into_inner).recv().map_err(|_| "model host exited while waiting for a reply".to_owned())
    }

    /// Callers serialize whole exchanges, not only the receive half.
    pub(crate) fn send(&self, line: String) -> Result<(), String> {
        self.to_host.send(format!("{line}\n")).map_err(|_| "model host exited before the request was written".to_owned())
    }
}
