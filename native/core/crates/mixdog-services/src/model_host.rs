//! Contained, headless model processes, with tagged JSON lines on their standard pipes.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, mpsc};
use std::sync::atomic::{AtomicBool, Ordering};

use mixdog_exthost::Containment;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub(crate) struct HostLaunch {
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<OsString>,
    pub(crate) env: Vec<(String, String)>,
}

pub(crate) struct Pipes {
    to_host: tokio::sync::mpsc::UnboundedSender<String>,
    replies: Mutex<mpsc::Receiver<String>>,
    pub(crate) kill: CancellationToken,
    alive: Arc<AtomicBool>,
    _contained: Containment,
}

impl Drop for Pipes {
    fn drop(&mut self) {
        self.kill.cancel();
    }
}

impl Pipes {
    pub(crate) fn start(launch: &HostLaunch, tag: &'static str, runtime: &tokio::runtime::Handle) -> Result<Self, String> {
        let _context = runtime.enter();
        let mut command = tokio::process::Command::new(&launch.program);
        command.args(&launch.args)
            .envs(launch.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .env("MIXDOG_EFFORT_JUDGE_PARENT", std::process::id().to_string())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        // Containment must be attached before the child executes, including during model loading.
        #[cfg(windows)]
        command.creation_flags(0x0800_0000 | 0x0000_0004);
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
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let contained = match Containment::attach(&child) {
            Ok(contained) => contained,
            Err(error) => {
                drop(child.start_kill());
                return Err(error.to_string());
            }
        };
        let (mut stdin, stdout) = (child.stdin.take().expect("piped"), child.stdout.take().expect("piped"));
        let kill = CancellationToken::new();
        let alive = Arc::new(AtomicBool::new(true));
        let (to_host, mut lines) = tokio::sync::mpsc::unbounded_channel::<String>();
        let (replies_tx, replies) = mpsc::channel();
        let writer_kill = kill.clone();
        drop(mixdog_rt::spawn("services.model-host.write", mixdog_rt::TaskClass::Work, async move {
            loop {
                let line = tokio::select! {
                    () = writer_kill.cancelled() => return,
                    line = lines.recv() => match line { Some(line) => line, None => return },
                };
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    writer_kill.cancel();
                    return;
                }
            }
        }));
        let reader_alive = alive.clone();
        let reader_kill = kill.clone();
        drop(mixdog_rt::spawn("services.model-host.read", mixdog_rt::TaskClass::Work, async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Some((_, json)) = line.split_once(tag) else { continue };
                if replies_tx.send(json.to_owned()).is_err() {
                    break;
                }
            }
            reader_alive.store(false, Ordering::Release);
            reader_kill.cancel();
        }));
        let reaper = kill.clone();
        let reaper_alive = alive.clone();
        drop(mixdog_rt::spawn("services.model-host.reap", mixdog_rt::TaskClass::Work, async move {
            tokio::select! {
                _ = child.wait() => {}
                () = reaper.cancelled() => drop(child.kill().await),
            }
            reaper_alive.store(false, Ordering::Release);
        }));
        Ok(Self { to_host, replies: Mutex::new(replies), kill, alive, _contained: contained })
    }

    pub(crate) fn alive(&self) -> bool {
        self.alive.load(Ordering::Acquire) && !self.kill.is_cancelled()
    }

    pub(crate) fn receive(&self) -> Result<String, String> {
        self.replies.lock().unwrap_or_else(std::sync::PoisonError::into_inner).recv()
            .map_err(|_| "model host exited while waiting for a reply".to_owned())
    }

    /// Callers serialize whole exchanges, not only the receive half.
    pub(crate) fn send(&self, line: String) -> Result<(), String> {
        self.to_host.send(format!("{line}\n")).map_err(|_| "model host exited before the request was written".to_owned())
    }
}
