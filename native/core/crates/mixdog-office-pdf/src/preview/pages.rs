//! `documentPreviewPages`: rasterised pages of a converted document. A page is served from memory, else from the disk cache
//! `<cacheRoot>/document-preview-pages/<revision>/<page>-<width>.json`, else rasterised. Pages of a document opened with its
//! password never reach the disk.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use mixdog_fsio::WriteProof;
use mixdog_rt::{DurabilityIo, InLane, InteractiveIo};
use serde_json::{Value, json};

use super::cache::{Identity, identity_of, sha256_hex, touch_directory};
use super::scratch::in_scratch;
use super::{DocumentPreview, PagesOptions, PreviewError, PreviewPage, PreviewPages, RawImage, job, lock};

pub const PAGE_CACHE_DIRECTORY: &str = "document-preview-pages";
pub const MAX_CACHED_PAGE_REVISIONS: usize = 48;
pub const MAX_MEMORY_PAGES: usize = 32;
pub const MAX_MEMORY_PAGE_BYTES: usize = 48 * 1024 * 1024;

/// A page as it is cached, with the page count of the PDF it came from.
#[derive(Clone, Debug, PartialEq)]
struct Stored {
    entry: PreviewPage,
    page_count: u64,
}

/// Where the pages of one revision of a PDF live.
struct Revision {
    memory: String,
    directory: String,
    owner: String,
}

fn sha16(text: &str) -> String {
    sha256_hex(text)[..16].to_owned()
}

fn revision_of(pdf: &Path, identity: Identity) -> Revision {
    let path = mixdog_js::nodepath::resolve_host(&[&pdf.to_string_lossy()]);
    let (mtime, size) = (mixdog_js::number_to_string(identity.mtime_ms), identity.size);
    Revision { memory: format!("{path}\0{mtime}\0{size}"), directory: format!("{}-{}", sha16(&path), sha16(&format!("{mtime}\0{size}"))), owner: sha16(&path) }
}

/// The pages in memory, most recently used last.
#[derive(Default)]
pub(super) struct MemoryPages(Mutex<Memory>);

#[derive(Default)]
struct Memory {
    pages: Vec<(String, Stored)>,
    bytes: usize,
}

impl MemoryPages {
    fn hit(&self, key: &str) -> Option<Stored> {
        let stored = lock(&self.0).pages.iter().find(|(name, _)| name == key).map(|(_, stored)| stored.clone())?;
        self.remember(key, stored.clone());
        Some(stored)
    }

    fn remember(&self, key: &str, value: Stored) {
        let mut memory = lock(&self.0);
        if let Some(at) = memory.pages.iter().position(|(name, _)| name == key) {
            let previous = memory.pages.remove(at).1;
            memory.bytes -= previous.entry.base64.len();
        }
        memory.bytes += value.entry.base64.len();
        memory.pages.push((key.to_owned(), value));
        while (memory.bytes > MAX_MEMORY_PAGE_BYTES || memory.pages.len() > MAX_MEMORY_PAGES) && !memory.pages.is_empty() {
            let oldest = memory.pages.remove(0).1;
            memory.bytes -= oldest.entry.base64.len();
        }
    }
}

fn memory_key(revision: &Revision, page: u64, max_width: u32) -> String {
    format!("{}\0{page}\0{max_width}", revision.memory)
}

fn page_file(revision: &Revision, cache_root: &str, page: u64, max_width: u32) -> PathBuf {
    Path::new(cache_root).join(PAGE_CACHE_DIRECTORY).join(&revision.directory).join(format!("{page}-{max_width}.json"))
}

fn stored_json(stored: &Stored) -> Value {
    json!({
        "entry": {
            "page": stored.entry.page,
            "width": stored.entry.width,
            "height": stored.entry.height,
            "mime": stored.entry.mime,
            "base64": stored.entry.base64,
        },
        "pageCount": stored.page_count,
    })
}

