//! The free functions of `std::fs` and the disk-touching methods of `Path`, behind a proof.

use std::fs::Metadata;
use std::fs::Permissions;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use crate::dir::ReadDir;
use crate::proof::ReadProof;
use crate::proof::WriteProof;

/// [`std::fs::read`].
pub fn read<P: ReadProof>(_proof: &P, path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
    std::fs::read(path)
}

/// [`std::fs::read_to_string`].
pub fn read_to_string<P: ReadProof>(_proof: &P, path: impl AsRef<Path>) -> io::Result<String> {
    std::fs::read_to_string(path)
}

/// [`std::fs::read_dir`].
pub fn read_dir<P: ReadProof>(_proof: &P, path: impl AsRef<Path>) -> io::Result<ReadDir> {
    std::fs::read_dir(path).map(ReadDir::from_std)
}

/// [`std::fs::read_link`].
pub fn read_link<P: ReadProof>(_proof: &P, path: impl AsRef<Path>) -> io::Result<PathBuf> {
    std::fs::read_link(path)
}

/// [`std::fs::metadata`].
pub fn metadata<P: ReadProof>(_proof: &P, path: impl AsRef<Path>) -> io::Result<Metadata> {
    std::fs::metadata(path)
}

/// [`std::fs::symlink_metadata`].
pub fn symlink_metadata<P: ReadProof>(_proof: &P, path: impl AsRef<Path>) -> io::Result<Metadata> {
    std::fs::symlink_metadata(path)
}

/// [`std::fs::canonicalize`].
pub fn canonicalize<P: ReadProof>(_proof: &P, path: impl AsRef<Path>) -> io::Result<PathBuf> {
    std::fs::canonicalize(path)
}

/// [`std::fs::exists`]: `Ok(false)` for a missing path, an error when that cannot be told.
pub fn exists<P: ReadProof>(_proof: &P, path: impl AsRef<Path>) -> io::Result<bool> {
    std::fs::exists(path)
}

/// [`Path::is_file`].
pub fn is_file<P: ReadProof>(_proof: &P, path: impl AsRef<Path>) -> bool {
    path.as_ref().is_file()
}

/// [`Path::is_dir`].
pub fn is_dir<P: ReadProof>(_proof: &P, path: impl AsRef<Path>) -> bool {
    path.as_ref().is_dir()
}

/// [`Path::is_symlink`].
pub fn is_symlink<P: ReadProof>(_proof: &P, path: impl AsRef<Path>) -> bool {
    path.as_ref().is_symlink()
}

/// [`std::fs::write`].
pub fn write<P: WriteProof>(_proof: &P, path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
    std::fs::write(path, contents)
}

/// [`std::fs::copy`].
pub fn copy<P: WriteProof>(_proof: &P, from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<u64> {
    std::fs::copy(from, to)
}

/// [`std::fs::rename`].
pub fn rename<P: WriteProof>(_proof: &P, from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
    std::fs::rename(from, to)
}

/// [`std::fs::hard_link`].
pub fn hard_link<P: WriteProof>(_proof: &P, original: impl AsRef<Path>, link: impl AsRef<Path>) -> io::Result<()> {
    std::fs::hard_link(original, link)
}

/// [`std::fs::remove_file`].
pub fn remove_file<P: WriteProof>(_proof: &P, path: impl AsRef<Path>) -> io::Result<()> {
    std::fs::remove_file(path)
}

/// [`std::fs::remove_dir`].
pub fn remove_dir<P: WriteProof>(_proof: &P, path: impl AsRef<Path>) -> io::Result<()> {
    std::fs::remove_dir(path)
}

/// [`std::fs::remove_dir_all`].
pub fn remove_dir_all<P: WriteProof>(_proof: &P, path: impl AsRef<Path>) -> io::Result<()> {
    std::fs::remove_dir_all(path)
}

/// [`std::fs::create_dir`].
pub fn create_dir<P: WriteProof>(_proof: &P, path: impl AsRef<Path>) -> io::Result<()> {
    std::fs::create_dir(path)
}

/// [`std::fs::create_dir_all`].
pub fn create_dir_all<P: WriteProof>(_proof: &P, path: impl AsRef<Path>) -> io::Result<()> {
    std::fs::create_dir_all(path)
}

/// [`std::fs::set_permissions`].
pub fn set_permissions<P: WriteProof>(_proof: &P, path: impl AsRef<Path>, permissions: Permissions) -> io::Result<()> {
    std::fs::set_permissions(path, permissions)
}

/// A symbolic link to the file `original` (`std::os::unix::fs::symlink`, or Windows'
/// `symlink_file`).
pub fn symlink_file<P: WriteProof>(_proof: &P, original: impl AsRef<Path>, link: impl AsRef<Path>) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(original, link)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(original, link)
    }
}

/// A symbolic link to the directory `original` (`std::os::unix::fs::symlink`, or Windows'
/// `symlink_dir`).
pub fn symlink_dir<P: WriteProof>(_proof: &P, original: impl AsRef<Path>, link: impl AsRef<Path>) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(original, link)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(original, link)
    }
}

/// [`std::thread::sleep`], on the lane thread the proof belongs to: waiting for a held lock or
/// a refused rename, never on an executor.
pub fn sleep<P: ReadProof>(_proof: &P, duration: Duration) {
    std::thread::sleep(duration);
}
