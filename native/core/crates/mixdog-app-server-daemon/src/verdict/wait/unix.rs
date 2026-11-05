use std::io;
use std::os::fd::AsRawFd;
use std::os::fd::FromRawFd;
use std::os::fd::OwnedFd;

use super::Wake;
use crate::ownership::DataDir;
use crate::ownership::cvt;
use crate::verdict::ProcessIdentity;
use crate::verdict::process::start_ms;

fn owned(fd: libc::c_int) -> io::Result<OwnedFd> {
    let fd = cvt(fd)?;
    // SAFETY: `fd` was just created and is owned from here on.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn set_flags(fd: &OwnedFd) -> io::Result<()> {
    // SAFETY: valid fd; plain flag updates.
    unsafe {
        cvt(libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC))?;
        let flags = cvt(libc::fcntl(fd.as_raw_fd(), libc::F_GETFL))?;
        cvt(libc::fcntl(
            fd.as_raw_fd(),
            libc::F_SETFL,
            flags | libc::O_NONBLOCK,
        ))?;
    }
    Ok(())
}

/// A self-pipe: signalled while it holds a byte; a reported wake drains it.
pub(super) struct Event {
    read: OwnedFd,
    write: OwnedFd,
}

impl Event {
    pub(super) fn new() -> io::Result<Self> {
        let mut fds = [0 as libc::c_int; 2];
        // SAFETY: `fds` has room for both ends.
        cvt(unsafe { libc::pipe(fds.as_mut_ptr()) })?;
        // SAFETY: both ends were just created and are owned from here on.
        let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        set_flags(&read)?;
        set_flags(&write)?;
        Ok(Self { read, write })
    }

    pub(super) fn signal(&self) -> io::Result<()> {
        // SAFETY: valid fd and a one-byte buffer.
        let ret = unsafe { libc::write(self.write.as_raw_fd(), [1u8].as_ptr().cast(), 1) };
        if ret < 0 {
            let error = io::Error::last_os_error();
            // A full pipe is already signalled.
            if error.kind() != io::ErrorKind::WouldBlock {
                return Err(error);
            }
        }
        Ok(())
    }

    fn drain(&self) {
        let mut buffer = [0u8; 64];
        // SAFETY: valid fd and buffer; the pipe is non-blocking.
        while unsafe {
            libc::read(
                self.read.as_raw_fd(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
            )
        } > 0
        {}
    }
}

pub(super) struct DirWatch {
    fd: OwnedFd,
    #[cfg(target_os = "macos")]
    _dir: OwnedFd,
}

#[cfg(target_os = "linux")]
impl DirWatch {
    pub(super) fn arm(dir: &DataDir) -> io::Result<Self> {
        // SAFETY: plain FFI call.
        let fd = owned(unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) })?;
        // The locked directory itself, by its handle.
        let path =
            std::ffi::CString::new(format!("/proc/self/fd/{}", dir.raw_fd())).expect("no NUL");
        let mask = libc::IN_CREATE
            | libc::IN_DELETE
            | libc::IN_MOVED_FROM
            | libc::IN_MOVED_TO
            | libc::IN_CLOSE_WRITE
            | libc::IN_ATTRIB
            | libc::IN_DELETE_SELF
            | libc::IN_MOVE_SELF;
        // SAFETY: valid inotify fd and path.
        cvt(unsafe { libc::inotify_add_watch(fd.as_raw_fd(), path.as_ptr(), mask) })?;
        Ok(Self { fd })
    }
}

#[cfg(target_os = "macos")]
fn kevent_register(kq: &OwnedFd, event: libc::kevent) -> io::Result<()> {
    // SAFETY: one change, no event buffer.
    cvt(unsafe {
        libc::kevent(
            kq.as_raw_fd(),
            &event,
            1,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
        )
    })
    .map(|_| ())
}

#[cfg(target_os = "macos")]
impl DirWatch {
    pub(super) fn arm(dir: &DataDir) -> io::Result<Self> {
        let dir_fd = dir.openat(".", libc::O_EVTONLY, 0)?;
        // SAFETY: plain FFI call.
        let kq = owned(unsafe { libc::kqueue() })?;
        kevent_register(
            &kq,
            libc::kevent {
                ident: dir_fd.as_raw_fd() as libc::uintptr_t,
                filter: libc::EVFILT_VNODE,
                flags: libc::EV_ADD | libc::EV_CLEAR,
                fflags: libc::NOTE_WRITE
                    | libc::NOTE_DELETE
                    | libc::NOTE_RENAME
                    | libc::NOTE_ATTRIB
                    | libc::NOTE_EXTEND
                    | libc::NOTE_LINK,
                data: 0,
                udata: std::ptr::null_mut(),
            },
        )?;
        Ok(Self {
            fd: kq,
            _dir: dir_fd,
        })
    }
}

pub(super) struct ExitWatch {
    fd: OwnedFd,
}

impl ExitWatch {
    pub(super) fn open(identity: ProcessIdentity) -> io::Result<Option<Self>> {
        let Some(fd) = Self::register(identity.pid)? else {
            return Ok(None);
        };
        // Registered first, then the identity: a reused pid is never watched.
        Ok((start_ms(identity.pid)? == Some(identity.start_ms)).then_some(Self { fd }))
    }

    #[cfg(target_os = "linux")]
    fn register(pid: u32) -> io::Result<Option<OwnedFd>> {
        // SAFETY: plain syscall.
        match owned(
            unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::c_int, 0) } as libc::c_int,
        ) {
            Ok(fd) => Ok(Some(fd)),
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(None),
            Err(error) => Err(error),
        }
    }

    #[cfg(target_os = "macos")]
    fn register(pid: u32) -> io::Result<Option<OwnedFd>> {
        // SAFETY: plain FFI call.
        let kq = owned(unsafe { libc::kqueue() })?;
        let event = libc::kevent {
            ident: pid as libc::uintptr_t,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ONESHOT,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        match kevent_register(&kq, event) {
            Ok(()) => Ok(Some(kq)),
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

pub(super) fn wait(
    event: &Event,
    dir: Option<&DirWatch>,
    exit: Option<&ExitWatch>,
) -> io::Result<Wake> {
    let mut sources: Vec<(libc::c_int, Wake)> = Vec::with_capacity(3);
    if let Some(exit) = exit {
        sources.push((exit.fd.as_raw_fd(), Wake::Exited));
    }
    if let Some(dir) = dir {
        sources.push((dir.fd.as_raw_fd(), Wake::Changed));
    }
    sources.push((event.read.as_raw_fd(), Wake::Interrupted));
    let mut fds: Vec<libc::pollfd> = sources
        .iter()
        .map(|(fd, _)| libc::pollfd {
            fd: *fd,
            events: libc::POLLIN,
            revents: 0,
        })
        .collect();
    loop {
        // SAFETY: `fds` holds `fds.len()` valid entries.
        let ret = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, -1) };
        if ret < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        let Some(index) = fds.iter().position(|fd| fd.revents != 0) else {
            continue;
        };
        let wake = sources[index].1;
        if wake == Wake::Interrupted {
            event.drain();
        }
        return Ok(wake);
    }
}