/// A cached page file read back: a record that does not name this page, or has no pixels or page count, is no hit.
fn stored_from(text: &str, page: u64) -> Option<Stored> {
    let value: Value = serde_json::from_str(text).ok()?;
    let entry = value.get("entry")?;
    let base64 = entry.get("base64").and_then(Value::as_str).filter(|data| !data.is_empty())?;
    if entry.get("page").and_then(Value::as_u64)? != page {
        return None;
    }
    let page_count = value.get("pageCount").and_then(Value::as_u64).filter(|count| *count >= 1)?;
    Some(Stored {
        entry: PreviewPage {
            page,
            width: entry.get("width").and_then(Value::as_u64).unwrap_or(0),
            height: entry.get("height").and_then(Value::as_u64).unwrap_or(0),
            mime: entry.get("mime").and_then(Value::as_str).unwrap_or("").to_owned(),
            base64: base64.to_owned(),
        },
        page_count,
    })
}

async fn cached_page(preview: &DocumentPreview, revision: &Revision, cache_root: &str, page: u64, max_width: u32) -> Result<Option<Stored>, PreviewError> {
    let key = memory_key(revision, page, max_width);
    if let Some(hot) = preview.state.pages.hit(&key) {
        return Ok(Some(hot));
    }
    if cache_root.is_empty() {
        return Ok(None);
    }
    let file = page_file(revision, cache_root, page, max_width);
    let read = job(preview.lanes.durability_io, move |lane: &InLane<DurabilityIo>| {
        let stored = mixdog_fsio::read_to_string(lane, &file).ok().and_then(|text| stored_from(&text, page))?;
        if let Some(directory) = file.parent() {
            touch_directory(lane, directory);
        }
        Some(stored)
    })
    .await?;
    if let Some(stored) = &read {
        preview.state.pages.remember(&key, stored.clone());
    }
    Ok(read)
}

fn store_file<P: WriteProof>(proof: &P, file: &Path, stored: &Stored) -> io::Result<()> {
    let directory = file.parent().unwrap_or(Path::new("."));
    mixdog_fsio::create_dir_all(proof, directory)?;
    let name = file.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis());
    let temporary = directory.join(format!("{name}.{}.{stamp}.tmp", std::process::id()));
    let written = mixdog_fsio::write(proof, &temporary, stored_json(stored).to_string()).and_then(|()| mixdog_fsio::rename(proof, &temporary, file));
    if written.is_err() {
        let _ = mixdog_fsio::remove_file(proof, &temporary);
    }
    written
}

async fn store_page(
    preview: &DocumentPreview,
    revision: &Revision,
    cache_root: &str,
    entry: &PreviewPage,
    page_count: u64,
    max_width: u32,
) -> Result<(), PreviewError> {
    let stored = Stored { entry: entry.clone(), page_count };
    preview.state.pages.remember(&memory_key(revision, entry.page, max_width), stored.clone());
    if cache_root.is_empty() {
        return Ok(());
    }
    let file = page_file(revision, cache_root, entry.page, max_width);
    // A page that cannot be stored is still served.
    job(preview.lanes.durability_io, move |lane: &InLane<DurabilityIo>| {
        let _ = store_file(lane, &file, &stored);
    })
    .await
}

/// Older revisions of the same PDF can never be requested again, so they go; beyond that the least recently used revisions are
/// dropped past a fixed count.
fn prune_page_cache<P: WriteProof>(proof: &P, root: &Path, current: &Revision) {
    let Ok(entries) = mixdog_fsio::read_dir(proof, root) else { return };
    let mut keep: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type(proof).is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == current.directory {
            continue;
        }
        if name.starts_with(&format!("{}-", current.owner)) {
            let _ = mixdog_fsio::remove_dir_all(proof, entry.path());
        } else {
            keep.push((name, entry.path()));
        }
    }
    if keep.len() < MAX_CACHED_PAGE_REVISIONS {
        return;
    }
    let mut dated: Vec<(PathBuf, f64)> = keep
        .into_iter()
        .map(|(_, path)| {
            let used_at = mixdog_fsio::metadata(proof, &path).map_or(0.0, |details| identity_of(&details).mtime_ms);
            (path, used_at)
        })
        .collect();
    dated.sort_by(|left, right| right.1.total_cmp(&left.1));
    for (path, _) in dated.into_iter().skip(MAX_CACHED_PAGE_REVISIONS - 1) {
        let _ = mixdog_fsio::remove_dir_all(proof, path);
    }
}

