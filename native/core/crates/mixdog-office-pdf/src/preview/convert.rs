//! `documentPreviewPdf`: a document to a cached PDF.
//!
//! An encrypted OOXML package is opened the way [MS-OFFCRYPTO] specifies: the password verifier decides a wrong password, the
//! package's HMAC must then prove it intact, and only then does the key decrypt it into a private scratch copy.
//!
//! LibreOffice renders when it is available, else Microsoft Office renders a private read-only copy (the host opens it
//! read-only: no recalculation, no link updates, macros off). A password only reaches Microsoft Office, on the host's stdin,
//! never on its command line.

use std::fs::Metadata;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_fsio::OpenOptions;
use mixdog_office_crypto::{
    CancelToken, Descriptor, Integrity, KeyDerivation, KeyError, decrypt_package, is_encrypted_binary_presentation, is_encrypted_ooxml,
    is_encrypted_word_document, ooxml_encryption, package_intact, read_encrypted_ooxml, read_ooxml_encryption_info,
};
use mixdog_rt::{CancellationToken, CpuBulk, DurabilityIo, InLane, InteractiveIo};
use serde_json::{Map, Value, json};

use super::cache::{
    DOCUMENT_CACHE_DIRECTORY, Identity, PREVIEW_PDF_NAME, StagingOwner, UnlockedEntry, cache_key, file_size, identity_of, prune_cache, publish,
    reclaim_staging, stat_error, touch_directory,
};
use super::scratch::{create_scratch, remove_scratch};
use super::{
    DocumentPreview, OFFICE_PREVIEW_PASSWORD_CORRUPT, OFFICE_PREVIEW_PASSWORD_NEEDS_OFFICE, OFFICE_PREVIEW_PASSWORD_PROTECTED,
    OFFICE_PREVIEW_PASSWORD_UNSUPPORTED, OFFICE_PREVIEW_UNAVAILABLE, OFFICE_PREVIEW_WRONG_PASSWORD, OFFICE_RENDER_TIMEOUT, PdfPreview, PreviewError,
    PreviewOptions, job, office_family, preview_format,
};

const NOT_A_PREVIEW_TYPE: &str = "This file type has no built-in document preview.";

fn password_protected() -> PreviewError {
    PreviewError::coded("This file is password-protected and can't be previewed.", OFFICE_PREVIEW_PASSWORD_PROTECTED)
}

fn wrong_password() -> PreviewError {
    PreviewError::coded("That password didn't work.", OFFICE_PREVIEW_WRONG_PASSWORD)
}

fn password_unsupported() -> PreviewError {
    PreviewError::coded("This file is password-protected and can't be previewed.", OFFICE_PREVIEW_PASSWORD_UNSUPPORTED)
}

fn password_needs_office() -> PreviewError {
    PreviewError::coded("Previewing this password-protected file needs Microsoft Office.", OFFICE_PREVIEW_PASSWORD_NEEDS_OFFICE)
}

fn password_corrupt() -> PreviewError {
    PreviewError::coded("This password-protected file is damaged and can't be previewed.", OFFICE_PREVIEW_PASSWORD_CORRUPT)
}

fn preview_unavailable() -> PreviewError {
    PreviewError::coded(
        "Previewing Office files needs LibreOffice or Microsoft Office, and neither was found. To install LibreOffice, open Extensions → Built-in → Office and choose Install, then try again.",
        OFFICE_PREVIEW_UNAVAILABLE,
    )
}

/// `String(value)` of a host's `error` member.
fn js_text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.as_f64().map_or_else(|| number.to_string(), mixdog_js::number_to_string),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items.iter().map(|item| if item.is_null() { String::new() } else { js_text(Some(item)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

/// JavaScript truthiness of a host's `error` member.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Some(_) => true,
    }
}

/// An engine's error text may echo what it was given; the password never leaves in it.
fn without_password(text: &str, password: &str) -> String {
    if password.is_empty() { text.to_owned() } else { text.replace(password, "***") }
}

/// What protects a document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Protection {
    /// An encrypted package this module unlocks with the password.
    Package,
    /// Integrity data that cannot be checked.
    Corrupt,
    /// An encrypted binary Word document Word opens with a password.
    Word,
    /// A protection no password route opens.
    Unsupported,
    None,
}

