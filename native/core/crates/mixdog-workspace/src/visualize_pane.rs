#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread"
)]
//! A paired phone's reads of a visualize pane's files (Node `remote-visualize.ts`: `servedFile`, `visualizePaneFile`,
//! `visualizePaneRange`). Main hands the core each tab's panes with their resolved files (`mixdog_exthost::VisualizePanes`); a
//! phone only ever names a tab, a pane and a path relative to a pane's root. Containment is re-resolved on every call (a folder
//! swapped for a link to outside the root fails closed), and the bytes are read from the file as opened and authorized.

use std::path::Path;
use std::path::PathBuf;

use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use crate::error::WsError;
use crate::error::WsResult;
use crate::ident::mtime_ms;
use crate::inplace::open_authorized_ro;
use crate::nodeerr::AtPath;
use crate::pageserver::policy::page_asset_type;
use crate::pathguard::canonical;
use crate::pathguard::comparable;
use crate::pathguard::project_entry_path;
use crate::pathguard::resolve;
use crate::preview::file_preview_type;
use crate::preview::read_window;

/// `REMOTE_PAGE_MAX_BYTES` (`shared/visualize.ts:466`): the largest page file a phone builds into a document; a larger one gets no
/// content identity (no client cache).
pub const PAGE_MAX_BYTES: u64 = 4 * 1024 * 1024;
const NOT_IN_TAB: &str = "This file is not part of the visualize tab.";
const UNSUPPORTED: &str = "This file type does not support an in-app preview.";

/// One pane of a tab as the desktop published it (`VisualizeHostPane`).
#[derive(Clone, Debug)]
pub struct TabPane {
    pub kind: String,
    /// The pane's resolved file; empty for an inline pane.
    pub path: PathBuf,
    /// The pane's root, else the tab's working directory (`rootOf`).
    pub root: PathBuf,
    pub inline: bool,
    pub version: Option<i64>,
}

/// What a request is read under: `root` is the folder its `rel` is relative to (the asked pane's root, else the tab's cwd), and
/// `panes` every pane of the tab.
#[derive(Clone, Debug)]
pub struct PaneScope {
    pub root: PathBuf,
    pub panes: Vec<TabPane>,
}

struct Served {
    root: PathBuf,
    absolute: PathBuf,
    mime: &'static str,
}

/// `servedFile`: the file a read of `rel` may serve for the tab, or the refusal. A tab's own file panes are always servable, an
/// HTML pane also serves the page assets the local page server would (hidden folders refused below the page's own folder chain),
/// and nothing else is part of the tab. Inline panes have no file, so never a page whose folder could serve project assets.
fn served(scope: &PaneScope, rel: &str) -> WsResult<Served> {
    let root = canonical(&scope.root)?;
    let rel = rel.replace('\\', "/");
    let absolute = project_entry_path(&root, &rel)?;
    let roots = [comparable(&scope.root), comparable(&root)];
    let group: Vec<&TabPane> = scope.panes.iter().filter(|pane| !pane.inline && roots.contains(&comparable(&pane.root))).collect();
    let own = group.iter().find(|pane| comparable(&resolve(&pane.path)) == comparable(&absolute));
    let mime = match own {
        // The converted PDF lives in the document cache outside the root; a phone reads a document's pages instead.
        Some(pane) if pane.kind == "document" => return Err(WsError::plain("The document preview is unavailable.")),
        Some(pane) if pane.kind == "html" => page_asset_type(&root, &absolute, absolute.parent()),
        Some(_) => file_preview_type(&absolute).map(|(_, mime)| mime),
        None => {
            let pages: Vec<&&TabPane> = group.iter().filter(|pane| pane.kind == "html").collect();
            if pages.is_empty() {
                return Err(WsError::plain(NOT_IN_TAB));
            }
            pages.iter().find_map(|page| page_asset_type(&root, &absolute, resolve(&page.path).parent()))
        }
    };
    let mime = mime.ok_or_else(|| WsError::plain(UNSUPPORTED))?;
    Ok(Served { root, absolute, mime })
}

