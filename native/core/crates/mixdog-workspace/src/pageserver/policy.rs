#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking path checks run only as lane jobs (lanes::run_fallible); the page server never calls them on an async thread")]
//! Which files a page may be served (`pageAssetType`, `pageLocation` of `local-page-server.ts`).

use std::path::{Path, PathBuf};

use crate::error::{WsError, WsResult};
use crate::pathguard::{canonical, comparable, is_within, resolve};

const DENIED_CODE: &str = "MIXDOG_LOCAL_ACCESS_DENIED";
const NOT_A_PAGE: &str = "The page must be a visible HTML file inside its folder.";

/// Presentation types: served anywhere under the root.
fn page_type(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "wasm" => "application/wasm",
        "gltf" => "model/gltf+json",
        "glb" => "model/gltf-binary",
        _ => return None,
    })
}

/// Data and documents: served only inside an origin's data root.
fn data_type(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "json" => "application/json; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "pdf" => "application/pdf",
        // A glTF model's buffers (`model.gltf` + `model.bin`).
        "bin" => "application/octet-stream",
        _ => return None,
    })
}

/// `fileExtension` (`shared/file-extension.ts`): the text after the last dot of the file name, lower case; none for no dot or a trailing one.
fn file_extension(path: &Path) -> String {
    let text = path.to_string_lossy();
    let name = text.rsplit(['/', '\\']).next().unwrap_or_default();
    match name.rfind('.') {
        Some(dot) if dot + 1 < name.len() => name[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// The mime of a web asset `file` that may be served from under `root` (`None` when the path is outside it, hidden, or not a web asset).
/// Presentation types are served anywhere under `root`; data and document types only under `data_root` (inside `root`, default `root`).
/// Hidden segments are refused below the page's own folder chain: the folders the user opened the page through may themselves be dot-named.
pub fn page_asset_type(root: &Path, file: &Path, data_root: Option<&Path>) -> Option<&'static str> {
    let data_root = data_root.unwrap_or(root);
    if !is_within(root, file) {
        return None;
    }
    let mut base = data_root;
    while !is_within(base, file) && comparable(base) != comparable(root) {
        let Some(parent) = base.parent() else { break };
        base = parent;
    }
    let below = strip_prefix_folded(base, file)?;
    if below.components().any(|part| part.as_os_str().to_string_lossy().starts_with('.')) {
        return None;
    }
    let extension = file_extension(file);
    if let Some(found) = page_type(&extension) {
        return Some(found);
    }
    if is_within(data_root, file) { data_type(&extension) } else { None }
}

/// The part of `file` after `base`, the components matched the way [`is_within`] does (case-folded on Windows).
fn strip_prefix_folded(base: &Path, file: &Path) -> Option<PathBuf> {
    let mut rest = file.components();
    for part in base.components() {
        let next = rest.next()?;
        if comparable(Path::new(part.as_os_str())) != comparable(Path::new(next.as_os_str())) {
            return None;
        }
    }
    Some(rest.as_path().to_path_buf())
}

fn denied() -> WsError {
    WsError::coded(DENIED_CODE, NOT_A_PAGE)
}

/// `pageLocation`: the real root and the real page for `rel` under `root`. The page must be a visible HTML file that stays inside the
/// root after links are resolved.
pub fn page_location(root: &Path, rel: &str) -> WsResult<(PathBuf, PathBuf)> {
    let real_root = canonical(root)?;
    let requested = resolve(&real_root.join(rel.replace('\\', "/")));
    if page_asset_type(&real_root, &requested, None).is_none() {
        return Err(denied());
    }
    let page = canonical(&requested)?;
    let html = matches!(file_extension(&page).as_str(), "html" | "htm");
    if page_asset_type(&real_root, &page, None).is_none() || !html || !page.metadata()?.is_file() {
        return Err(denied());
    }
    Ok((real_root, page))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct PageAsset {
        root: String,
        file: String,
        #[serde(rename = "dataRoot")]
        data_root: Option<String>,
        #[serde(rename = "type")]
        mime: String,
    }

    #[derive(Deserialize)]
    struct Cases {
        #[serde(rename = "pageAsset")]
        page_asset: Vec<PageAsset>,
    }

    #[test]
    fn shared_cases() {
        let cases: Cases = serde_json::from_str(include_str!("cases.json")).unwrap();
        assert!(!cases.page_asset.is_empty());
        for case in cases.page_asset {
            let got = page_asset_type(Path::new(&case.root), Path::new(&case.file), case.data_root.as_deref().map(Path::new));
            assert_eq!(got.unwrap_or(""), case.mime, "{} under {} (data {:?})", case.file, case.root, case.data_root);
        }
    }

    #[test]
    fn hidden_segments_below_the_page_chain_are_refused() {
        let root = Path::new("/w/.open/site");
        assert_eq!(page_asset_type(root, Path::new("/w/.open/site/a/b.css"), None), Some("text/css; charset=utf-8"));
        assert_eq!(page_asset_type(root, Path::new("/w/.open/site/.git/b.css"), None), None);
        assert_eq!(page_asset_type(root, Path::new("/w/.open/site/a/.b.css"), None), None);
    }

    #[test]
    fn data_types_only_under_the_data_root() {
        let root = Path::new("/w/site");
        let data = Path::new("/w/site/data");
        assert_eq!(page_asset_type(root, Path::new("/w/site/data/x.json"), Some(data)), Some("application/json; charset=utf-8"));
        assert_eq!(page_asset_type(root, Path::new("/w/site/x.json"), Some(data)), None);
        assert_eq!(page_asset_type(root, Path::new("/w/site/x.json"), None), Some("application/json; charset=utf-8"));
        assert_eq!(page_asset_type(root, Path::new("/w/site/x.png"), Some(data)), Some("image/png"));
        assert_eq!(page_asset_type(root, Path::new("/w/other/x.png"), None), None);
        assert_eq!(page_asset_type(root, Path::new("/w/site/x.rs"), None), None);
    }

    #[test]
    fn page_location_needs_a_visible_html_file_inside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/index.html"), "<p>").unwrap();
        std::fs::write(root.join("sub/app.js"), "1").unwrap();
        std::fs::write(root.join(".hidden.html"), "<p>").unwrap();
        let (real_root, page) = page_location(root, "sub\\index.html").unwrap();
        assert_eq!(real_root, canonical(root).unwrap());
        assert_eq!(page, canonical(&root.join("sub/index.html")).unwrap());
        for rel in ["sub/app.js", ".hidden.html", "../x.html", "sub"] {
            let error = page_location(root, rel).unwrap_err();
            assert_eq!(error.reason.code(), DENIED_CODE, "{rel}");
            assert_eq!(error.message, NOT_A_PAGE, "{rel}");
        }
    }
}
