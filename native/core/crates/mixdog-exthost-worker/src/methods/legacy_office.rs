//! `media.legacyOffice` (`convertLegacyOfficeBuffer` of `src/runtime/attachments/legacy-office.mjs`): a legacy Office attachment
//! (`.doc`, `.xls`, `.ppt`, an OLE compound file) saved by LibreOffice as the OOXML package of `kind`, so the text extraction and
//! every later lowering see an ordinary package. The bytes arrive base64 as a message part carries them and go back the same way;
//! no path of the user's is touched.
//!
//! A failure (LibreOffice missing, a damaged or protected file, bytes that are not a legacy Office file) answers with the
//! converter's own message, the scratch path taken out; the caller puts that text in front of the model.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_ooxml::soffice::profile::redact_directories;
use mixdog_ooxml::soffice::{ConvertError, ScratchHooks, Soffice, remove_scratch_with};
use mixdog_ooxml_text::legacy::is_legacy_office_buffer;
use mixdog_rt::{CancellationToken, InLane, LaneToken, MaintenanceIo};
use serde_json::json;

use super::pdf_render::lanes;
use super::{base64_param, invalid_params, node_base64};
use crate::ctx::CallCtx;
use crate::error::CodedError;
use crate::registry::{HandlerResult, Outcome, Registry};

pub(super) fn register(registry: &mut Registry) {
    registry.register("media.legacyOffice", legacy_office);
}

/// The extension a legacy file of the package `kind` carries.
fn legacy_extension(kind: &str) -> Option<&'static str> {
    match kind {
        "docx" => Some("doc"),
        "xlsx" => Some("xls"),
        "pptx" => Some("ppt"),
        _ => None,
    }
}

/// `basename(filename, extname(filename))` of `filename` (`attachment` when nothing is left).
fn stem_of(filename: &str) -> String {
    let base = filename.rsplit(['/', '\\']).next().unwrap_or("");
    let stem = match base.rfind('.') {
        Some(at) if at > 0 => &base[..at],
        _ => base,
    };
    if stem.is_empty() { "attachment".to_owned() } else { stem.to_owned() }
}

/// The stem as a file name the converter takes: `[^\w.-]+` runs become `_`, at most 80 characters.
fn safe_stem(stem: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    out.truncate(80);
    if out.is_empty() { "attachment".to_owned() } else { out }
}

/// What a conversion that ended without a package says.
enum Ended {
    Aborted,
    Failed(String),
}

