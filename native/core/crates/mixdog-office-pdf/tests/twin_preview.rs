//! Twin test `preview`: Node's document preview (`native/core/fixtures/office-preview/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-preview.mjs`) against this crate. Both sides run the same documents through
//! fake engines (LibreOffice present or hidden, Microsoft Office installed or not and what its host answers): the result of
//! every step (format, size, cached, where the PDF is, the coded error with its message), the calls each engine got (the content
//! it was handed, the request fields, whether the password reached it), the cache layout, the scratch tracking and the reply of
//! every page request with the files the page cache holds must equal the recording exactly. Re-recording is
//! `twin_live_preview` (ignored: it runs Node).

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;
use mixdog_office_pdf::preview::{
    BoxFuture, DocumentPreview, OfficeAnswer, PageRenderer, PagesOptions, PreviewEngines, PreviewError, PreviewOptions, RawImage, RawPages,
    remove_tracked_preview_scratch_sync, tracked_preview_scratch,
};
use mixdog_rt::CancellationToken;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const SET: &str = "office-preview";
const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-preview.mjs";

/// Writes `contents` and moves the file's modification time on, as the time between two edits does in life: two writes within
/// one tick of the file system's clock would otherwise leave the same identity (modification time and size) behind.
#[allow(clippy::disallowed_methods, reason = "a test sets a file's modification time, which the lane API has no call for")]
fn rewrite(path: &std::path::Path, contents: impl AsRef<[u8]>) {
    static EDITS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    mixdog_testkit::write(path, contents);
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(10 * EDITS.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
    std::fs::File::options().write(true).open(path).and_then(|file| file.set_modified(later)).expect("the modification time moves on");
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode(text: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(text).expect("base64")
}

fn block<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime").block_on(future)
}

/// The fake engines of a case: what the recorder's engines do, and the calls in the shape it records them.
struct Fake {
    dir: PathBuf,
    source: PathBuf,
    cache_root: String,
    password: Mutex<String>,
    libre: bool,
    installed: Vec<String>,
    office: String,
    libre_calls: Mutex<Vec<Value>>,
    detect_calls: Mutex<Vec<Value>>,
    office_calls: Mutex<Vec<Value>>,
    scratch_seen: Mutex<Vec<PathBuf>>,
}

impl Fake {
    fn take(&self) -> Value {
        let take = |calls: &Mutex<Vec<Value>>| Value::Array(std::mem::take(&mut *calls.lock().expect("calls")));
        json!({"libreOffice": take(&self.libre_calls), "detect": take(&self.detect_calls), "office": take(&self.office_calls)})
    }
}

impl PreviewEngines for Fake {
    fn libre_office_available(&self) -> BoxFuture<'_, bool> {
        Box::pin(async move { self.libre })
    }

    fn render_libre_office(&self, path: PathBuf, output: PathBuf, _cancel: CancellationToken) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.libre_calls.lock().expect("calls").push(json!({
                "file": path.file_name().expect("name").to_string_lossy(),
                "sourceUntouched": !path.starts_with(&self.dir),
                "sha256": sha256(&mixdog_testkit::read(&path)),
            }));
            mixdog_testkit::write(&output, "pdf from libreoffice");
            Ok(())
        })
    }

    fn detect_office(&self, format: String) -> BoxFuture<'_, Value> {
        Box::pin(async move {
            self.detect_calls.lock().expect("calls").push(json!({"format": format}));
            json!({"ok": true, "applications": self.installed.iter().map(|format| json!({"format": format, "installed": true})).collect::<Vec<_>>()})
        })
    }

    fn call_office(&self, request: Value, timeout: Duration, _cancel: CancellationToken) -> BoxFuture<'_, OfficeAnswer> {
        Box::pin(async move {
            let path = PathBuf::from(request["path"].as_str().expect("path"));
            let output = request["output"].as_str().expect("output");
            self.scratch_seen.lock().expect("seen").push(path.parent().expect("scratch").to_path_buf());
            let mut keys: Vec<&str> = request.as_object().expect("object").keys().map(String::as_str).collect();
            keys.sort_unstable();
            self.office_calls.lock().expect("calls").push(json!({
                "action": request["action"],
                "format": request["format"],
                "mode": request["mode"],
                "readOnly": request["readOnly"],
                "keys": keys,
                "file": path.file_name().expect("name").to_string_lossy(),
                "copyIsSource": path == self.source,
                "copyExisted": mixdog_testkit::exists(&path),
                "outputInCache": !self.cache_root.is_empty() && Path::new(output).starts_with(&self.cache_root),
                "outputName": Path::new(output).file_name().expect("name").to_string_lossy(),
                "passwordIsTheGiven": request.get("password").and_then(Value::as_str) == Some(self.password.lock().expect("password").as_str()),
                "timeoutMs": u64::try_from(timeout.as_millis()).expect("milliseconds"),
                "sha256": sha256(&mixdog_testkit::read(&path)),
            }));
            let value = match self.office.as_str() {
                "ok" => {
                    mixdog_testkit::write(output, "pdf from office");
                    json!({"ok": true, "output": output})
                }
                "fail" => json!({"ok": false, "error": "Excel could not open the file"}),
                "wrong-password" => json!({"ok": false, "error": "That password didn't work. (OFFICE_PREVIEW_WRONG_PASSWORD)"}),
                "protected" => json!({"ok": false, "error": "This file is password-protected. (OFFICE_PREVIEW_PASSWORD_PROTECTED)"}),
                "echo-password" => json!({"ok": false, "error": format!("Word failed opening {} somehow", self.password.lock().expect("password"))}),
                _ => json!({"ok": false}),
            };
            OfficeAnswer { value, host_exit: None }
        })
    }

    fn remove_directory(&self, directory: PathBuf) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(async move {
            mixdog_testkit::remove_dir_all(&directory);
            Ok(())
        })
    }

    fn remove_backoff(&self) -> Duration {
        Duration::from_millis(1)
    }
}