/// `AUTHORIZED_COPY_MAX_BYTES` (`remote-file-preview.ts`): the largest file copied for rendering.
const COPY_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// Copies in use by folder: the same bytes asked for twice at once share one copy, removed when its last user is done
/// (`remote-file-preview.ts` `copies`).
static COPIES: std::sync::Mutex<Option<std::collections::HashMap<PathBuf, usize>>> = std::sync::Mutex::new(None);
/// The folder every copy lives in, made once and fresh for this process (Node's `authorizedCopiesRoot`).
static COPIES_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn copies() -> std::sync::MutexGuard<'static, Option<std::collections::HashMap<PathBuf, usize>>> {
    COPIES.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A private, stable input for work another process does by path (a conversion, a rasterizer): the bytes read through the
/// authorized open handle of `rel` within `root` (Node's `withAuthorizedFile`, `remote-file-preview.ts:133`), in a folder only the
/// core made, never the original path, which could be swapped for a link and restored around the read. The folder is removed
/// when the last user of it drops.
pub struct PrivateCopy {
    dir: PathBuf,
    /// The copy's folder and file name: what the other process is asked for.
    pub root: PathBuf,
    pub rel: String,
}

impl Drop for PrivateCopy {
    fn drop(&mut self) {
        let mut held = copies();
        let Some(users) = held.as_mut().and_then(|map| map.get_mut(&self.dir)) else { return };
        *users -= 1;
        if *users == 0 {
            if let Some(map) = held.as_mut() {
                map.remove(&self.dir);
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

/// Copies `rel` (within `root`) to a [`PrivateCopy`], keeping its name (the format is told by the extension) and its modification
/// time. The folder is named after the content, the time and the name, so a conversion cache keyed by path and time keeps hitting
/// and a folder belongs to exactly one copy.
pub fn private_copy(root: &Path, rel: &str) -> WsResult<PrivateCopy> {
    let root = canonical(root)?;
    let absolute = project_entry_path(&root, &rel.replace('\\', "/"))?;
    let mut opened = open_authorized_ro(&absolute, &root)?;
    let meta = opened.file.metadata().at("fstat", &absolute)?;
    if meta.len() > COPY_MAX_BYTES {
        return Err(WsError::plain("This file is too large to preview remotely."));
    }
    let name = absolute.file_name().map(|name| name.to_string_lossy().into_owned()).ok_or_else(|| WsError::plain(NOT_IN_TAB))?;
    let base = COPIES_ROOT.get_or_init(|| std::env::temp_dir().join(format!("mixdog-authorized-copies-{}", uuid::Uuid::new_v4()))).clone();
    std::fs::create_dir_all(&base).at("mkdir", &base)?;
    let staging = base.join(format!("{}.part", uuid::Uuid::new_v4()));
    let mut hash = stream_to_staging(&mut opened.file, &absolute, &staging, &meta)?;
    let mtime = mtime_ms(&meta);
    hash.update(format!("\0{mtime}\0{name}").as_bytes());
    let key: String = hex(&hash.finalize()).chars().take(32).collect();
    publish_copy(&staging, base.join(key), name)
}

fn stream_to_staging(source: &mut std::fs::File, absolute: &Path, staging: &Path, meta: &std::fs::Metadata) -> WsResult<Sha256> {
    let mut hash = Sha256::new();
    let mut out = std::fs::File::create_new(staging).at("open", staging)?;
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = std::io::Read::read(source, &mut buffer).at("read", absolute)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > COPY_MAX_BYTES {
            let _ = std::fs::remove_file(staging);
            return Err(WsError::plain("This file is too large to preview remotely."));
        }
        hash.update(&buffer[..read]);
        std::io::Write::write_all(&mut out, &buffer[..read]).at("write", staging)?;
    }
    if let Ok(modified) = meta.modified() {
        let _ = out.set_modified(modified);
    }
    Ok(hash)
}

fn publish_copy(staging: &Path, dir: PathBuf, name: String) -> WsResult<PrivateCopy> {
    let mut held = copies();
    let users = held.get_or_insert_with(Default::default).entry(dir.clone()).or_insert(0);
    if *users == 0 {
        // No one holds a folder of this name: it is made fresh, so nothing left behind can stand in for the copy.
        let _ = std::fs::remove_dir_all(&dir);
        let made = std::fs::create_dir(&dir).at("mkdir", &dir).and_then(|()| std::fs::rename(staging, dir.join(&name)).at("rename", &dir));
        if let Err(error) = made {
            let _ = std::fs::remove_file(staging);
            if let Some(map) = held.as_mut() {
                map.remove(&dir);
            }
            return Err(error);
        }
    } else {
        let _ = std::fs::remove_file(staging);
    }
    if let Some(users) = held.as_mut().and_then(|map| map.get_mut(&dir)) {
        *users += 1;
    }
    drop(held);
    Ok(PrivateCopy { root: dir.clone(), dir, rel: name })
}

/// `visualizePaneRange`: up to `length` bytes of `rel` from `offset` (base64), as a project file preview's range answers.
pub fn range(scope: &PaneScope, rel: &str, offset: u64, length: u64) -> WsResult<Value> {
    let served = served(scope, rel)?;
    let mut opened = open_authorized_ro(&served.absolute, &served.root)?;
    read_window(&mut opened.file, &served.absolute, served.mime, offset, length)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `visualizePaneFile`: what pane `index` loads. The file is the pane's own, relative to its root; an HTML pane also carries the
/// content identity its page cache is keyed on (`live` or `v<version>`, and the sha-256 of the bytes) when it is within
/// [`PAGE_MAX_BYTES`]. (The media-lane lease Node added for image, audio and video panes is not issued: the encrypted media lane is
/// not served, and a phone without it reads ranges.)
pub fn file(scope: &PaneScope, index: usize) -> WsResult<Value> {
    let pane = scope.panes.get(index).ok_or_else(|| WsError::plain("This visualize pane is closed."))?;
    let root = canonical(&pane.root)?;
    let rel = relative(&root, &pane.path)?;
    let pane_scope = PaneScope { root: pane.root.clone(), panes: scope.panes.clone() };
    let served = served(&pane_scope, &rel)?;
    let mut opened = open_authorized_ro(&served.absolute, &served.root)?;
    let meta = opened.file.metadata().at("fstat", &served.absolute)?;
    let mut answer = json!({ "kind": pane.kind, "mime": served.mime, "size": meta.len(), "mtimeMs": mtime_ms(&meta), "rel": rel });
    if pane.kind == "html" && meta.len() <= PAGE_MAX_BYTES {
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        std::io::Read::read_to_end(&mut std::io::Read::take(&mut opened.file, PAGE_MAX_BYTES + 1), &mut bytes).at("read", &served.absolute)?;
        if bytes.len() as u64 <= PAGE_MAX_BYTES {
            let which = pane.version.map_or_else(|| "live".to_owned(), |version| format!("v{version}"));
            answer["contentId"] = json!(format!("{which}:{}", hex(&Sha256::digest(&bytes))));
        }
    }
    Ok(answer)
}

/// `relative(root, pane.path)` with `/` separators: the pane's file under its own root, else the refusal of a file outside it.
fn relative(root: &Path, path: &Path) -> WsResult<String> {
    let path = resolve(path);
    if !comparable(&path).starts_with(comparable(root)) {
        return Err(WsError::plain(NOT_IN_TAB));
    }
    // `comparable` folds case on Windows: the name is taken from the resolved path itself.
    let name: PathBuf = path.components().skip(root.components().count()).collect();
    Ok(name.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(kind: &str, path: &Path, root: &Path) -> TabPane {
        TabPane { kind: kind.into(), path: path.to_path_buf(), root: root.to_path_buf(), inline: false, version: None }
    }

    /// A tab's pane file and the assets of its page are served; anything else in the folder, a hidden folder under the page's chain
    /// and a file outside the root are not; a pane's file keeps its content identity for the page cache.
    #[test]
    fn a_tab_serves_its_own_panes_and_its_pages_assets_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("site/.git")).unwrap();
        std::fs::write(root.join("site/index.html"), "<p>hi</p>").unwrap();
        std::fs::write(root.join("site/app.css"), "p{}").unwrap();
        std::fs::write(root.join("site/.git/x.css"), "p{}").unwrap();
        std::fs::write(root.join("notes.txt"), "secret").unwrap();
        std::fs::write(root.join("pic.png"), [1, 2, 3]).unwrap();
        let scope =
            PaneScope { root: root.clone(), panes: vec![pane("html", &root.join("site/index.html"), &root), pane("image", &root.join("pic.png"), &root)] };
        let page = file(&scope, 0).unwrap();
        assert_eq!((page["kind"].clone(), page["rel"].clone(), page["size"].clone()), (json!("html"), json!("site/index.html"), json!(9)));
        let expected = hex(&Sha256::digest(b"<p>hi</p>"));
        assert_eq!(page["contentId"], json!(format!("live:{expected}")));
        assert_eq!(file(&scope, 1).unwrap()["mime"], json!("image/png"));
        assert!(file(&scope, 1).unwrap().get("contentId").is_none());
        let css = range(&scope, "site/app.css", 0, 100).unwrap();
        assert_eq!((css["mime"].clone(), css["size"].clone()), (json!("text/css; charset=utf-8"), json!(3)));
        assert_eq!(range(&scope, "pic.png", 1, 100).unwrap()["offset"], json!(1));
        for refused in ["notes.txt", "site/.git/x.css", "../outside.css"] {
            assert!(range(&scope, refused, 0, 10).is_err(), "{refused}");
        }
        assert_eq!(file(&scope, 9).unwrap_err().message, "This visualize pane is closed.");
        // Without an HTML pane no folder serves assets: only the pane's own file.
        let images = PaneScope { root: root.clone(), panes: vec![pane("image", &root.join("pic.png"), &root)] };
        assert_eq!(range(&images, "site/app.css", 0, 10).unwrap_err().message, NOT_IN_TAB);
        assert!(range(&images, "pic.png", 0, 10).is_ok());
        // An inline pane has no file to serve.
        let mut inline = pane("html", &root.join("site/index.html"), &root);
        inline.inline = true;
        let inline = PaneScope { root: root.clone(), panes: vec![inline] };
        assert_eq!(range(&inline, "site/index.html", 0, 10).unwrap_err().message, NOT_IN_TAB);
    }

    /// What another process renders is the bytes that were authorized: a private copy made through the opened handle holds them
    /// whatever is done to the path afterwards (swapped for other bytes, or for a link out of the root), and a path that already
    /// leaves the root is refused before any copy exists.
    #[test]
    fn a_private_copy_holds_the_authorized_bytes_whatever_the_path_becomes() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.pdf"), "OUTSIDE").unwrap();
        std::fs::write(root.join("deck.pdf"), "INSIDE").unwrap();
        let copy = private_copy(&root, "deck.pdf").unwrap();
        let read = |copy: &PrivateCopy| std::fs::read_to_string(copy.root.join(&copy.rel)).unwrap();
        assert_eq!(read(&copy), "INSIDE");
        // Between the check and a later open the path is replaced by a link to a file outside the root.
        std::fs::remove_file(root.join("deck.pdf")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path().join("secret.pdf"), root.join("deck.pdf")).unwrap();
        #[cfg(not(unix))]
        std::fs::write(root.join("deck.pdf"), "SWAPPED").unwrap();
        assert_eq!(read(&copy), "INSIDE", "the copy is not the path");
        #[cfg(unix)]
        assert!(private_copy(&root, "deck.pdf").is_err(), "a link out of the root is refused, not copied");
        let folder = copy.root.clone();
        drop(copy);
        assert!(!folder.exists(), "the copy is removed with its last user");
    }
}
