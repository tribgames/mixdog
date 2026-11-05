//! The locked data directory (LR §2.3). On Unix every access is relative to the
//! `O_DIRECTORY` handle opened at boot (`openat`/`renameat`/`unlinkat`), so a
//! renamed or replaced directory never mixes two cores' files. On Windows the
//! lock handle pins the directory and its ancestors, so absolute paths name the
//! same directory; renames are write-through, which is the durable rename there.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "blocking file bodies: data-dir access backs the synchronous Ownership contract and runs at startup or inside the caller's lane job"
)]

use std::io;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EntryKind {
    File,
    Dir,
    Other,
}

pub struct DataDir {
    path: PathBuf,
    #[cfg(unix)]
    fd: std::os::fd::OwnedFd,
}

fn absent_as_none<T>(result: io::Result<T>) -> io::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

impl DataDir {
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The bytes of `name`, or `None` when it does not exist.
    pub fn read(&self, name: &str) -> io::Result<Option<Vec<u8>>> {
        absent_as_none(self.open_read(name).and_then(|mut file| {
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            Ok(bytes)
        }))
    }

    /// Creates `name` exclusively with owner-only permissions, writes `bytes`
    /// and syncs the file.
    pub fn create_new(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        let mut file = self.open_create_new(name)?;
        file.write_all(bytes)?;
        file.sync_all()
    }

    /// Removes `name` when it exists.
    pub fn remove_if_exists(&self, name: &str) -> io::Result<()> {
        absent_as_none(self.unlink(name)).map(|_| ())
    }

    /// Appends one line to `<subdir>/<name>` (both created when missing) and
    /// syncs it, including the directory entries a creation added.
    pub fn append_line(&self, subdir: &str, name: &str, line: &str) -> io::Result<()> {
        let created_dir = self.mkdir_if_missing(subdir)?;
        let (mut file, created_file) = self.open_append(subdir, name)?;
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        file.write_all(&bytes)?;
        file.sync_all()?;
        if created_file {
            self.sync_subdir(subdir)?;
        }
        if created_dir {
            self.sync()?;
        }
        Ok(())
    }
}

#[cfg(unix)]
mod imp {
    use std::ffi::CString;
    use std::fs::File;
    use std::io;
    use std::os::fd::AsRawFd;
    use std::os::fd::FromRawFd;
    use std::os::fd::OwnedFd;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    use super::DataDir;
    use super::EntryKind;

    fn cstr(name: &str) -> io::Result<CString> {
        CString::new(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
    }

    pub(crate) fn cvt(ret: libc::c_int) -> io::Result<libc::c_int> {
        if ret < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(ret)
        }
    }

    /// `(st_dev, st_ino)`; the field types differ between Linux and macOS.
    #[allow(clippy::unnecessary_cast)]
    pub(crate) fn file_id(stat: &libc::stat) -> (u64, u64) {
        (stat.st_dev as u64, stat.st_ino as u64)
    }

    impl DataDir {
        pub(crate) fn open(path: &Path) -> io::Result<Self> {
            let c = CString::new(path.as_os_str().as_bytes())
                .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
            // SAFETY: `c` is a valid NUL-terminated path.
            let fd = cvt(unsafe {
                libc::open(
                    c.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
                )
            })?;
            Ok(Self {
                path: path.to_path_buf(),
                // SAFETY: `fd` was just opened and is owned here.
                fd: unsafe { OwnedFd::from_raw_fd(fd) },
            })
        }

        pub(crate) fn raw_fd(&self) -> libc::c_int {
            self.fd.as_raw_fd()
        }

        pub(crate) fn openat(
            &self,
            name: &str,
            flags: libc::c_int,
            mode: libc::mode_t,
        ) -> io::Result<OwnedFd> {
            let c = cstr(name)?;
            // SAFETY: valid directory fd and NUL-terminated name.
            let fd = cvt(unsafe {
                libc::openat(
                    self.raw_fd(),
                    c.as_ptr(),
                    flags | libc::O_CLOEXEC,
                    libc::c_uint::from(mode),
                )
            })?;
            // SAFETY: `fd` was just opened and is owned here.
            Ok(unsafe { OwnedFd::from_raw_fd(fd) })
        }

        pub(super) fn open_read(&self, name: &str) -> io::Result<File> {
            Ok(File::from(self.openat(
                name,
                libc::O_RDONLY | libc::O_NOFOLLOW,
                0,
            )?))
        }

