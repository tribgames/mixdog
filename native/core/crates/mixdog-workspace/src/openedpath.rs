#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread")]
//! Where an OPEN file lives, and the page server's open of a response file (`opened-file-path.ts`, `opened-file-authorization.ts`).
//! A check made on a resolved path covers the bytes a handle reads only when the handle is shown to be the file at that path: an
//! ancestor swapped for a junction or a link between resolving and opening redirects the open without changing the path text, so
//! the folder check is repeated on the location the open handle itself reports.

use std::fs::File;
use std::io;
use std::path::Path;
use std::path::PathBuf;

use crate::error::WsError;
use crate::error::WsResult;
use crate::inplace::Opened;
use crate::inplace::open_authorized_ro;
use crate::pathguard::canonical;
use crate::pathguard::is_within;

/// The location of the file `file` has open, now, in the form `realpath` returns (Windows: `GetFinalPathNameByHandleW` on the held
/// handle with the namespace prefix removed; Linux: the kernel's name for the descriptor; macOS: `F_GETPATH`). Another unix has no
/// descriptor-based answer: `ErrorKind::Unsupported`.
pub fn opened_location(file: &File) -> io::Result<PathBuf> {
    crate::ident::handle_path(file)
}

/// Opens `path` read-only for a page response and proves from the open file that it is a regular file whose real location is inside
/// `root`. Where the platform can locate an open file the handle's own location must lie inside the canonical `root`; elsewhere
/// nothing more than the path check of [`open_authorized_ro`] is possible.
pub fn open_page_file(path: &Path, root: &Path) -> WsResult<Opened> {
    let opened = open_authorized_ro(path, root)?;
    require_inside(&opened.file, root)?;
    Ok(opened)
}

fn require_inside(file: &File, root: &Path) -> WsResult<()> {
    let location = match opened_location(file) {
        Ok(location) => location,
        Err(error) if error.kind() == io::ErrorKind::Unsupported => return Ok(()),
        Err(_) => return Err(WsError::plain("The file changed while it was opened.")),
    };
    let root = canonical(root)?;
    if !is_within(&root, &location) {
        return Err(WsError::coded("MIXDOG_LOCAL_ACCESS_DENIED", "The file resolves outside the folder."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn denied(error: &WsError) -> bool {
        error.to_string().contains("resolves outside")
    }

    #[cfg(windows)]
    fn link_dir(link: &Path, target: &Path) -> bool {
        std::os::windows::fs::symlink_dir(target, link).is_ok()
            || std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().map(|o| o.status.success()).unwrap_or(false)
    }

    #[cfg(unix)]
    fn link_dir(link: &Path, target: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    fn site() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("page.html"), "<p>in</p>").unwrap();
        std::fs::write(outside.join("secret.css"), "OUTSIDE").unwrap();
        (dir, root, outside)
    }

    #[test]
    fn a_regular_file_inside_opens_and_is_located_inside() {
        let (_dir, root, _outside) = site();
        let opened = open_page_file(&root.join("page.html"), &root).unwrap();
        let location = opened_location(&opened.file).unwrap();
        assert!(is_within(&canonical(&root).unwrap(), &location));
        assert_eq!(location.file_name().unwrap(), "page.html");
    }

    #[test]
    fn a_link_to_a_file_outside_is_refused() {
        let (_dir, root, outside) = site();
        assert!(link_dir(&root.join("escape"), &outside));
        let error = open_page_file(&root.join("escape").join("secret.css"), &root).err().unwrap();
        assert!(denied(&error), "{error}");
    }

    #[test]
    fn a_directory_is_refused() {
        let (_dir, root, _outside) = site();
        let error = open_page_file(&root.join("docs"), &root).err().unwrap();
        assert!(error.to_string().contains("not a file"), "{error}");
    }

    #[test]
    fn a_file_moved_out_after_the_open_is_refused_from_the_handle() {
        let (_dir, root, outside) = site();
        let file = File::open(root.join("page.html")).unwrap();
        require_inside(&file, &root).unwrap();
        std::fs::rename(root.join("page.html"), outside.join("moved.html")).unwrap();
        // The path text a check saw is unchanged in spirit; the handle now answers with where it really is.
        let error = require_inside(&file, &root).unwrap_err();
        assert!(denied(&error), "{error}");
    }

    #[test]
    fn an_ancestor_swapped_for_a_link_before_the_open_reaches_nothing() {
        let (_dir, root, outside) = site();
        let docs = root.join("docs");
        std::fs::write(docs.join("secret.css"), "INSIDE").unwrap();
        // The folder check passed on `docs`; the folder is then swapped for a link to the outside before the open.
        std::fs::rename(&docs, root.join("docs-moved")).unwrap();
        assert!(link_dir(&docs, &outside));
        let error = open_page_file(&docs.join("secret.css"), &root).err().unwrap();
        assert!(denied(&error), "{error}");
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_inside_the_root_to_a_folder_inside_is_accepted() {
        let (_dir, root, _outside) = site();
        std::fs::create_dir_all(root.join("real")).unwrap();
        std::fs::write(root.join("real").join("a.css"), "A").unwrap();
        assert!(link_dir(&root.join("alias"), &root.join("real")));
        let opened = open_page_file(&root.join("alias").join("a.css"), &root).unwrap();
        let location = opened_location(&opened.file).unwrap();
        assert!(is_within(&canonical(&root).unwrap(), &location));
    }
}
