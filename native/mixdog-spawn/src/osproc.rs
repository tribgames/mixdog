//! The operating system's side of [`crate::tree`]: the process table, signals, exit events and
//! time. Linux reads `/proc` and waits on pidfds; macOS reads libproc. Other Unix platforms have
//! no process table adapter here, so a tree's survivors are not tracked there (see
//! [`TRACKING`]); nothing substitutes a process-group probe for the table.

use std::io;
use std::time::Duration;

use crate::tree::Clock;
use crate::tree::Identity;
use crate::tree::Reader;
use crate::tree::Signal;
use crate::tree::Signals;
use crate::tree::Table;

/// Whether this platform has a process table adapter, and so tracks survivors.
pub(crate) const TRACKING: bool = cfg!(any(target_os = "linux", target_os = "macos"));

pub(crate) struct TokioClock;

impl Clock for TokioClock {
    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

pub(crate) struct OsSignals;

impl OsSignals {
    fn send(target: libc::pid_t, signal: Signal) -> bool {
        let raw = match signal {
            Signal::Probe => 0,
            Signal::Term => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        };
        let sent = unsafe { libc::kill(target, raw) } == 0;
        // `groupAlive` / `isAlive`: a refusal means something is there, only ESRCH means nothing is.
        sent || (signal == Signal::Probe && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH))
    }
}

impl Signals for OsSignals {
    fn group(&self, pgid: u32, signal: Signal) -> bool {
        Self::send(-(pgid as libc::pid_t), signal)
    }

    fn process(&self, pid: u32, signal: Signal) -> bool {
        Self::send(pid as libc::pid_t, signal)
    }

    async fn exited(&self, watched: &[Identity]) -> bool {
        sys::exited(watched).await
    }
}

pub(crate) struct OsReader;

impl OsReader {
    /// The start token of `pid`, `None` when no live process has it.
    pub(crate) fn identity(pid: u32) -> io::Result<Option<String>> {
        sys::identity(pid)
    }
}

impl Reader for OsReader {
    fn table(&self) -> io::Result<Table> {
        sys::table()
    }
}

#[cfg(target_os = "linux")]
mod sys {
    use std::io;
    use std::os::fd::AsRawFd;
    use std::os::fd::FromRawFd;
    use std::os::fd::OwnedFd;
    use std::sync::Arc;
    use std::sync::OnceLock;

    use crate::tree::Identity;
    use crate::tree::Proc;
    use crate::tree::Table;

    /// `/proc/<pid>/stat` of a live (not zombie) process; `None` once there is no such process.
    pub(super) fn proc_of(pid: u32) -> io::Result<Option<Proc>> {
        let path = format!("/proc/{pid}/stat");
        let stat = match std::fs::read_to_string(&path) {
            Ok(stat) => stat,
            Err(error) if error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ESRCH) => {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let unreadable = || io::Error::new(io::ErrorKind::InvalidData, format!("{path} is not a process stat"));
        // The command name may hold spaces and parentheses: the fields follow the last ')'.
        let rest = stat.get(stat.rfind(')').ok_or_else(unreadable)? + 2..).ok_or_else(unreadable)?;
        let mut fields = rest.split(' ');
        let state = fields.next().ok_or_else(unreadable)?;
        let ppid = fields.next().ok_or_else(unreadable)?.parse().map_err(|_| unreadable())?;
        let pgid = fields.next().ok_or_else(unreadable)?.parse().map_err(|_| unreadable())?;
        // Fields 4..19 (session ... itrealvalue) follow the group; the 20th is the start time.
        let token = fields.nth(16).ok_or_else(unreadable)?.to_owned();
        Ok((state != "Z" && state != "X").then_some(Proc { pid, ppid, pgid, token }))
    }

    pub(super) fn table() -> io::Result<Table> {
        let mut procs = Vec::new();
        for entry in std::fs::read_dir("/proc")? {
            let entry = entry?;
            let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()) else {
                continue;
            };
            if let Some(proc) = proc_of(pid)? {
                procs.push(proc);
            }
        }
        Ok(Table::new(procs))
    }

