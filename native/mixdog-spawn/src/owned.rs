//! One helper child owned by this process, over raw pipes (the code graph helper's launcher).
//!
//! The child is contained from its first instruction and cannot outlive its owner:
//! - Windows: created inside a kill-on-close job that allows no breakaway (`crate::winspawn`), inheriting exactly its
//!   three standard handles.
//! - Unix: the leader of a session of its own, which the warden ends with the owner however the owner ends
//!   (`crate::warden`), and so its process group is the owner's to kill. The group is signalled only
//!   while the leader is unreaped, under the lock its reaper takes, so no signal can reach a reused pid. Every descriptor
//!   std opens is close-on-exec: the standard streams are all the child inherits.
//! - Linux: the parent-death signal (SIGKILL), set before exec, with the parent checked after it is set.
//! - macOS: there is no parent-death signal; the child watches its owner itself ([`hold_to_parent`]).
//!
//! One thread per child starts it and stays its reaper. On Linux the parent-death signal follows the thread that forked,
//! and this one lives exactly as long as the child.

use std::ffi::OsString;
use std::io;
use std::io::PipeReader;
use std::io::PipeWriter;
use std::path::PathBuf;
use std::process::ExitStatus;
use std::sync::Arc;

use tokio::sync::oneshot;
use tokio::sync::watch;

/// The child's environment names its owner's process id here; [`hold_to_parent`] reads it.
pub const PARENT_ENV: &str = "MIXDOG_OWNED_PARENT";

/// What to start: a program, its arguments, variables added to this process's environment, and its directory.
#[derive(Clone, Debug)]
pub struct OwnedCommand {
    program: PathBuf,
    args: Vec<OsString>,
    env: Vec<(OsString, OsString)>,
    cwd: Option<PathBuf>,
}

impl OwnedCommand {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self { program: program.into(), args: Vec::new(), env: Vec::new(), cwd: None }
    }

    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn args<I: IntoIterator<Item = S>, S: Into<OsString>>(mut self, args: I) -> Self {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    pub fn current_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.cwd = Some(dir.into());
        self
    }
}

/// The owner's ends of the child's standard streams.
pub struct OwnedPipes {
    pub input: PipeWriter,
    pub output: PipeReader,
    /// Its standard error: read it to its end, or the child blocks once the pipe is full.
    pub errors: PipeReader,
}

/// How the child ended, once its reaper has reaped it.
#[derive(Clone, Debug)]
pub enum Reaped {
    Exited(ExitStatus),
    /// The wait failed: nothing more can be learned of the child, and this process no longer holds it.
    Lost(String),
}

/// A started child. Dropping it kills it; its reaper still reaps it.
pub struct OwnedChild {
    pid: u32,
    owner: Arc<sys::Owner>,
    reaped: watch::Receiver<Option<Reaped>>,
}

impl OwnedChild {
    /// Starts `command`. A future dropped before it answers leaves the child it started to be killed and reaped.
    pub async fn spawn(command: &OwnedCommand) -> io::Result<(OwnedChild, OwnedPipes)> {
        let (answer, answered) = oneshot::channel();
        let command = command.clone();
        std::thread::Builder::new().name("owned-child".to_owned()).spawn(move || own(&command, answer))?;
        answered.await.unwrap_or_else(|_| Err(io::Error::other("the child's owner thread ended before it answered")))
    }

    pub fn id(&self) -> u32 {
        self.pid
    }

    /// Kills the child and whatever it started; nothing once it has been reaped.
    pub fn kill(&self) {
        self.owner.kill();
    }

    /// The child's end, which outlives this handle.
    pub fn reaped(&self) -> ReapWatch {
        ReapWatch(self.reaped.clone())
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        self.owner.kill();
    }
}

#[derive(Clone)]
pub struct ReapWatch(watch::Receiver<Option<Reaped>>);

impl ReapWatch {
    /// How the child ended, if it has been reaped.
    pub fn now(&self) -> Option<Reaped> {
        self.0.borrow().clone()
    }

