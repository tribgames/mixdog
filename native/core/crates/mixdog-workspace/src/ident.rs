#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread")]
//! File identity (volume + file index): the same through every hard link.
//! One definition for claims, recovery journals and transfer versions.

use std::fs::File;
use std::fs::Metadata;
use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FileId {
    pub volume: u64,
    pub index: u128,
}

impl FileId {
    pub fn key(&self) -> String {
        format!("{}:{}", self.volume, self.index)
    }
}

/// Identity, size and modification time of an open file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileVersion {
    pub id: FileId,
    pub size: u64,
    pub mtime_ns: i128,
}

pub fn mtime_ns(meta: &Metadata) -> i128 {
    meta.modified()
        .ok()
        .map(|t| match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_nanos() as i128,
            Err(e) => -(e.duration().as_nanos() as i128),
        })
        .unwrap_or(0)
}

pub fn mtime_ms(meta: &Metadata) -> f64 {
    mtime_ns(meta) as f64 / 1_000_000.0
}

#[cfg(unix)]
pub fn file_id(file: &File) -> io::Result<FileId> {
    use std::os::unix::fs::MetadataExt;
    let m = file.metadata()?;
    Ok(FileId { volume: m.dev(), index: m.ino() as u128 })
}

#[cfg(windows)]
pub fn file_id(file: &File) -> io::Result<FileId> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION;
    use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
    // SAFETY: the handle is open for the duration of the call and `info` is a plain out struct.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(FileId {
        volume: u64::from(info.dwVolumeSerialNumber),
        index: (u128::from(info.nFileIndexHigh) << 32) | u128::from(info.nFileIndexLow),
    })
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use super::*;

    #[test]
    fn one_platform_rule_decides_name_equality() {
        // Node lowercases the lock key on win32 only (`path-locks.mjs:7`) and compares exactly elsewhere.
        assert_eq!(names_equal(OsStr::new("C:\\D\\foo.TXT"), OsStr::new("c:\\d\\FOO.txt")), cfg!(windows));
        assert_eq!(names_equal(OsStr::new("foo.TXT"), OsStr::new("FOO.txt")), cfg!(windows));
        assert_eq!(names_equal(OsStr::new("é"), OsStr::new("É")), cfg!(windows));
        assert!(!names_equal(OsStr::new("foo"), OsStr::new("foo2")));
        assert!(names_equal(OsStr::new("foo"), OsStr::new("foo")));
        assert!(!names_equal(OsStr::new("a"), OsStr::new("b")));
    }
}

pub fn file_version(file: &File) -> io::Result<FileVersion> {
    let meta = file.metadata()?;
    Ok(FileVersion { id: file_id(file)?, size: meta.len(), mtime_ns: mtime_ns(&meta) })
}

/// Node's `fileVersion` (`file-version.mjs`): mtime, ctime, size, inode and device of the path
/// (symlinks followed, like `fs.stat`). Two versions are the same file state only when all five agree.
/// On Windows the inode and device are the file index and volume serial, as libuv reports them, and
/// the ctime is the NTFS change time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StatVersion {
    pub mtime_ns: i128,
    pub ctime_ns: i128,
    pub size: u64,
    pub ino: u128,
    pub dev: u64,
}

#[cfg(unix)]
pub fn stat_version(path: &Path) -> io::Result<StatVersion> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path)?;
    Ok(StatVersion {
        mtime_ns: i128::from(m.mtime()) * 1_000_000_000 + i128::from(m.mtime_nsec()),
        ctime_ns: i128::from(m.ctime()) * 1_000_000_000 + i128::from(m.ctime_nsec()),
        size: m.len(),
        ino: u128::from(m.ino()),
        dev: m.dev(),
    })
}

#[cfg(windows)]
pub fn stat_version(path: &Path) -> io::Result<StatVersion> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::FILE_BASIC_INFO;
    use windows_sys::Win32::Storage::FileSystem::FileBasicInfo;
    use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandleEx;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_BACKUP_SEMANTICS, as in `path_id`; the default share mode lets a writer coexist.
        options.custom_flags(0x0200_0000);
    }
    let file = options.open(path)?;
    let id = file_id(&file)?;
    // SAFETY: the handle is open for the call and `info` is a plain out struct of the stated size.
    let mut info: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as _,
            FileBasicInfo,
            std::ptr::addr_of_mut!(info).cast(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // 100 ns ticks since 1601-01-01 to ns since the Unix epoch.
    let ticks = |t: i64| (i128::from(t) - 116_444_736_000_000_000) * 100;
    Ok(StatVersion { mtime_ns: ticks(info.LastWriteTime), ctime_ns: ticks(info.ChangeTime), size: file.metadata()?.len(), ino: id.index, dev: id.volume })
}

/// Whether two paths name the same file for write serialization. Node's write-lock key is the
/// resolved path text, lowercased on win32 only and exact elsewhere
/// (`tools/builtin/path-locks.mjs:5-7`, `advisory-lock.mjs:47`); one rule, no probing.
pub fn names_equal(a: &std::ffi::OsStr, b: &std::ffi::OsStr) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// Opens `path` (file or directory) only to read its identity.
pub fn path_id(path: &Path) -> io::Result<FileId> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_BACKUP_SEMANTICS: lets a directory be opened.
        options.custom_flags(0x0200_0000);
    }
    file_id(&options.open(path)?)
}