/// `protection(path)`, read from the container.
async fn protection(preview: &DocumentPreview, path: &Path) -> Result<Protection, PreviewError> {
    let (target, lower) = (path.to_path_buf(), path.to_string_lossy().to_lowercase());
    job(preview.lanes.interactive_io, move |lane: &InLane<InteractiveIo>| {
        if lower.ends_with(".ppt") {
            return if is_encrypted_binary_presentation(lane, &target) { Protection::Unsupported } else { Protection::None };
        }
        if lower.ends_with(".doc") {
            return if is_encrypted_word_document(lane, &target) { Protection::Word } else { Protection::None };
        }
        const OOXML: [&str; 14] =
            [".docx", ".docm", ".dotx", ".dotm", ".xlsx", ".xlsm", ".xltx", ".xltm", ".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm"];
        if !OOXML.iter().any(|extension| lower.ends_with(extension)) || !is_encrypted_ooxml(lane, &target) {
            return Protection::None;
        }
        match read_ooxml_encryption_info(lane, &target).and_then(|info| ooxml_encryption(&info)) {
            None => Protection::Unsupported,
            Some(descriptor) if malformed(&descriptor) => Protection::Corrupt,
            Some(_) => Protection::Package,
        }
    })
    .await
}

fn malformed(descriptor: &Descriptor) -> bool {
    matches!(descriptor, Descriptor::Agile(agile) if agile.integrity == Some(Integrity::Malformed))
}

/// Whether the Office application of `family` is installed (`officeInstalled`).
async fn office_installed(preview: &DocumentPreview, family: &str) -> bool {
    let detected = preview.engines.detect_office(family.to_owned()).await;
    detected.get("applications").and_then(Value::as_array).is_some_and(|applications| {
        applications.iter().any(|application| application.get("format").and_then(Value::as_str) == Some(family) && truthy(application.get("installed")))
    })
}

/// LibreOffice when it is available, else Microsoft Office. A password only reaches Microsoft Office: a document its host finds
/// protected (a legacy one the container check does not cover) is opened with it there.
async fn render_with_engine(
    preview: &DocumentPreview,
    path: &Path,
    output: &Path,
    format: &str,
    cancel: &CancellationToken,
    password: &str,
) -> Result<(), PreviewError> {
    if preview.engines.libre_office_available().await {
        return preview
            .engines
            .render_libre_office(path.to_path_buf(), output.to_path_buf(), cancel.clone())
            .await
            .map_err(|message| if cancel.is_cancelled() { PreviewError::aborted() } else { PreviewError::plain(message) });
    }
    let family = office_family(format);
    if !office_installed(preview, family).await {
        return Err(preview_unavailable());
    }
    render_with_microsoft_office(preview, path, output, family, cancel, password).await
}

/// Microsoft Office renders a private COPY of the document, read-only; the copy keeps the source unlocked and unreachable.
async fn render_with_microsoft_office(
    preview: &DocumentPreview,
    path: &Path,
    output: &Path,
    family: &str,
    cancel: &CancellationToken,
    password: &str,
) -> Result<(), PreviewError> {
    let scratch = create_scratch(preview.lanes, "mixdog-preview-").await?;
    let mut host_exit = None;
    let outcome = async {
        let copy = scratch.join(path.file_name().unwrap_or_default());
        let (from, to) = (path.to_path_buf(), copy.clone());
        job(preview.lanes.durability_io, move |lane: &InLane<DurabilityIo>| mixdog_fsio::copy(lane, &from, &to))
            .await?
            .map_err(|error| super::system_error(&error, &format!("copyfile '{}' ->", path.display()), &copy))?;
        let mut request = Map::new();
        request.insert("action".to_owned(), json!("render"));
        request.insert("format".to_owned(), json!(family));
        request.insert("mode".to_owned(), json!("background"));
        request.insert("readOnly".to_owned(), json!(true));
        request.insert("path".to_owned(), json!(copy.to_string_lossy()));
        request.insert("output".to_owned(), json!(output.to_string_lossy()));
        if !password.is_empty() {
            request.insert("password".to_owned(), json!(password));
        }
        let answer = preview.engines.call_office(Value::Object(request), OFFICE_RENDER_TIMEOUT, cancel.clone()).await;
        host_exit = answer.host_exit;
        if cancel.is_cancelled() {
            return Err(PreviewError::aborted());
        }
        if truthy(answer.value.get("ok")) {
            return Ok(());
        }
        let error = answer.value.get("error");
        let text = js_text(error);
        if text.contains(OFFICE_PREVIEW_WRONG_PASSWORD) {
            return Err(wrong_password());
        }
        if text.contains(OFFICE_PREVIEW_PASSWORD_PROTECTED) {
            return Err(password_protected());
        }
        let shown = if truthy(error) { text } else { "Microsoft Office could not render this document.".to_owned() };
        Err(PreviewError::plain(without_password(&shown, password)))
    }
    .await;
    remove_scratch(Arc::clone(&preview.engines), scratch, host_exit).await;
    outcome
}