    /// Completes once the child has been reaped.
    pub async fn wait(mut self) -> Reaped {
        match self.0.wait_for(Option::is_some).await {
            Ok(reaped) => reaped.clone().unwrap_or_else(|| Reaped::Lost("the reaper published nothing".to_owned())),
            Err(_) => Reaped::Lost("the reaper ended without reporting".to_owned()),
        }
    }
}

/// The owner thread: starts the child, answers, then reaps it.
fn own(command: &OwnedCommand, answer: oneshot::Sender<io::Result<(OwnedChild, OwnedPipes)>>) {
    let (process, owner, pipes) = match sys::start(command) {
        Ok(started) => started,
        Err(error) => {
            let _ = answer.send(Err(error));
            return;
        }
    };
    let owner = Arc::new(owner);
    let (publish, reaped) = watch::channel(None);
    let child = OwnedChild { pid: owner.pid, owner: Arc::clone(&owner), reaped };
    // A requester that is gone hands the child back here, and its drop kills it.
    drop(answer.send(Ok((child, pipes))));
    publish.send_replace(Some(sys::reap(&owner, process)));
}

/// The child's side: fails unless this process is held to the owner [`PARENT_ENV`] names, so that it cannot outlive it.
/// A child calls it before it tells its owner it is ready. On macOS it starts the watch that ends this process the moment
/// the owner exits; elsewhere the watch was set when the child was created, and this checks it.
pub fn hold_to_parent() -> io::Result<()> {
    let parent = std::env::var(PARENT_ENV)
        .ok()
        .and_then(|pid| pid.parse::<u32>().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{PARENT_ENV} names no owner")))?;
    hold::hold(parent)
}

#[cfg(unix)]
mod sys {
    use std::io;
    use std::sync::Mutex;
    use std::sync::PoisonError;

    use super::OwnedCommand;
    use super::OwnedPipes;
    use super::PARENT_ENV;
    use super::Reaped;

    pub(super) struct Owner {
        pub(super) pid: u32,
        /// Held while the child is reaped; true from then on.
        reaped: Mutex<bool>,
    }

    pub(super) struct Process(std::process::Child);

    pub(super) fn start(command: &OwnedCommand) -> io::Result<(Process, Owner, OwnedPipes)> {
        use std::os::unix::process::CommandExt;
        let (child_input, input) = std::io::pipe()?;
        let (output, child_output) = std::io::pipe()?;
        let (errors, child_errors) = std::io::pipe()?;
        let mut cmd = std::process::Command::new(&command.program);
        cmd.args(&command.args)
            .envs(command.env.iter().cloned())
            .env(PARENT_ENV, std::process::id().to_string())
            .stdin(child_input)
            .stdout(child_output)
            .stderr(child_errors);
        if let Some(dir) = &command.cwd {
            cmd.current_dir(dir);
        }
        #[cfg(target_os = "linux")]
        let parent = std::process::id() as libc::pid_t;
        // SAFETY: only async-signal-safe calls run between fork and exec, and nothing is allocated.
        unsafe {
            cmd.pre_exec(move || {
                crate::warden::enter_session()?;
                #[cfg(target_os = "linux")]
                {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    // An owner that exited before the signal was set has already passed it by.
                    if libc::getppid() != parent {
                        return Err(io::Error::from_raw_os_error(libc::ESRCH));
                    }
                }
                Ok(())
            });
        }
        let child = cmd.spawn()?;
        // The child's pipe ends `cmd` holds close here.
        drop(cmd);
        let pid = child.id();
        Ok((Process(child), Owner { pid, reaped: Mutex::new(false) }, OwnedPipes { input, output, errors }))
    }

    impl Owner {
        pub(super) fn kill(&self) {
            let reaped = self.reaped.lock().unwrap_or_else(PoisonError::into_inner);
            if !*reaped {
                kill_group(self.pid);
            }
        }
    }

    /// The caller holds the reap lock, and the group's leader is not reaped: its id still names this group.
    fn kill_group(pid: u32) {
        // SAFETY: a signal to a process group; no memory is involved.
        unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
    }

    pub(super) fn reap(owner: &Owner, mut process: Process) -> Reaped {
        let exited = wait_exited(owner.pid);
        let mut reaped = owner.reaped.lock().unwrap_or_else(PoisonError::into_inner);
        if exited.is_ok() {
            // What the leader left in its group goes with it, while the leader's id still names the group.
            kill_group(owner.pid);
        }
        let status = process.0.wait();
        *reaped = true;
        drop(reaped);
        match status {
            Ok(status) => Reaped::Exited(status),
            Err(error) => Reaped::Lost(error.to_string()),
        }
    }

    /// Blocks until the child has exited, leaving it unreaped (`WNOWAIT`).
    #[cfg(not(target_os = "macos"))]
    fn wait_exited(pid: u32) -> io::Result<()> {
        loop {
            // SAFETY: `info` is a plain out-parameter of the size `waitid` writes.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            if unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) } == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    /// Blocks until the child has exited, leaving it unreaped: its exit as a kqueue event (macOS's `waitid` is not relied
    /// on to leave a child waitable). A child already exited answers its registration with ESRCH.
    #[cfg(target_os = "macos")]
    fn wait_exited(pid: u32) -> io::Result<()> {
        // SAFETY: kqueue and kevent on a descriptor and structures owned here.
        unsafe {
            let queue = libc::kqueue();
            if queue < 0 {
                return Err(io::Error::last_os_error());
            }
            let watch = libc::kevent {
                ident: pid as usize,
                filter: libc::EVFILT_PROC,
                flags: libc::EV_ADD | libc::EV_ONESHOT,
                fflags: libc::NOTE_EXIT,
                data: 0,
                udata: std::ptr::null_mut(),
            };
            let mut seen: libc::kevent = std::mem::zeroed();
            let outcome = loop {
                let count = libc::kevent(queue, &watch, 1, &mut seen, 1, std::ptr::null());
                if count > 0 {
                    break Ok(());
                }
                let error = io::Error::last_os_error();
                match error.raw_os_error() {
                    Some(libc::EINTR) => continue,
                    Some(libc::ESRCH) => break Ok(()),
                    _ => break Err(error),
                }
            };
            libc::close(queue);
            outcome
        }
    }
}

#[cfg(windows)]
mod sys {
    use std::ffi::OsString;
    use std::io;
    use std::os::windows::io::AsHandle;

    use super::OwnedCommand;
    use super::OwnedPipes;
    use super::PARENT_ENV;
    use super::Reaped;
    use crate::contain::Containment;
    use crate::winspawn;

    pub(super) struct Owner {
        pub(super) pid: u32,
        containment: Containment,
    }

    pub(super) struct Process(winspawn::WinProcess);

    fn unicode<'a>(text: &'a std::ffi::OsStr, what: &str) -> io::Result<&'a str> {
        text.to_str().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("the {what} is not Unicode")))
    }

    pub(super) fn start(command: &OwnedCommand) -> io::Result<(Process, Owner, OwnedPipes)> {
        let program = unicode(command.program.as_os_str(), "program path")?;
        let mut line = winspawn::quote_windows_arg(program);
        for arg in &command.args {
            line.push(' ');
            line.push_str(&winspawn::quote_windows_arg(unicode(arg, "argument")?));
        }
        let mut env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
        let parent = (OsString::from(PARENT_ENV), OsString::from(std::process::id().to_string()));
        for (key, value) in command.env.iter().chain(std::iter::once(&parent)) {
            env.retain(|(name, _)| !name.eq_ignore_ascii_case(key));
            env.push((key.clone(), value.clone()));
        }
        let (child_input, input) = std::io::pipe()?;
        let (output, child_output) = std::io::pipe()?;
        let (errors, child_errors) = std::io::pipe()?;
        let containment = Containment::create(false)?;
        let process = winspawn::spawn(
            containment.job(),
            &winspawn::Spawn {
                program,
                command_line: &line,
                cwd: command.cwd.as_deref(),
                env: Some(&env),
                stdio: winspawn::Stdio::Handles {
                    stdin: Some(child_input.as_handle()),
                    stdout: Some(child_output.as_handle()),
                    stderr: Some(child_errors.as_handle()),
                },
            },
        )?;
        drop((child_input, child_output, child_errors));
        let pid = process.id();
        Ok((Process(process), Owner { pid, containment }, OwnedPipes { input, output, errors }))
    }

    impl Owner {
        /// A job is not named by a pid: ending it never reaches another process.
        pub(super) fn kill(&self) {
            self.containment.kill();
        }
    }

    pub(super) fn reap(owner: &Owner, process: Process) -> Reaped {
        let status = process.0.wait();
        // What the child left in its job goes with it.
        owner.containment.kill();
        match status {
            Ok(status) => Reaped::Exited(status),
            Err(error) => Reaped::Lost(error.to_string()),
        }
    }
}

