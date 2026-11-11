//! The Unix side of a text search's reads, and of the volume a path lies on.
//!
//! A descriptor whose read can wait forever (a FIFO, a socket, a terminal) is opened non-blocking and waited on with
//! `poll` beside its reading thread's [`Cancel`], so a cancel ends the wait: no signal, no process-wide disposition.
//! Anything else (a regular file, a directory, a block device) is read as `std` reads it; a read of that kind that
//! never returns (a file on a dead mount, in uninterruptible sleep) cannot be ended from outside and is given up
//! instead (localfs `Producers::give_up`).
//!
//! Only `std` and `libc`: the module compiles on its own for a Unix target (`rustc --crate-type lib`), which is how it
//! is compiled from a Windows machine.

use std::fs::File;
use std::io;
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::fd::FromRawFd;
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::FileTypeExt;
use std::path::Path;
use std::sync::Arc;

/// A reading thread's cancel: a pipe whose reading end becomes readable once [`Cancel::fire`] wrote to it, and stays
/// so (the byte is never read back), so a cancel that comes before the wait it ends is not lost.
pub struct Cancel {
    read: OwnedFd,
    write: OwnedFd,
}

impl Cancel {
    pub fn new() -> io::Result<Self> {
        let mut fds = [0 as libc::c_int; 2];
        // SAFETY: `fds` has room for the two descriptors the call writes.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: both descriptors were just created and nothing else owns them.
        let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        for fd in [&read, &write] {
            set_flag(fd.as_raw_fd(), libc::F_GETFD, libc::F_SETFD, libc::FD_CLOEXEC)?;
            set_flag(fd.as_raw_fd(), libc::F_GETFL, libc::F_SETFL, libc::O_NONBLOCK)?;
        }
        Ok(Self { read, write })
    }

    /// Ends every wait on this cancel, now and later. A full pipe (EAGAIN) has ended them already.
    pub fn fire(&self) {
        let byte = 1u8;
        // SAFETY: one byte from a valid buffer to a descriptor owned here.
        unsafe { libc::write(self.write.as_raw_fd(), (&raw const byte).cast(), 1) };
    }
}