/// The key of an encrypted package when `password` is right, derived on a thread of its own that the request's cancellation ends.
async fn derive_key(preview: &DocumentPreview, descriptor: &Descriptor, password: &str, cancel: &CancellationToken) -> Result<Option<Vec<u8>>, PreviewError> {
    let token = CancelToken::new();
    let key_error = |error: KeyError| match error {
        KeyError::Cancelled => PreviewError::aborted(),
        other => PreviewError::plain(other.to_string()),
    };
    let derivation = KeyDerivation::start(descriptor, password, &token).map_err(key_error)?;
    let (stop, request) = (token.clone(), cancel.clone());
    let watcher = tokio::spawn(async move {
        request.cancelled().await;
        stop.cancel();
    });
    // The watcher sits in this worker's run-next slot, which no other worker steals from; the lane job below can hold this thread
    // for the whole derivation, so the watcher is polled once now and then waits for its wake-up from anywhere.
    tokio::task::yield_now().await;
    let waited = job(preview.lanes.cpu_bulk, move |_: &InLane<CpuBulk>| derivation.wait()).await;
    watcher.abort();
    waited?.map_err(key_error)
}

/// An encrypted OOXML package, opened with its password and rendered from a private decrypted copy.
async fn render_unlocked_package(
    preview: &DocumentPreview,
    path: &Path,
    output: &Path,
    format: &str,
    cancel: &CancellationToken,
    password: &str,
) -> Result<(), PreviewError> {
    let target = path.to_path_buf();
    let read = job(preview.lanes.interactive_io, move |lane: &InLane<InteractiveIo>| {
        read_encrypted_ooxml(lane, &target)
            .and_then(|encrypted| ooxml_encryption(&encrypted.encryption_info).map(|descriptor| (descriptor, encrypted.encrypted_package)))
    })
    .await?;
    let Some((descriptor, encrypted_package)) = read else { return Err(password_unsupported()) };
    if malformed(&descriptor) {
        return Err(password_corrupt());
    }
    let key = derive_key(preview, &descriptor, password, cancel).await?.ok_or_else(wrong_password)?;
    let plain = job(preview.lanes.cpu_bulk, move |_: &InLane<CpuBulk>| match package_intact(&descriptor, &key, &encrypted_package) {
        Ok(true) => decrypt_package(&descriptor, &key, &encrypted_package).map_err(|error| PreviewError::plain(error.to_string())),
        Ok(false) => Err(password_corrupt()),
        Err(error) => Err(PreviewError::plain(error.to_string())),
    })
    .await??;
    if cancel.is_cancelled() {
        return Err(PreviewError::aborted());
    }
    let scratch = create_scratch(preview.lanes, "mixdog-unlocked-").await?;
    let outcome = render_decrypted(preview, path, output, format, cancel, &scratch, plain).await;
    remove_scratch(Arc::clone(&preview.engines), scratch, None).await;
    outcome
}

async fn render_decrypted(
    preview: &DocumentPreview,
    path: &Path,
    output: &Path,
    format: &str,
    cancel: &CancellationToken,
    scratch: &Path,
    plain: Vec<u8>,
) -> Result<(), PreviewError> {
    let copy = scratch.join(path.file_name().unwrap_or_default());
    let target = copy.clone();
    job(preview.lanes.durability_io, move |lane: &InLane<DurabilityIo>| write_private(lane, &target, &plain))
        .await?
        .map_err(|error| PreviewError::plain(error.to_string()))?;
    render_with_engine(preview, &copy, output, format, cancel, "").await
}

