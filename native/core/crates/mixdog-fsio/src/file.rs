//! File handles. The call that opens one takes the proof; reading, writing and seeking go
//! through the `std::io` traits, as on the `std` handle.

use std::fs::FileTimes;
use std::fs::Metadata;
use std::fs::Permissions;
use std::fs::TryLockError;
use std::io;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::path::Path;
use std::time::SystemTime;

use crate::proof::ReadProof;
use crate::proof::WriteProof;

/// [`std::fs::File`].
#[derive(Debug)]
pub struct File(std::fs::File);

impl File {
    /// [`std::fs::File::open`].
    pub fn open<P: ReadProof>(_proof: &P, path: impl AsRef<Path>) -> io::Result<Self> {
        std::fs::File::open(path).map(Self)
    }

    /// [`std::fs::File::create`].
    pub fn create<P: WriteProof>(_proof: &P, path: impl AsRef<Path>) -> io::Result<Self> {
        std::fs::File::create(path).map(Self)
    }

    /// [`std::fs::File::create_new`].
    pub fn create_new<P: WriteProof>(_proof: &P, path: impl AsRef<Path>) -> io::Result<Self> {
        std::fs::File::create_new(path).map(Self)
    }

    /// [`std::fs::File::options`].
    pub fn options() -> OpenOptions {
        OpenOptions::new()
    }

    /// [`std::fs::File::metadata`].
    pub fn metadata<P: ReadProof>(&self, _proof: &P) -> io::Result<Metadata> {
        self.0.metadata()
    }

    /// [`std::fs::File::try_clone`].
    pub fn try_clone<P: ReadProof>(&self, _proof: &P) -> io::Result<Self> {
        self.0.try_clone().map(Self)
    }

    /// [`std::fs::File::sync_all`].
    pub fn sync_all<P: WriteProof>(&self, _proof: &P) -> io::Result<()> {
        self.0.sync_all()
    }

    /// [`std::fs::File::sync_data`].
    pub fn sync_data<P: WriteProof>(&self, _proof: &P) -> io::Result<()> {
        self.0.sync_data()
    }

    /// [`std::fs::File::set_len`].
    pub fn set_len<P: WriteProof>(&self, _proof: &P, size: u64) -> io::Result<()> {
        self.0.set_len(size)
    }

    /// [`std::fs::File::set_modified`].
    pub fn set_modified<P: WriteProof>(&self, _proof: &P, time: SystemTime) -> io::Result<()> {
        self.0.set_modified(time)
    }

    /// [`std::fs::File::set_times`].
    pub fn set_times<P: WriteProof>(&self, _proof: &P, times: FileTimes) -> io::Result<()> {
        self.0.set_times(times)
    }

    /// [`std::fs::File::set_permissions`].
    pub fn set_permissions<P: WriteProof>(&self, _proof: &P, permissions: Permissions) -> io::Result<()> {
        self.0.set_permissions(permissions)
    }

    /// [`std::fs::File::lock`].
    pub fn lock<P: WriteProof>(&self, _proof: &P) -> io::Result<()> {
        self.0.lock()
    }

    /// [`std::fs::File::lock_shared`].
    pub fn lock_shared<P: WriteProof>(&self, _proof: &P) -> io::Result<()> {
        self.0.lock_shared()
    }

    /// [`std::fs::File::try_lock`].
    pub fn try_lock<P: WriteProof>(&self, _proof: &P) -> Result<(), TryLockError> {
        self.0.try_lock()
    }

    /// [`std::fs::File::try_lock_shared`].
    pub fn try_lock_shared<P: WriteProof>(&self, _proof: &P) -> Result<(), TryLockError> {
        self.0.try_lock_shared()
    }

    /// [`std::fs::File::unlock`].
    pub fn unlock<P: WriteProof>(&self, _proof: &P) -> io::Result<()> {
        self.0.unlock()
    }

    /// The `std` handle, for a caller that hands it to an API that takes one.
    pub fn into_std(self) -> std::fs::File {
        self.0
    }

    /// Wraps a `std` handle that was opened elsewhere (a raw handle, an inherited descriptor).
    pub fn from_std(file: std::fs::File) -> Self {
        Self(file)
    }
}

impl Read for File {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

impl Read for &File {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        (&self.0).read(buf)
    }
}

impl Write for File {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

impl Write for &File {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        (&self.0).write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        (&self.0).flush()
    }
}

impl Seek for File {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.0.seek(pos)
    }
}

impl Seek for &File {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        (&self.0).seek(pos)
    }
}

#[cfg(windows)]
impl std::os::windows::io::AsRawHandle for File {
    fn as_raw_handle(&self) -> std::os::windows::io::RawHandle {
        std::os::windows::io::AsRawHandle::as_raw_handle(&self.0)
    }
}

#[cfg(windows)]
impl std::os::windows::io::FromRawHandle for File {
    unsafe fn from_raw_handle(handle: std::os::windows::io::RawHandle) -> Self {
        // SAFETY: the caller passes the ownership of a valid file handle, as `std` requires.
        Self(unsafe { <std::fs::File as std::os::windows::io::FromRawHandle>::from_raw_handle(handle) })
    }
}

#[cfg(unix)]
impl std::os::fd::AsRawFd for File {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        std::os::fd::AsRawFd::as_raw_fd(&self.0)
    }
}

/// [`std::fs::OpenOptions`]. Opening takes a write proof: the options do not say statically
/// whether the file is only read, and a read-only open is [`File::open`].
#[derive(Clone, Debug)]
pub struct OpenOptions(std::fs::OpenOptions);

impl OpenOptions {
    pub fn new() -> Self {
        Self(std::fs::OpenOptions::new())
    }

    pub fn read(&mut self, read: bool) -> &mut Self {
        self.0.read(read);
        self
    }

    pub fn write(&mut self, write: bool) -> &mut Self {
        self.0.write(write);
        self
    }

    pub fn append(&mut self, append: bool) -> &mut Self {
        self.0.append(append);
        self
    }

    pub fn truncate(&mut self, truncate: bool) -> &mut Self {
        self.0.truncate(truncate);
        self
    }

    pub fn create(&mut self, create: bool) -> &mut Self {
        self.0.create(create);
        self
    }

    pub fn create_new(&mut self, create_new: bool) -> &mut Self {
        self.0.create_new(create_new);
        self
    }

    /// The Unix mode of a created file (subject to the umask).
    #[cfg(unix)]
    pub fn mode(&mut self, mode: u32) -> &mut Self {
        std::os::unix::fs::OpenOptionsExt::mode(&mut self.0, mode);
        self
    }

    /// Windows `dwFlagsAndAttributes` bits of the open.
    #[cfg(windows)]
    pub fn custom_flags(&mut self, flags: u32) -> &mut Self {
        std::os::windows::fs::OpenOptionsExt::custom_flags(&mut self.0, flags);
        self
    }

    /// [`std::fs::OpenOptions::open`].
    pub fn open<P: WriteProof>(&self, _proof: &P, path: impl AsRef<Path>) -> io::Result<File> {
        self.0.open(path).map(File)
    }
}

impl Default for OpenOptions {
    fn default() -> Self {
        Self::new()
    }
}