#[cfg(target_os = "linux")]
mod hold {
    use std::io;

    pub(super) fn hold(parent: u32) -> io::Result<()> {
        let mut signal: libc::c_int = 0;
        // SAFETY: PR_GET_PDEATHSIG writes one int through the pointer.
        if unsafe { libc::prctl(libc::PR_GET_PDEATHSIG, &mut signal as *mut libc::c_int) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if signal != libc::SIGKILL {
            return Err(io::Error::other("no parent-death signal is set"));
        }
        // SAFETY: no preconditions.
        if unsafe { libc::getppid() } as u32 != parent {
            return Err(io::Error::other("the owner has exited"));
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod hold {
    use std::io;

    /// Registers the owner's exit with a kqueue, checks the owner is still the parent, then waits on a thread of its own
    /// that ends this process with no unwinding the moment the owner exits.
    pub(super) fn hold(parent: u32) -> io::Result<()> {
        let parent = parent as libc::pid_t;
        let watch = libc::kevent {
            ident: parent as usize,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ONESHOT,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        // SAFETY: kqueue and kevent on a descriptor and structures owned here; an owner already gone answers ESRCH.
        let queue = unsafe {
            let queue = libc::kqueue();
            if queue < 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::kevent(queue, &watch, 1, std::ptr::null_mut(), 0, std::ptr::null()) < 0 {
                let error = io::Error::last_os_error();
                libc::close(queue);
                return Err(error);
            }
            if libc::getppid() != parent {
                libc::close(queue);
                return Err(io::Error::other("the owner has exited"));
            }
            queue
        };
        let watching = std::thread::Builder::new().name("owner-watch".to_owned()).spawn(move || {
            // SAFETY: the registered queue and an event buffer owned here; `_exit` runs no destructor, which a build
            // blocked elsewhere could never finish.
            unsafe {
                let mut seen: libc::kevent = std::mem::zeroed();
                loop {
                    let count = libc::kevent(queue, std::ptr::null(), 0, &mut seen, 1, std::ptr::null());
                    if count > 0 || (count < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted) {
                        libc::_exit(1);
                    }
                }
            }
        });
        if let Err(error) = watching {
            // SAFETY: the queue is this function's, and no thread took it.
            unsafe { libc::close(queue) };
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(windows)]
mod hold {
    use std::io;

    use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
    use windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
    use windows_sys::Win32::System::JobObjects::JobObjectExtendedLimitInformation;
    use windows_sys::Win32::System::JobObjects::QueryInformationJobObject;

    /// The job this process was created in must end it when its owner's handle closes, and must let nothing break away.
    pub(super) fn hold(_parent: u32) -> io::Result<()> {
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // SAFETY: a null job is the one this process is in (the innermost when nested); `limits` is the out-parameter of
        // the size given.
        let ok = unsafe {
            QueryInformationJobObject(
                std::ptr::null_mut(),
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of_mut!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let flags = limits.BasicLimitInformation.LimitFlags;
        let breakaway = JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
        if flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE == 0 || flags & breakaway != 0 {
            return Err(io::Error::other("this process's job does not end it with its owner"));
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod hold {
    use std::io;

    pub(super) fn hold(_parent: u32) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "no owner watch on this platform"))
    }
}