/// A rasteriser that is never asked for a page.
struct NoPages;

impl PageRenderer for NoPages {
    fn render_pages(&self, _: PathBuf, _: Vec<u64>, _: u32, _: CancellationToken) -> BoxFuture<'_, Result<RawPages, PreviewError>> {
        Box::pin(async { Err(PreviewError::plain("no rasteriser")) })
    }
}

/// A folder name of a cache as the recording writes it: the 32-digit document key, the revision of a PDF.
fn named(segment: &str) -> String {
    let hex = |text: &str| text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if segment.len() == 32 && hex(segment) {
        "<key>".to_owned()
    } else if segment.len() == 33 && segment.as_bytes()[16] == b'-' && hex(&segment[..16]) && hex(&segment[17..]) {
        "<revision>".to_owned()
    } else {
        segment.to_owned()
    }
}

fn listing(root: &Path) -> Value {
    if !mixdog_testkit::exists(root) {
        return json!([]);
    }
    let mut files: Vec<String> = mixdog_testkit::tree(root).into_iter().map(|(path, _)| path.split('/').map(named).collect::<Vec<_>>().join("/")).collect();
    files.sort();
    json!(files)
}

fn directories(root: &Path) -> usize {
    if !mixdog_testkit::exists(root) {
        return 0;
    }
    mixdog_testkit::entry_names(root).iter().filter(|name| mixdog_testkit::is_dir(root.join(name))).count()
}

fn failure_of(error: &PreviewError, dir: &Path) -> Value {
    let shown = |text: &str| text.replace(&dir.to_string_lossy().into_owned(), "<dir>").replace(&dir.to_string_lossy().replace('\\', "/"), "<dir>");
    json!({"ok": false, "code": error.code(), "name": "Error", "message": shown(error.message())})
}