    fn pidfd_open(pid: u32) -> Result<OwnedFd, i32> {
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
        if fd < 0 {
            return Err(io::Error::last_os_error().raw_os_error().unwrap_or(0));
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd as i32) })
    }

    fn pidfd_supported() -> bool {
        static SUPPORTED: OnceLock<bool> = OnceLock::new();
        *SUPPORTED.get_or_init(|| pidfd_open(std::process::id()).is_ok())
    }

    /// Wakes the blocked waiter when the future that started it is dropped.
    struct Cancel(Arc<OwnedFd>);

    impl Drop for Cancel {
        fn drop(&mut self) {
            let one = 1u64.to_ne_bytes();
            unsafe { libc::write(self.0.as_raw_fd(), one.as_ptr().cast(), one.len()) };
        }
    }

    /// Completes with `true` when one of `watched` has ended; `false` at once when it cannot wait
    /// (no pidfd, no thread, no descriptor): never "ended" for a wait that did not happen.
    pub(super) fn identity(pid: u32) -> io::Result<Option<String>> {
        Ok(proc_of(pid)?.map(|proc| proc.token))
    }

    pub(super) async fn exited(watched: &[Identity]) -> bool {
        if !pidfd_supported() {
            return false;
        }
        let raw = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC) };
        if raw < 0 {
            return false;
        }
        let cancel = Arc::new(unsafe { OwnedFd::from_raw_fd(raw) });
        let (done, finished) = tokio::sync::oneshot::channel();
        let waiter_fd = Arc::clone(&cancel);
        let watched = watched.to_vec();
        let spawned = std::thread::Builder::new().name("exit-wait".to_owned()).spawn(move || {
            let _ = done.send(block_until_exit(&watched, waiter_fd.as_raw_fd()));
        });
        if spawned.is_err() {
            return false;
        }
        let _wake_on_drop = Cancel(cancel);
        finished.await.unwrap_or(false)
    }

    fn block_until_exit(watched: &[Identity], cancel: i32) -> bool {
        let mut fds = vec![libc::pollfd { fd: cancel, events: libc::POLLIN, revents: 0 }];
        let mut open: Vec<OwnedFd> = Vec::new();
        for identity in watched {
            let fd = match pidfd_open(identity.pid) {
                Ok(fd) => fd,
                // Already gone.
                Err(libc::ESRCH) => return true,
                Err(_) => return false,
            };
            // Opened by pid, so it must still be the process that was seen.
            match proc_of(identity.pid) {
                Ok(Some(proc)) if proc.token == identity.token => {}
                Ok(_) => return true,
                Err(_) => return false,
            }
            fds.push(libc::pollfd { fd: fd.as_raw_fd(), events: libc::POLLIN, revents: 0 });
            open.push(fd);
        }
        loop {
            let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, -1) };
            if ready < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return ready > 0 && fds[1..].iter().any(|fd| fd.revents != 0);
        }
    }
}

#[cfg(target_os = "macos")]
mod sys {
    use std::io;

    use crate::tree::Identity;
    use crate::tree::Proc;
    use crate::tree::Table;

    /// `SZOMB` of `sys/proc.h`: a process that ended and awaits its reaper.
    const SZOMB: u32 = 5;

    pub(super) fn identity(pid: u32) -> io::Result<Option<String>> {
        Ok(proc_of(pid)?.map(|proc| proc.token))
    }

    /// There is no pidfd: an exit is found by looking again.
    pub(super) async fn exited(_watched: &[Identity]) -> bool {
        false
    }

    /// libproc's view of a live (not zombie) process; `None` once there is no such process, or when
    /// the kernel does not let us inspect it (none of our descendants is another user's).
    pub(super) fn proc_of(pid: u32) -> io::Result<Option<Proc>> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let got = unsafe {
            libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size)
        };
        if got <= 0 {
            let error = io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::ESRCH | libc::EPERM) => Ok(None),
                _ => Err(error),
            };
        }
        if got != size {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "a short process info"));
        }
        if info.pbi_status == SZOMB {
            return Ok(None);
        }
        Ok(Some(Proc {
            pid,
            ppid: info.pbi_ppid,
            pgid: info.pbi_pgid,
            token: format!("{}.{:06}", info.pbi_start_tvsec, info.pbi_start_tvusec),
        }))
    }

    pub(super) fn table() -> io::Result<Table> {
        let wanted = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if wanted <= 0 {
            return Err(io::Error::last_os_error());
        }
        // Room for processes that started since the count.
        let mut pids = vec![0 as libc::pid_t; wanted as usize + 64];
        let bytes = (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
        let got = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        if got <= 0 {
            return Err(io::Error::last_os_error());
        }
        pids.truncate(got as usize);
        let mut procs = Vec::new();
        for pid in pids.into_iter().filter(|&pid| pid > 0) {
            if let Some(proc) = proc_of(pid as u32)? {
                procs.push(proc);
            }
        }
        Ok(Table::new(procs))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod sys {
    use std::io;

    use crate::tree::Identity;
    use crate::tree::Table;

    pub(super) fn identity(_pid: u32) -> io::Result<Option<String>> {
        Ok(None)
    }

    pub(super) fn table() -> io::Result<Table> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "no process table adapter on this platform"))
    }

    pub(super) async fn exited(_watched: &[Identity]) -> bool {
        false
    }
}