/// A file only its owner can read (mode 0600).
fn write_private(lane: &InLane<DurabilityIo>, path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(lane, path)?.write_all(bytes)
}

async fn render_preview_pdf(
    preview: &DocumentPreview,
    path: &Path,
    output: &Path,
    format: &str,
    cancel: &CancellationToken,
    password: &str,
) -> Result<(), PreviewError> {
    match protection(preview, path).await? {
        Protection::Unsupported => Err(password_unsupported()),
        Protection::Corrupt => Err(password_corrupt()),
        Protection::Package if password.is_empty() => Err(password_protected()),
        Protection::Package => render_unlocked_package(preview, path, output, format, cancel, password).await,
        Protection::Word => {
            // LibreOffice's conversion takes no password, so only Word can open it.
            if !office_installed(preview, "docx").await {
                return Err(password_needs_office());
            }
            if password.is_empty() {
                return Err(password_protected());
            }
            render_with_microsoft_office(preview, path, output, "docx", cancel, password).await
        }
        Protection::None => render_with_engine(preview, path, output, format, cancel, password).await,
    }
}

async fn metadata(preview: &DocumentPreview, path: &Path) -> Result<io::Result<Metadata>, PreviewError> {
    let target = path.to_path_buf();
    job(preview.lanes.interactive_io, move |lane: &InLane<InteractiveIo>| mixdog_fsio::metadata(lane, &target)).await
}

/// The unlocked PDF of this document, when this process holds one.
async fn unlocked_preview(preview: &DocumentPreview, key: &str) -> Result<Option<PathBuf>, PreviewError> {
    let Some(entry) = preview.state.unlocked.get(key) else { return Ok(None) };
    let output = entry.output.clone();
    let ready = job(preview.lanes.interactive_io, move |lane: &InLane<InteractiveIo>| file_size(lane, &output)).await?;
    if ready.is_none() {
        forget_unlocked(preview, key);
        return Ok(None);
    }
    // Most recently used last, so eviction drops the one nobody looked at.
    preview.state.unlocked.touch(key);
    Ok(Some(entry.output))
}

/// An entry pushed out is no longer served at once; its directory stays tracked (and its pages off disk) until its removal is
/// confirmed.
fn forget_unlocked(preview: &DocumentPreview, key: &str) {
    if let Some(entry) = preview.state.unlocked.forget(key) {
        remove_in_background(preview, entry);
    }
}

fn remove_in_background(preview: &DocumentPreview, entry: UnlockedEntry) {
    let engines = Arc::clone(&preview.engines);
    tokio::spawn(remove_scratch(engines, entry.directory, None));
}

/// A document opened with its password is never written to the cache: its PDF lives in a private scratch directory.
async fn render_unlocked(
    preview: &DocumentPreview,
    path: &Path,
    key: &str,
    identity: &Identity,
    format: &str,
    cancel: &CancellationToken,
    password: &str,
) -> Result<PdfPreview, PreviewError> {
    let directory = create_scratch(preview.lanes, "mixdog-unlocked-preview-").await?;
    let output = directory.join(PREVIEW_PDF_NAME);
    if let Err(error) = render_preview_pdf(preview, path, &output, format, cancel, password).await {
        remove_scratch(Arc::clone(&preview.engines), directory, None).await;
        return Err(error);
    }
    for pushed in preview.state.unlocked.remember(key, UnlockedEntry { directory, output: output.clone() }) {
        remove_in_background(preview, pushed);
    }
    Ok(PdfPreview { path: output, format: format.to_owned(), mtime_ms: identity.mtime_ms, size: identity.size, cached: false })
}

/// The name of one conversion's staging directory: unique among all conversions of the cache root, which is all the name is for
/// (who owns a directory is its lock, never its name).
fn staging_name(directory: &Path) -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_nanos());
    format!(
        "{}-{}-{nanos}-{}",
        directory.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    )
}

