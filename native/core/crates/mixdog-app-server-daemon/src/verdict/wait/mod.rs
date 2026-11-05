//! Waiting on facts, never on time: a process exit confirmed by the OS, a
//! change in the data directory, or an interrupt from the management path.
//! Every wait has no timeout.

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

use std::io;

#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
use windows as sys;

use super::ProcessIdentity;
use crate::ownership::DataDir;

/// Wakes a blocked wait from another thread (a management decision). A
/// signal sent before the wait starts is kept until a wait consumes it.
pub struct Interrupt(sys::Event);

impl Interrupt {
    pub fn new() -> io::Result<Self> {
        sys::Event::new().map(Self)
    }

    pub fn signal(&self) -> io::Result<()> {
        self.0.signal()
    }
}

/// A change notification on the data directory, armed before the facts it
/// guards are read, so no change between the read and the wait is missed.
pub(crate) struct DirWatch(sys::DirWatch);

impl DirWatch {
    pub(crate) fn arm(dir: &DataDir) -> io::Result<Self> {
        sys::DirWatch::arm(dir).map(Self)
    }
}

/// An OS exit notification for one process identity, registered before the
/// identity is re-checked: the Windows process handle, a Linux pidfd, a macOS
/// `EVFILT_PROC NOTE_EXIT`.
pub(crate) struct ExitWatch(sys::ExitWatch);

impl ExitWatch {
    /// `None` when the identified process has already exited.
    pub(crate) fn open(identity: ProcessIdentity) -> io::Result<Option<Self>> {
        #[cfg(test)]
        if crate::verdict::tests::exit_watch_denied() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "exit watch denied by the test",
            ));
        }
        Ok(sys::ExitWatch::open(identity)?.map(Self))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wake {
    /// The watched process exited (OS-confirmed).
    Exited,
    /// The data directory changed.
    Changed,
    /// [`Interrupt::signal`].
    Interrupted,
}

/// Blocks until one of the given sources fires. Exit wins over a change, a
/// change over an interrupt; an interrupt not reported stays pending.
pub(crate) fn wait(
    interrupt: &Interrupt,
    dir: Option<&DirWatch>,
    exit: Option<&ExitWatch>,
) -> io::Result<Wake> {
    sys::wait(
        &interrupt.0,
        dir.map(|watch| &watch.0),
        exit.map(|watch| &watch.0),
    )
}