        pub(super) fn open_create_new(&self, name: &str) -> io::Result<File> {
            let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW;
            Ok(File::from(self.openat(name, flags, 0o600)?))
        }

        /// `(dev, ino)` of `name`, not following a symlink.
        pub(crate) fn stat_at(&self, name: &str) -> io::Result<libc::stat> {
            let c = cstr(name)?;
            // SAFETY: zeroed `stat` is a valid out-parameter.
            let mut stat: libc::stat = unsafe { std::mem::zeroed() };
            // SAFETY: valid fd, name and out-pointer.
            cvt(unsafe {
                libc::fstatat(
                    self.raw_fd(),
                    c.as_ptr(),
                    &mut stat,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            })?;
            Ok(stat)
        }

        pub fn kind(&self, name: &str) -> io::Result<Option<EntryKind>> {
            super::absent_as_none(self.stat_at(name)).map(|stat| {
                stat.map(|stat| match stat.st_mode & libc::S_IFMT {
                    libc::S_IFREG => EntryKind::File,
                    libc::S_IFDIR => EntryKind::Dir,
                    _ => EntryKind::Other,
                })
            })
        }

        /// Whether the directory `name` has no entries besides `.` and `..`.
        pub fn is_empty_dir(&self, name: &str) -> io::Result<bool> {
            let fd = self.openat(
                name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
                0,
            )?;
            let raw = std::os::fd::IntoRawFd::into_raw_fd(fd);
            // SAFETY: `raw` is an owned directory fd; fdopendir takes it over.
            let stream = unsafe { libc::fdopendir(raw) };
            if stream.is_null() {
                let error = io::Error::last_os_error();
                // SAFETY: fdopendir failed, so `raw` is still ours to close.
                unsafe { libc::close(raw) };
                return Err(error);
            }
            let mut empty = true;
            loop {
                // SAFETY: `stream` is a valid open directory stream.
                let entry = unsafe { libc::readdir(stream) };
                if entry.is_null() {
                    break;
                }
                // SAFETY: readdir returned a valid entry with a NUL-terminated name.
                let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
                if name.to_bytes() != b"." && name.to_bytes() != b".." {
                    empty = false;
                    break;
                }
            }
            // SAFETY: `stream` is valid and closed once.
            unsafe { libc::closedir(stream) };
            Ok(empty)
        }

        pub fn link(&self, from: &str, to: &str) -> io::Result<()> {
            let (from, to) = (cstr(from)?, cstr(to)?);
            // SAFETY: valid fds and names.
            cvt(unsafe {
                libc::linkat(self.raw_fd(), from.as_ptr(), self.raw_fd(), to.as_ptr(), 0)
            })
            .map(|_| ())
        }

        /// Atomic rename-replace inside the directory.
        pub fn rename(&self, from: &str, to: &str) -> io::Result<()> {
            let (from, to) = (cstr(from)?, cstr(to)?);
            // SAFETY: valid fds and names.
            cvt(unsafe { libc::renameat(self.raw_fd(), from.as_ptr(), self.raw_fd(), to.as_ptr()) })
                .map(|_| ())
        }

        pub fn unlink(&self, name: &str) -> io::Result<()> {
            let c = cstr(name)?;
            // SAFETY: valid fd and name.
            cvt(unsafe { libc::unlinkat(self.raw_fd(), c.as_ptr(), 0) }).map(|_| ())
        }

        pub fn rmdir(&self, name: &str) -> io::Result<()> {
            let c = cstr(name)?;
            // SAFETY: valid fd and name.
            cvt(unsafe { libc::unlinkat(self.raw_fd(), c.as_ptr(), libc::AT_REMOVEDIR) })
                .map(|_| ())
        }

        /// fsync of the directory: makes created, renamed and removed entries durable.
        pub fn sync(&self) -> io::Result<()> {
            // SAFETY: valid fd.
            cvt(unsafe { libc::fsync(self.raw_fd()) }).map(|_| ())
        }

        pub(super) fn mkdir_if_missing(&self, name: &str) -> io::Result<bool> {
            let c = cstr(name)?;
            // SAFETY: valid fd and name.
            match cvt(unsafe { libc::mkdirat(self.raw_fd(), c.as_ptr(), 0o700) }) {
                Ok(_) => Ok(true),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
                Err(error) => Err(error),
            }
        }

        fn subdir(&self, subdir: &str) -> io::Result<OwnedFd> {
            self.openat(
                subdir,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
                0,
            )
        }

        pub(super) fn open_append(&self, subdir: &str, name: &str) -> io::Result<(File, bool)> {
            let dir = self.subdir(subdir)?;
            let c = cstr(name)?;
            let open = |flags: libc::c_int| {
                // SAFETY: valid fd and name.
                cvt(unsafe {
                    libc::openat(
                        dir.as_raw_fd(),
                        c.as_ptr(),
                        flags
                            | libc::O_WRONLY
                            | libc::O_APPEND
                            | libc::O_NOFOLLOW
                            | libc::O_CLOEXEC,
                        0o600 as libc::c_uint,
                    )
                })
            };
            let (fd, created) = match open(libc::O_CREAT | libc::O_EXCL) {
                Ok(fd) => (fd, true),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (open(0)?, false),
                Err(error) => return Err(error),
            };
            // SAFETY: `fd` was just opened and is owned here.
            Ok((unsafe { File::from_raw_fd(fd) }, created))
        }

        pub(super) fn sync_subdir(&self, subdir: &str) -> io::Result<()> {
            File::from(self.subdir(subdir)?).sync_all()
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::fs::File;
    use std::fs::OpenOptions;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING;
    use windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    use super::DataDir;
    use super::EntryKind;

    pub(crate) fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    impl DataDir {
        pub(crate) fn open(path: &Path) -> io::Result<Self> {
            if !std::fs::metadata(path)?.is_dir() {
                return Err(io::Error::from(io::ErrorKind::NotADirectory));
            }
            Ok(Self {
                path: path.to_path_buf(),
            })
        }

        pub(super) fn open_read(&self, name: &str) -> io::Result<File> {
            File::open(self.path.join(name))
        }

        pub(super) fn open_create_new(&self, name: &str) -> io::Result<File> {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(self.path.join(name))
        }

        pub fn kind(&self, name: &str) -> io::Result<Option<EntryKind>> {
            super::absent_as_none(std::fs::symlink_metadata(self.path.join(name))).map(|meta| {
                meta.map(|meta| {
                    let kind = meta.file_type();
                    if kind.is_symlink() {
                        EntryKind::Other
                    } else if kind.is_dir() {
                        EntryKind::Dir
                    } else {
                        EntryKind::File
                    }
                })
            })
        }

        /// Whether the directory `name` has no entries.
        pub fn is_empty_dir(&self, name: &str) -> io::Result<bool> {
            Ok(std::fs::read_dir(self.path.join(name))?.next().is_none())
        }

        pub fn link(&self, from: &str, to: &str) -> io::Result<()> {
            std::fs::hard_link(self.path.join(from), self.path.join(to))
        }

        /// Atomic, write-through rename-replace (`MoveFileExW`).
        pub fn rename(&self, from: &str, to: &str) -> io::Result<()> {
            let (from, to) = (wide(&self.path.join(from)), wide(&self.path.join(to)));
            // SAFETY: both paths are NUL-terminated wide strings.
            let ok = unsafe {
                MoveFileExW(
                    from.as_ptr(),
                    to.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            };
            if ok == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }

        pub fn unlink(&self, name: &str) -> io::Result<()> {
            std::fs::remove_file(self.path.join(name))
        }

        pub fn rmdir(&self, name: &str) -> io::Result<()> {
            std::fs::remove_dir(self.path.join(name))
        }

        /// Every rename here is write-through; entry creation needs no directory flush.
        pub fn sync(&self) -> io::Result<()> {
            Ok(())
        }

        pub(super) fn mkdir_if_missing(&self, name: &str) -> io::Result<bool> {
            match std::fs::create_dir(self.path.join(name)) {
                Ok(()) => Ok(true),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
                Err(error) => Err(error),
            }
        }

        pub(super) fn open_append(&self, subdir: &str, name: &str) -> io::Result<(File, bool)> {
            let path = self.path.join(subdir).join(name);
            match OpenOptions::new().append(true).create_new(true).open(&path) {
                Ok(file) => Ok((file, true)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    Ok((OpenOptions::new().append(true).open(&path)?, false))
                }
                Err(error) => Err(error),
            }
        }

        pub(super) fn sync_subdir(&self, _subdir: &str) -> io::Result<()> {
            Ok(())
        }
    }
}

#[cfg(unix)]
pub(crate) use imp::cvt;
#[cfg(unix)]
pub(crate) use imp::file_id;
#[cfg(windows)]
pub(crate) use imp::wide;