/// One conversion in a scratch folder of its own, which is removed on every path out: a busy folder is retried and a removal that
/// keeps failing is logged, as `removeDirectoryWithRetry` does for `convertLegacyOfficeBuffer`; it never fails the conversion.
fn convert(
    lane: &InLane<MaintenanceIo>,
    bytes: &[u8],
    safe: &str,
    kind: &str,
    legacy: &str,
    cancel: &AtomicBool,
    scratch: &ScratchHooks,
) -> Result<Vec<u8>, Ended> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_nanos());
    let dir = std::env::temp_dir().join(format!("mixdog-attachment-{}-{nanos}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
    let outcome = (|| -> Result<Vec<u8>, Ended> {
        let failed = |message: String| Ended::Failed(redact_directories(&message, &[dir.as_path()]));
        mixdog_fsio::create_dir_all(lane, &dir).map_err(|error| failed(error.to_string()))?;
        let (source, output) = (dir.join(format!("{safe}.{legacy}")), dir.join(format!("{safe}.{kind}")));
        mixdog_fsio::write(lane, &source, bytes).map_err(|error| failed(error.to_string()))?;
        match Soffice::process().convert_legacy_office(lane, &source, &output, Some(cancel), &ScratchHooks::default()) {
            Ok(_) => {}
            Err(ConvertError::Aborted(_)) => return Err(Ended::Aborted),
            Err(ConvertError::Failed(message)) => return Err(failed(message)),
        }
        mixdog_fsio::read(lane, &output).map_err(|error| failed(error.to_string()))
    })();
    remove_scratch_with(lane, &dir, scratch);
    outcome
}

async fn legacy_office(ctx: CallCtx) -> HandlerResult {
    let bytes = node_base64(base64_param(&ctx.params)?);
    let filename = ctx.params.get("filename").and_then(|name| name.as_str()).unwrap_or_default().to_owned();
    let kind = ctx.params.get("kind").and_then(|kind| kind.as_str()).unwrap_or_default();
    let Some(legacy) = legacy_extension(kind) else { return Err(invalid_params("kind must be docx, xlsx or pptx")) };
    if ctx.cancel.is_cancelled() {
        return Err(CodedError::cancelled());
    }
    if !is_legacy_office_buffer(&bytes) {
        let name = if filename.is_empty() { "This attachment" } else { filename.as_str() };
        return Err(CodedError::failed(format!(
            "{name} is labelled as a legacy Office file but its content is not one, so it cannot be converted. Open it in Microsoft Office and save it as .{kind}, then attach that copy."
        )));
    }
    let stem = stem_of(&filename);
    let safe = safe_stem(&stem);
    let (kind, legacy) = (kind.to_owned(), legacy.to_owned());
    let lanes = lanes()?;
    // The blocking driver reads a flag: a watcher raises it when the call is cancelled, and is polled once before a lane job
    // holds this thread.
    let flag = Arc::new(AtomicBool::new(false));
    let (raised, token) = (Arc::clone(&flag), ctx.cancel.clone());
    let watcher = tokio::spawn(async move {
        token.cancelled().await;
        raised.store(true, Ordering::SeqCst);
    });
    tokio::task::yield_now().await;
    let package_kind = kind.clone();
    let never = CancellationToken::new();
    let submitted = lanes
        .maintenance_io
        .submit_wait(&never, move |lane: &InLane<MaintenanceIo>| convert(lane, &bytes, &safe, &package_kind, &legacy, flag.as_ref(), &ScratchHooks::default()))
        .await
        .map_err(|error| CodedError::failed(error.to_string()));
    let converted = match submitted {
        Ok(handle) => handle.await.map_err(|error| CodedError::failed(error.to_string())),
        Err(error) => Err(error),
    };
    watcher.abort();
    match converted? {
        Ok(package) => Ok(Outcome::value(json!({"data": STANDARD.encode(package), "filename": format!("{stem}.{kind}")}))),
        Err(Ended::Aborted) => Err(CodedError::cancelled()),
        Err(Ended::Failed(message)) => Err(CodedError::failed(message)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stem_drops_the_extension_and_is_made_a_safe_file_name() {
        assert_eq!(stem_of("C:\\docs\\Q3 report.v2.doc"), "Q3 report.v2");
        assert_eq!(stem_of(".doc"), ".doc");
        assert_eq!(stem_of(""), "attachment");
        assert_eq!(safe_stem("Q3 report (final)"), "Q3_report_final_");
        assert_eq!(safe_stem("한글"), "_");
        assert_eq!(safe_stem(&"a".repeat(100)).len(), 80);
    }

    /// A sharing violation on the scratch folder is retried as Node's `removeDirectoryWithRetry` does (six attempts), then logged
    /// once with the folder named; the conversion's own answer is not changed by it, and the folder is the one this call made.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_scratch_folder_that_stays_busy_is_retried_and_logged_not_lost() {
        use std::sync::Mutex;
        let attempts = Arc::new(AtomicU64::new(0));
        let logged = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = Arc::new(Mutex::new(Vec::<std::path::PathBuf>::new()));
        let (counted, lines, dirs) = (Arc::clone(&attempts), Arc::clone(&logged), Arc::clone(&seen));
        let busy = move |dir: &std::path::Path| {
            counted.fetch_add(1, Ordering::SeqCst);
            dirs.lock().unwrap().push(dir.to_path_buf());
            Err(std::io::Error::from_raw_os_error(if cfg!(windows) { 32 } else { 16 }))
        };
        let log = move |line: &str| lines.lock().unwrap().push(line.to_owned());
        let tokens = mixdog_rt::testing::tokens();
        let never = CancellationToken::new();
        let handle = tokens
            .maintenance_io
            .submit_wait(&never, move |lane: &InLane<MaintenanceIo>| {
                // Whatever the converter answers (this machine may or may not have LibreOffice), the folder is removed on the way
                // out and the answer is the one an unobstructed removal gives: the first call is that baseline.
                let answer = |hooks: &ScratchHooks| {
                    convert(lane, b"not a legacy file", "x", "docx", "doc", &AtomicBool::new(true), hooks).err().map(|ended| matches!(ended, Ended::Failed(_)))
                };
                let baseline = answer(&ScratchHooks::default());
                (baseline, answer(&ScratchHooks { remove: Some(&busy), log: Some(&log) }))
            })
            .await
            .unwrap();
        let (baseline, busy_answer) = handle.await.unwrap();
        assert!(baseline.is_some(), "the converter answers a cancelled call with an error");
        assert_eq!(busy_answer, baseline, "the conversion still answers as it does without the busy folder");
        assert_eq!(attempts.load(Ordering::SeqCst), 6);
        let logged = logged.lock().unwrap();
        assert_eq!(logged.len(), 1, "{logged:?}");
        let dir = seen.lock().unwrap()[0].clone();
        assert!(logged[0].starts_with(&format!("scratch folder {} could not be removed", dir.display())), "{logged:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_kind_names_its_legacy_extension() {
        assert_eq!(
            (legacy_extension("docx"), legacy_extension("xlsx"), legacy_extension("pptx"), legacy_extension("odt")),
            (Some("doc"), Some("xls"), Some("ppt"), None)
        );
    }
}