/// Adds `flag` to the descriptor's flags read with `get` and written with `set`.
fn set_flag(fd: libc::c_int, get: libc::c_int, set: libc::c_int, flag: libc::c_int) -> io::Result<()> {
    // SAFETY: `fd` is an open descriptor; F_GETFD/F_GETFL take no argument and F_SETFD/F_SETFL an int.
    unsafe {
        let flags = libc::fcntl(fd, get);
        if flags < 0 || libc::fcntl(fd, set, flags | flag) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// A file opened for its search ([`open`]).
pub struct Opened {
    file: File,
    /// A FIFO, a socket or a terminal, open non-blocking: each read first waits with `poll`.
    pollable: bool,
    cancel: Option<Arc<Cancel>>,
}

/// Opens `path` to read it, as the search server opens it (`File::open`, serve_search/matching.rs:228), but
/// non-blocking: the open of a FIFO does not wait for a writer, its first read does (Linux reports no hang-up on a FIFO
/// until a writer came and went, `fifo_poll`), and so do the reads of a socket or a terminal, each a `poll` that
/// `cancel` ends. Any other file is put back to blocking reads.
pub fn open(path: &Path, cancel: Option<Arc<Cancel>>) -> io::Result<Opened> {
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let fd = loop {
        // SAFETY: `name` is a NUL-terminated path; a descriptor the call returns is owned by the File alone.
        let fd = unsafe { libc::open(name.as_ptr(), libc::O_RDONLY | libc::O_NONBLOCK | libc::O_CLOEXEC) };
        if fd >= 0 {
            break fd;
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    };
    // SAFETY: `fd` was just opened and nothing else owns it.
    let file = unsafe { File::from_raw_fd(fd) };
    let kind = file.metadata()?.file_type();
    let pollable = kind.is_fifo() || kind.is_socket() || kind.is_char_device();
    let opened = Opened { file, pollable, cancel };
    if !pollable {
        opened.blocking()?;
    }
    Ok(opened)
}

impl Opened {
    /// Puts the descriptor back to blocking reads.
    fn blocking(&self) -> io::Result<()> {
        let fd = self.file.as_raw_fd();
        // SAFETY: `fd` is open; F_GETFL takes no argument and F_SETFL an int.
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    /// Waits until the descriptor has something to read (bytes, its end, an error) or the cancel fired. A descriptor
    /// this platform cannot poll (macOS answers POLLNVAL for a terminal) is put back to blocking reads.
    fn wait(&mut self) -> io::Result<()> {
        let cancel = self.cancel.as_ref().map_or(-1, |c| c.read.as_raw_fd());
        let mut fds = [
            libc::pollfd { fd: self.file.as_raw_fd(), events: libc::POLLIN, revents: 0 },
            // A negative descriptor is skipped.
            libc::pollfd { fd: cancel, events: libc::POLLIN, revents: 0 },
        ];
        loop {
            // SAFETY: `fds` holds two pollfd entries; -1 waits without a timeout.
            let ready = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if fds[1].revents != 0 {
                return Err(io::Error::other("the search's read was cancelled"));
            }
            if fds[0].revents & libc::POLLNVAL != 0 {
                self.pollable = false;
                return self.blocking();
            }
            if fds[0].revents != 0 {
                return Ok(());
            }
        }
    }
}

impl Read for Opened {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            if !self.pollable {
                return self.file.read(buf);
            }
            self.wait()?;
            if !self.pollable {
                continue;
            }
            match self.file.read(buf) {
                Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) => {}
                read => return read,
            }
        }
    }
}

/// The volume `path` lies on: the device of the mount whose mount point is the longest prefix of `path` (Linux
/// `/proc/self/mountinfo`, its `major:minor`; macOS `getfsstat` with MNT_NOWAIT, the mounted device's name). Read from
/// the mount table, which never waits on a filesystem, so a dead mount cannot hold the caller. Empty when the table
/// cannot be read.
pub fn volume_of(path: &Path) -> String {
    #[cfg(target_os = "linux")]
    {
        let Ok(table) = std::fs::read_to_string("/proc/self/mountinfo") else { return String::new() };
        // `id parent major:minor root mount-point …`; a later line on the same point is mounted over the earlier.
        let mut best: Option<(usize, String)> = None;
        for line in table.lines() {
            let fields: Vec<&str> = line.split(' ').collect();
            let (Some(device), Some(point)) = (fields.get(2), fields.get(4)) else { continue };
            let point = unescape_mount_point(point);
            if path.starts_with(&point) {
                let depth = Path::new(&point).components().count();
                if best.as_ref().is_none_or(|(d, _)| depth >= *d) {
                    best = Some((depth, (*device).to_owned()));
                }
            }
        }
        best.map(|(_, device)| device).unwrap_or_default()
    }
    #[cfg(target_os = "macos")]
    {
        // SAFETY: with a null buffer the call only counts the mounts.
        let count = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
        if count <= 0 {
            return String::new();
        }
        let room = count as usize + 8;
        // SAFETY: statfs is plain data; a zeroed one is valid.
        let mut mounts: Vec<libc::statfs> = (0..room).map(|_| unsafe { std::mem::zeroed() }).collect();
        let bytes = (room * std::mem::size_of::<libc::statfs>()) as libc::c_int;
        // SAFETY: `mounts` has room for `bytes` bytes of entries.
        let got = unsafe { libc::getfsstat(mounts.as_mut_ptr(), bytes, libc::MNT_NOWAIT) };
        if got <= 0 {
            return String::new();
        }
        mounts.truncate(got as usize);
        let mut best: Option<(usize, String)> = None;
        for mount in &mounts {
            // SAFETY: the kernel writes NUL-terminated names into these arrays.
            let (point, device) = unsafe {
                (
                    std::ffi::CStr::from_ptr(mount.f_mntonname.as_ptr()).to_string_lossy().into_owned(),
                    std::ffi::CStr::from_ptr(mount.f_mntfromname.as_ptr()).to_string_lossy().into_owned(),
                )
            };
            if path.starts_with(&point) {
                let depth = Path::new(&point).components().count();
                if best.as_ref().is_none_or(|(d, _)| depth >= *d) {
                    best = Some((depth, device));
                }
            }
        }
        best.map(|(_, device)| device).unwrap_or_default()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = path;
        String::new()
    }
}

/// A mount point as mountinfo writes it: a space, a tab, a newline and a backslash as `\` and three octal digits.
#[cfg(target_os = "linux")]
fn unescape_mount_point(field: &str) -> String {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let octal = bytes.get(i + 1..i + 4).filter(|d| bytes[i] == b'\\' && d.iter().all(|b| (b'0'..=b'7').contains(b)));
        match octal {
            Some(d) => {
                out.push((d[0] - b'0') * 64 + (d[1] - b'0') * 8 + (d[2] - b'0'));
                i += 4;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    /// A folder of its own under the temp folder, removed when dropped.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("mixdog-unix-io-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn fifo(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            let c = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
            // SAFETY: a NUL-terminated path.
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "{}", io::Error::last_os_error());
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A regular file reads as `std` reads it, whole.
    #[test]
    fn a_regular_file_reads_whole() {
        let dir = Scratch::new("regular");
        let path = dir.0.join("a.txt");
        std::fs::write(&path, b"needle one\nneedle two\n").unwrap();
        let mut text = String::new();
        open(&path, Some(Arc::new(Cancel::new().unwrap()))).unwrap().read_to_string(&mut text).unwrap();
        assert_eq!(text, "needle one\nneedle two\n");
    }

    /// The read of a FIFO no one writes waits (its open does not), and its cancel ends the wait with an error; a cancel
    /// fired before the read ends it too.
    #[test]
    fn a_fifo_no_one_writes_is_waited_on_until_its_cancel() {
        let dir = Scratch::new("cancel");
        let fifo = dir.fifo("held");
        let cancel = Arc::new(Cancel::new().unwrap());
        let mut opened = open(&fifo, Some(cancel.clone())).unwrap();
        let (done, read) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut buf = [0; 16];
            let _ = done.send(opened.read(&mut buf).map_err(|e| e.to_string()));
        });
        assert!(read.recv_timeout(Duration::from_millis(200)).is_err(), "the read waits for a writer");
        cancel.fire();
        let result = read.recv_timeout(Duration::from_secs(10)).expect("the cancel ends the read within 10 s");
        assert_eq!(result, Err("the search's read was cancelled".to_owned()));
        reader.join().unwrap();
        let mut again = open(&fifo, Some(cancel)).unwrap();
        assert!(again.read(&mut [0; 16]).is_err(), "a fired cancel ends the next wait at once");
    }

    /// A FIFO's read gets what its writer writes, then its end once the writer closes.
    #[test]
    fn a_fifo_reads_its_writers_bytes_and_its_end() {
        let dir = Scratch::new("written");
        let fifo = dir.fifo("data");
        let mut opened = open(&fifo, Some(Arc::new(Cancel::new().unwrap()))).unwrap();
        let writer_path = fifo.clone();
        let writer = std::thread::spawn(move || {
            let mut writer = std::fs::OpenOptions::new().write(true).open(writer_path).unwrap();
            writer.write_all(b"needle held\n").unwrap();
        });
        let mut text = String::new();
        opened.read_to_string(&mut text).unwrap();
        writer.join().unwrap();
        assert_eq!(text, "needle held\n");
    }

    /// A path and a file under it lie on one volume, read from the mount table.
    #[test]
    fn a_folder_and_its_file_lie_on_one_volume() {
        let dir = Scratch::new("volume");
        let volume = volume_of(&dir.0);
        assert_eq!(volume_of(&dir.0.join("a.txt")), volume);
        if cfg!(any(target_os = "linux", target_os = "macos")) {
            assert!(!volume.is_empty(), "the mount table names {}'s volume", dir.0.display());
        }
    }
}