fn replay_cases(golden: &Value) {
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("twin-preview");
    let cases = golden["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    for (number, case) in cases.iter().enumerate() {
        let name = case["name"].as_str().expect("name");
        let dir = root.join(format!("case-{number}"));
        if mixdog_testkit::exists(&dir) {
            mixdog_testkit::remove_dir_all(&dir);
        }
        mixdog_testkit::create_dir_all(&dir);
        let source = dir.join(case["fileName"].as_str().expect("fileName"));
        if let Some(document) = case["document"].as_str() {
            mixdog_testkit::write(&source, decode(golden["documents"][document].as_str().expect("document")));
        }
        let cache_root = dir.join("cache");
        let spec = &case["spec"];
        let fake = Arc::new(Fake {
            dir: dir.clone(),
            source: source.clone(),
            cache_root: cache_root.to_string_lossy().into_owned(),
            password: Mutex::new(String::new()),
            libre: spec["libreOffice"] == true,
            installed: spec["installed"].as_array().map(|list| list.iter().map(|item| item.as_str().expect("family").to_owned()).collect()).unwrap_or_default(),
            office: spec["office"].as_str().unwrap_or("ok").to_owned(),
            libre_calls: Mutex::new(Vec::new()),
            detect_calls: Mutex::new(Vec::new()),
            office_calls: Mutex::new(Vec::new()),
            scratch_seen: Mutex::new(Vec::new()),
        });
        let preview = DocumentPreview::new(mixdog_rt::testing::tokens(), Arc::clone(&fake) as Arc<dyn PreviewEngines>, Arc::new(NoPages));
        for (index, recorded) in case["steps"].as_array().expect("steps").iter().enumerate() {
            let step = &recorded["step"];
            let given = step["password"].as_str().unwrap_or("");
            *fake.password.lock().expect("password") = given.to_owned();
            let cache_text = if step["noCacheRoot"] == true { String::new() } else { cache_root.to_string_lossy().into_owned() };
            let before: HashSet<PathBuf> = tracked_preview_scratch().into_iter().collect();
            if let Some(bytes) = step["rewrite"].as_str() {
                rewrite(&source, decode(bytes));
            }
            if let Some(made) = step["makeDirectory"].as_str() {
                mixdog_testkit::create_dir_all(dir.join(made));
            }
            let options = PreviewOptions { cache_root: cache_text, password: given.to_owned(), ..PreviewOptions::default() };
            let attempt = |preview: DocumentPreview, source: PathBuf, options: PreviewOptions, cache_root: PathBuf, dir: PathBuf| async move {
                match preview.preview_pdf(&source, options).await {
                    Ok(result) => json!({
                        "ok": true,
                        "format": result.format,
                        "size": result.size,
                        "cached": result.cached,
                        "location": if result.path.starts_with(&cache_root) { "cache" } else { "scratch" },
                        "pdf": if mixdog_testkit::exists(&result.path) { Value::String(mixdog_testkit::read_string(&result.path)) } else { Value::Null },
                        "pdfName": result.path.file_name().expect("name").to_string_lossy(),
                    }),
                    Err(error) => failure_of(&error, &dir),
                }
            };
            let results: Vec<Value> = block(async {
                if step["concurrent"] == true {
                    let one = tokio::spawn(attempt(preview.clone(), source.clone(), options.clone(), cache_root.clone(), dir.clone()));
                    let two = tokio::spawn(attempt(preview.clone(), source.clone(), options.clone(), cache_root.clone(), dir.clone()));
                    vec![one.await.expect("task"), two.await.expect("task")]
                } else {
                    vec![attempt(preview.clone(), source.clone(), options.clone(), cache_root.clone(), dir.clone()).await]
                }
            });
            let seen = fake.scratch_seen.lock().expect("seen").clone();
            let produced = json!({
                "results": results,
                "calls": fake.take(),
                "cache": listing(&cache_root),
                "documentDirectories": directories(&cache_root.join("document-previews")),
                "scratchLeft": seen.iter().filter(|directory| mixdog_testkit::exists(directory)).count(),
                "newTracked": tracked_preview_scratch().into_iter().filter(|directory| !before.contains(directory)).count(),
            });
            let want = json!({
                "results": recorded["results"],
                "calls": recorded["calls"],
                "cache": recorded["cache"],
                "documentDirectories": recorded["documentDirectories"],
                "scratchLeft": recorded["scratchLeft"],
                "newTracked": recorded["newTracked"],
            });
            twin::assert_matches(&format!("{name}, step {}", index + 1), &want, &produced);
        }
        remove_tracked_preview_scratch_sync(&Unlaned);
    }
}

/// `px-<call>-<page>` for every page asked, a width the request names and a height of 10: the recorder's rasteriser.
struct Pixels {
    calls: Mutex<Vec<(Vec<u64>, u32)>>,
}