fn fresh(image: RawImage) -> PreviewPage {
    PreviewPage {
        page: image.page,
        width: image.width,
        height: image.height,
        mime: image.mime_type.filter(|mime| !mime.is_empty()).unwrap_or_else(|| "image/png".to_owned()),
        base64: image.data,
    }
}

/// Whether the PDF still has the identity it was stat'ed with: only pixels of the revision that was stat'ed may be stored under it.
async fn unchanged_since(preview: &DocumentPreview, pdf: &Path, before: Identity) -> Result<bool, PreviewError> {
    let target = pdf.to_path_buf();
    let after = job(preview.lanes.interactive_io, move |lane: &InLane<InteractiveIo>| mixdog_fsio::metadata(lane, &target).ok()).await?;
    Ok(after.is_some_and(|details| {
        let now = identity_of(&details);
        now.mtime_ms == before.mtime_ms && now.size == before.size
    }))
}

pub(super) async fn preview_pages(preview: &DocumentPreview, pdf: &Path, options: PagesOptions) -> Result<PreviewPages, PreviewError> {
    // Pages of a document opened with its password stay in memory only, like its PDF.
    let cache_root = if in_scratch(pdf) { String::new() } else { options.cache_root.clone() };
    let wanted = if options.pages.is_empty() { vec![1] } else { options.pages.clone() };
    let target = pdf.to_path_buf();
    let info = job(preview.lanes.interactive_io, move |lane: &InLane<InteractiveIo>| mixdog_fsio::metadata(lane, &target).ok())
        .await?
        .filter(|details| details.is_file());
    let identity = info.as_ref().map(identity_of);
    let revision = identity.map(|identity| revision_of(pdf, identity));
    let mut found: HashMap<u64, PreviewPage> = HashMap::new();
    let mut missing = Vec::new();
    let mut page_count = 0;
    for page in &wanted {
        let hit = match &revision {
            Some(revision) => cached_page(preview, revision, &cache_root, *page, options.max_width).await?,
            None => None,
        };
        match hit {
            Some(stored) => {
                page_count = stored.page_count;
                found.insert(*page, stored.entry);
            }
            None => missing.push(*page),
        }
    }
    if !missing.is_empty() {
        let rendered = preview.renderer.render_pages(pdf.to_path_buf(), missing, options.max_width, options.cancel.clone()).await?;
        page_count = rendered.page_count;
        let images: Vec<PreviewPage> = rendered.images.into_iter().map(fresh).collect();
        let unchanged = match (&revision, identity) {
            (Some(_), Some(before)) => unchanged_since(preview, pdf, before).await?,
            _ => false,
        };
        for entry in images {
            if unchanged && let Some(revision) = &revision {
                store_page(preview, revision, &cache_root, &entry, page_count, options.max_width).await?;
            }
            found.insert(entry.page, entry);
        }
        if unchanged
            && !cache_root.is_empty()
            && let Some(revision) = revision
        {
            let root = Path::new(&cache_root).join(PAGE_CACHE_DIRECTORY);
            job(preview.lanes.durability_io, move |lane: &InLane<DurabilityIo>| prune_page_cache(lane, &root, &revision)).await?;
        }
    }
    let pages = wanted.iter().filter_map(|page| found.get(page).cloned()).collect();
    Ok(PreviewPages { page_count, pages })
}