/// The conversion of a document that is not cached: its PDF made in a staging directory and published in the cache directory.
async fn convert(
    preview: &DocumentPreview,
    path: &Path,
    format: &str,
    directory: &Path,
    output: &Path,
    identity: &Identity,
    cancel: &CancellationToken,
) -> Result<PdfPreview, PreviewError> {
    let (name, documents) = (staging_name(directory), directory.parent().map(Path::to_path_buf));
    let cache_root = documents.as_deref().and_then(Path::parent).unwrap_or(directory).to_path_buf();
    let owner = job(preview.lanes.durability_io, move |lane: &InLane<DurabilityIo>| {
        // The folder of cached documents exists once a conversion was tried, as it did when the conversion wrote into it.
        if let Some(documents) = &documents {
            mixdog_fsio::create_dir_all(lane, documents)?;
        }
        reclaim_staging(lane, &cache_root);
        StagingOwner::claim(lane, &cache_root, &name)
    })
    .await?
    .map_err(|error| PreviewError::plain(error.to_string()))?;
    let made = owner.directory().join(PREVIEW_PDF_NAME);
    let rendered = render_preview_pdf(preview, path, &made, format, cancel, "").await;
    let published = match rendered {
        Ok(()) => {
            let (to, target) = (output.to_path_buf(), directory.to_path_buf());
            job(preview.lanes.durability_io, {
                let from = made.clone();
                move |lane: &InLane<DurabilityIo>| publish(lane, &from, &to, &target)
            })
            .await?
            .map_err(|error| PreviewError::plain(error.to_string()))
        }
        Err(error) => Err(error),
    };
    let _ = job(preview.lanes.durability_io, move |lane: &InLane<DurabilityIo>| owner.release(lane)).await;
    published?;
    if let Some(root) = directory.parent() {
        let root = root.to_path_buf();
        job(preview.lanes.durability_io, move |lane: &InLane<DurabilityIo>| prune_cache(lane, &root)).await?;
    }
    Ok(PdfPreview { path: output.to_path_buf(), format: format.to_owned(), mtime_ms: identity.mtime_ms, size: identity.size, cached: false })
}

pub(super) async fn preview_pdf(preview: &DocumentPreview, path: &Path, options: PreviewOptions) -> Result<PdfPreview, PreviewError> {
    let path_text = path.to_string_lossy().into_owned();
    let Some(format) = preview_format(&path_text) else { return Err(PreviewError::plain(NOT_A_PREVIEW_TYPE)) };
    if options.cache_root.is_empty() {
        return Err(PreviewError::plain("Document preview storage is unavailable."));
    }
    let info = metadata(preview, path).await?.map_err(|error| stat_error(&error, path))?;
    if !info.is_file() {
        return Err(PreviewError::plain("Not a file."));
    }
    let identity = identity_of(&info);
    let key = cache_key(&path_text, identity);
    let directory = Path::new(&options.cache_root).join(DOCUMENT_CACHE_DIRECTORY).join(&key);
    let output = directory.join(PREVIEW_PDF_NAME);
    let result = |path: PathBuf, cached: bool| PdfPreview { path, format: format.to_owned(), mtime_ms: identity.mtime_ms, size: identity.size, cached };
    if let Some(unlocked) = unlocked_preview(preview, &key).await? {
        return Ok(result(unlocked, true));
    }
    if !options.password.is_empty() {
        return render_unlocked(preview, path, &key, &identity, format, &options.cancel, &options.password).await;
    }
    let (ready, touched) = (output.clone(), directory.clone());
    let cached = job(preview.lanes.durability_io, move |lane: &InLane<DurabilityIo>| {
        let present = file_size(lane, &ready).is_some_and(|size| size > 0);
        // Touch on USE, so eviction drops what nobody opens rather than what was converted longest ago.
        if present {
            touch_directory(lane, &touched);
        }
        present
    })
    .await?;
    if cached {
        return Ok(result(output, true));
    }
    preview
        .state
        .conversions
        .run(
            &output,
            || async {
                let ready = output.clone();
                let present = job(preview.lanes.durability_io, move |lane: &InLane<DurabilityIo>| file_size(lane, &ready).is_some_and(|size| size > 0)).await?;
                Ok(present.then(|| result(output.clone(), true)))
            },
            || convert(preview, path, format, &directory, &output, &identity, &options.cancel),
        )
        .await
}