impl PageRenderer for Pixels {
    fn render_pages(&self, _pdf: PathBuf, pages: Vec<u64>, max_width: u32, _cancel: CancellationToken) -> BoxFuture<'_, Result<RawPages, PreviewError>> {
        Box::pin(async move {
            let mut calls = self.calls.lock().expect("calls");
            calls.push((pages.clone(), max_width));
            let call = calls.len();
            let images = pages
                .iter()
                .map(|page| RawImage { page: *page, width: u64::from(max_width), height: 10, mime_type: Some("image/png".to_owned()), data: format!("px-{call}-{page}") })
                .collect();
            Ok(RawPages { page_count: 5, images })
        })
    }
}

fn replay_pages(golden: &Value) {
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("twin-preview-pages");
    for (number, case) in golden["pages"].as_array().expect("pages").iter().enumerate() {
        let name = case["name"].as_str().expect("name");
        let dir = root.join(format!("case-{number}"));
        if mixdog_testkit::exists(&dir) {
            mixdog_testkit::remove_dir_all(&dir);
        }
        mixdog_testkit::create_dir_all(&dir);
        let pdf = dir.join("a.pdf");
        mixdog_testkit::write(&pdf, "rev1");
        let cache_root = dir.join("cache");
        let pixels = Arc::new(Pixels { calls: Mutex::new(Vec::new()) });
        let preview = DocumentPreview::new(mixdog_rt::testing::tokens(), Arc::new(NoEngines), Arc::clone(&pixels) as Arc<dyn PageRenderer>);
        for (index, recorded) in case["steps"].as_array().expect("steps").iter().enumerate() {
            let step = &recorded["step"];
            if let Some(text) = step["rewrite"].as_str() {
                rewrite(&pdf, text);
            }
            let mut options = PagesOptions { cache_root: if step["noCacheRoot"] == true { String::new() } else { cache_root.to_string_lossy().into_owned() }, ..PagesOptions::default() };
            if let Some(pages) = step["pages"].as_array() {
                options.pages = pages.iter().map(|page| page.as_u64().expect("page")).collect();
            }
            if let Some(width) = step["maxWidth"].as_u64() {
                options.max_width = u32::try_from(width).expect("width");
            }
            let before = pixels.calls.lock().expect("calls").len();
            let reply = block(preview.preview_pages(&pdf, options)).expect("pages").to_json();
            let calls: Vec<Value> = pixels.calls.lock().expect("calls")[before..].iter().map(|(pages, width)| json!({"pages": pages, "maxWidth": width})).collect();
            let produced = json!({"reply": reply, "calls": calls, "files": listing(&cache_root)});
            let want = json!({"reply": recorded["reply"], "calls": recorded["calls"], "files": recorded["files"]});
            twin::assert_matches(&format!("{name}, step {}", index + 1), &want, &produced);
        }
    }
}

/// Engines for a preview that only rasterises pages: none is asked for.
struct NoEngines;

impl PreviewEngines for NoEngines {
    fn libre_office_available(&self) -> BoxFuture<'_, bool> {
        Box::pin(async { false })
    }

    fn render_libre_office(&self, _: PathBuf, _: PathBuf, _: CancellationToken) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Err("no engine".to_owned()) })
    }

    fn detect_office(&self, _: String) -> BoxFuture<'_, Value> {
        Box::pin(async { json!({"ok": true, "applications": []}) })
    }

    fn call_office(&self, _: Value, _: Duration, _: CancellationToken) -> BoxFuture<'_, OfficeAnswer> {
        Box::pin(async { OfficeAnswer { value: json!({"ok": false}), host_exit: None } })
    }

    fn remove_directory(&self, directory: PathBuf) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(async move {
            mixdog_testkit::remove_dir_all(&directory);
            Ok(())
        })
    }
}

fn replay(golden: &Value) {
    replay_cases(golden);
    replay_pages(golden);
}

#[test]
fn twin_preview() {
    replay(&twin::load_golden(SET));
}

/// Records again with Node (`MIXDOG_BENCH_TREE=<product tree with node_modules>`) and replays the new recording. The documents
/// carry the random salts of the encryption, so the new recording is not the old one byte for byte.
#[test]
#[ignore = "runs node: re-records the fixture"]
fn twin_live_preview() {
    let printed = twin::run_recorder(RECORDER, &twin::node_source_root());
    assert!(printed.is_empty() || !printed.contains("Error"), "the recorder failed: {printed}");
    replay(&twin::load_golden(SET));
}
