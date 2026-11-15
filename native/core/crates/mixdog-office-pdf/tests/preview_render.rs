//! `documentPreviewPdf` and `documentPreviewPages` over fake engines: the ports of `document-preview-render.test.mjs` (the
//! conversion cases) and `document-preview-pages.test.mjs`. The documents are the containers of the recording
//! `native/core/fixtures/office-preview/golden.json`, made by the Node tests' own container writer. The twin test
//! (`twin_preview.rs`) holds the cases the recording compares result for result; the password cases are `preview_password.rs`.
//! Not ported: `hostExitSignal` (the end of a host process is the transport's: `mixdog-office-com` tests it).

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use mixdog_office_pdf::preview::{
    BoxFuture, DocumentPreview, OfficeAnswer, PageRenderer, PagesOptions, PdfPreview, PreviewEngines, PreviewError, PreviewOptions, RawImage,
    RawPages,
};
use mixdog_rt::CancellationToken;
use serde_json::{Value, json};

const GOLDEN: &str = include_str!("../../../fixtures/office-preview/golden.json");

fn golden() -> &'static Value {
    static PARSED: OnceLock<Value> = OnceLock::new();
    PARSED.get_or_init(|| serde_json::from_str(GOLDEN).expect("golden.json parses"))
}

fn document(name: &str) -> Vec<u8> {
    let text = golden()["documents"][name].as_str().unwrap_or_else(|| panic!("no document {name}"));
    base64::engine::general_purpose::STANDARD.decode(text).expect("base64")
}

fn block<F: Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime").block_on(future)
}

/// One test's folder under the target directory: the source document, and the cache root beside it.
struct Fixture {
    source: PathBuf,
    cache_root: String,
}

fn fixture(test: &str, name: &str, content: &[u8]) -> Fixture {
    static NUMBER: AtomicUsize = AtomicUsize::new(0);
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("preview-render").join(format!("{test}-{}", NUMBER.fetch_add(1, Ordering::SeqCst)));
    if mixdog_testkit::exists(&dir) {
        mixdog_testkit::remove_dir_all(&dir);
    }
    mixdog_testkit::create_dir_all(&dir);
    let source = dir.join(name);
    mixdog_testkit::write(&source, content);
    let cache_root = dir.join("cache").to_string_lossy().into_owned();
    Fixture { source, cache_root }
}

#[derive(Default)]
struct Calls {
    libre: Vec<(PathBuf, PathBuf)>,
    detect: Vec<String>,
    office: Vec<(Value, bool)>,
}

type OfficeBehaviour = Box<dyn Fn(&Value) -> OfficeAnswer + Send + Sync>;
type Removal = Box<dyn Fn(&Path) -> io::Result<()> + Send + Sync>;

/// Engines that write a marker PDF and remember what they were asked.
struct Fake {
    libre: bool,
    installed: Vec<&'static str>,
    office: OfficeBehaviour,
    removal: Removal,
    calls: Mutex<Calls>,
}

fn pdf_from_office(payload: &Value) -> OfficeAnswer {
    let output = payload["output"].as_str().expect("output");
    mixdog_testkit::write(output, "pdf from office");
    OfficeAnswer { value: json!({"ok": true, "output": output}), host_exit: None }
}

fn failing(error: &'static str) -> OfficeBehaviour {
    Box::new(move |_| OfficeAnswer { value: json!({"ok": false, "error": error}), host_exit: None })
}

impl Fake {
    fn new(libre: bool, installed: &[&'static str]) -> Self {
        Self {
            libre,
            installed: installed.to_vec(),
            office: Box::new(pdf_from_office),
            removal: Box::new(|directory| {
                mixdog_testkit::remove_dir_all(directory);
                Ok(())
            }),
            calls: Mutex::new(Calls::default()),
        }
    }

    fn libre_calls(&self) -> usize {
        self.calls.lock().expect("calls").libre.len()
    }

    fn office_calls(&self) -> usize {
        self.calls.lock().expect("calls").office.len()
    }
}

impl PreviewEngines for Fake {
    fn libre_office_available(&self) -> BoxFuture<'_, bool> {
        Box::pin(async move { self.libre })
    }

    fn render_libre_office(&self, path: PathBuf, output: PathBuf, _cancel: CancellationToken) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.calls.lock().expect("calls").libre.push((path, output.clone()));
            mixdog_testkit::write(&output, "pdf from libreoffice");
            Ok(())
        })
    }

    fn detect_office(&self, format: String) -> BoxFuture<'_, Value> {
        Box::pin(async move {
            self.calls.lock().expect("calls").detect.push(format);
            json!({"ok": true, "applications": self.installed.iter().map(|format| json!({"format": format, "installed": true})).collect::<Vec<_>>()})
        })
    }

    fn call_office(&self, request: Value, _timeout: Duration, _cancel: CancellationToken) -> BoxFuture<'_, OfficeAnswer> {
        Box::pin(async move {
            let copy_existed = mixdog_testkit::exists(request["path"].as_str().expect("path"));
            self.calls.lock().expect("calls").office.push((request.clone(), copy_existed));
            (self.office)(&request)
        })
    }

    fn remove_directory(&self, directory: PathBuf) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(async move { (self.removal)(&directory) })
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

fn preview_over(fake: &Arc<Fake>) -> DocumentPreview {
    DocumentPreview::new(mixdog_rt::testing::tokens(), Arc::clone(fake) as Arc<dyn PreviewEngines>, Arc::new(NoPages))
}

fn open(preview: &DocumentPreview, f: &Fixture) -> Result<PdfPreview, PreviewError> {
    block(preview.preview_pdf(&f.source, PreviewOptions { cache_root: f.cache_root.clone(), ..PreviewOptions::default() }))
}

fn cached_documents(f: &Fixture) -> Vec<std::ffi::OsString> {
    let root = Path::new(&f.cache_root).join("document-previews");
    if mixdog_testkit::exists(&root) { mixdog_testkit::entry_names(&root) } else { Vec::new() }
}

const ALL: [&str; 3] = ["docx", "xlsx", "pptx"];

#[test]
fn without_libreoffice_microsoft_office_renders_a_read_only_copy_and_cleans_it_up() {
    let f = fixture("office-copy", "review.xlsx", b"source bytes");
    let fake = Arc::new(Fake::new(false, &ALL));
    let preview = preview_over(&fake);
    let result = open(&preview, &f).expect("preview");
    assert_eq!(fake.libre_calls(), 0);
    assert_eq!(fake.calls.lock().expect("calls").detect, ["xlsx"]);
    assert_eq!(fake.office_calls(), 1);
    let (payload, copy_existed) = fake.calls.lock().expect("calls").office[0].clone();
    assert_eq!(payload["action"], "render");
    assert_eq!(payload["format"], "xlsx");
    assert_eq!(payload["readOnly"], true, "the host opens the document read-only");
    assert_eq!(payload["mode"], "background");
    let copy = PathBuf::from(payload["path"].as_str().expect("path"));
    assert_ne!(copy, f.source, "the source itself is never handed to Office");
    assert_eq!(copy.file_name().expect("name"), "review.xlsx");
    assert!(copy_existed);
    assert!(!mixdog_testkit::exists(copy.parent().expect("scratch")), "the private copy is removed");
    assert_eq!(mixdog_testkit::read(&f.source), b"source bytes");
    assert_eq!(payload["output"].as_str().expect("output"), result.path.to_string_lossy());
    assert_eq!(mixdog_testkit::read_string(&result.path), "pdf from office");
    assert!(!result.cached);
    // The second open is served from the cache without another render.
    let again = open(&preview, &f).expect("again");
    assert!(again.cached);
    assert_eq!(fake.office_calls(), 1);
}

#[test]
fn concurrent_opens_of_one_document_share_a_single_office_render() {
    let f = fixture("concurrent", "review.xlsx", b"source bytes");
    let fake = Arc::new(Fake::new(false, &ALL));
    let preview = preview_over(&fake);
    block(async {
        let options = PreviewOptions { cache_root: f.cache_root.clone(), ..PreviewOptions::default() };
        let (first, second) = (preview.clone(), preview.clone());
        let (source, other) = (f.source.clone(), f.source.clone());
        let (a_options, b_options) = (options.clone(), options);
        let a = tokio::spawn(async move { first.preview_pdf(&source, a_options).await });
        let b = tokio::spawn(async move { second.preview_pdf(&other, b_options).await });
        a.await.expect("task").expect("first");
        b.await.expect("task").expect("second");
    });
    assert_eq!(fake.office_calls(), 1);
}

#[test]
fn a_failed_office_render_surfaces_its_error_and_leaves_no_cache_entry_or_copy() {
    let f = fixture("office-failure", "review.xlsx", b"source bytes");
    let mut fake = Fake::new(false, &ALL);
    fake.office = failing("Excel could not open the file");
    let fake = Arc::new(fake);
    let error = open(&preview_over(&fake), &f).expect_err("fails");
    assert!(error.message().contains("Excel could not open the file"));
    let (payload, _) = fake.calls.lock().expect("calls").office[0].clone();
    assert!(!mixdog_testkit::exists(Path::new(payload["path"].as_str().expect("path")).parent().expect("scratch")));
    assert!(cached_documents(&f).is_empty());
}

#[test]
fn a_password_protected_document_is_reported_plainly_not_as_the_raw_host_error() {
    let f = fixture("host-protected", "review.xlsx", b"source bytes");
    let mut fake = Fake::new(false, &ALL);
    fake.office = failing("This file is password-protected. (OFFICE_PREVIEW_PASSWORD_PROTECTED)");
    let error = open(&preview_over(&Arc::new(fake)), &f).expect_err("fails");
    assert_eq!(error.code(), Some("OFFICE_PREVIEW_PASSWORD_PROTECTED"));
    assert_eq!(error.message(), "This file is password-protected and can't be previewed. (OFFICE_PREVIEW_PASSWORD_PROTECTED)");
    assert!(cached_documents(&f).is_empty());
}

// PowerPoint's Presentations.Open takes no password, so an encrypted .ppt has no route to open it.
#[test]
fn an_encrypted_binary_ppt_is_refused_before_powerpoint_is_started() {
    let f = fixture("ppt-office", "old.ppt", &document("ppt-locked"));
    let fake = Arc::new(Fake::new(false, &["pptx"]));
    let error = open(&preview_over(&fake), &f).expect_err("refused");
    assert_eq!(error.code(), Some("OFFICE_PREVIEW_PASSWORD_UNSUPPORTED"));
    assert_eq!(error.message(), "This file is password-protected and can't be previewed. (OFFICE_PREVIEW_PASSWORD_UNSUPPORTED)");
    assert_eq!(fake.office_calls(), 0, "Office is never asked to open it");
    assert!(cached_documents(&f).is_empty());
}

#[test]
fn an_encrypted_binary_ppt_fails_fast_with_libreoffice_available_without_converting() {
    let f = fixture("ppt-libre", "old.ppt", &document("ppt-locked"));
    let fake = Arc::new(Fake::new(true, &[]));
    let error = open(&preview_over(&fake), &f).expect_err("refused");
    assert_eq!(error.code(), Some("OFFICE_PREVIEW_PASSWORD_UNSUPPORTED"));
    assert_eq!(fake.libre_calls(), 0, "conversion is never called");
}

#[test]
fn an_encrypted_docx_with_an_encryption_no_preview_can_open_fails_fast_as_unsupported() {
    let f = fixture("unsupported", "secret.docx", &document("ooxml-unsupported"));
    let fake = Arc::new(Fake::new(true, &[]));
    let error = open(&preview_over(&fake), &f).expect_err("refused");
    assert_eq!(error.code(), Some("OFFICE_PREVIEW_PASSWORD_UNSUPPORTED"));
    assert_eq!(fake.libre_calls(), 0, "conversion is never called");
}

#[test]
fn a_normal_docx_and_an_unencrypted_legacy_cfb_document_renamed_docx_still_convert() {
    for content in [document("zip-bytes"), document("legacy-cfb")] {
        let f = fixture("plain-docx", "plain.docx", &content);
        let fake = Arc::new(Fake::new(true, &[]));
        open(&preview_over(&fake), &f).expect("converts");
        assert_eq!(fake.libre_calls(), 1);
    }
}

#[test]
fn an_unencrypted_binary_ppt_or_stray_token_bytes_still_render_through_office() {
    for name in ["ppt-open", "ppt-stray-bytes", "ppt-stray-stream"] {
        let f = fixture(name, "old.ppt", &document(name));
        let fake = Arc::new(Fake::new(false, &["pptx"]));
        open(&preview_over(&fake), &f).expect("renders");
        assert_eq!(fake.office_calls(), 1, "{name}");
        assert_eq!(fake.calls.lock().expect("calls").office[0].0["format"], "pptx");
    }
}

#[test]
fn with_neither_libreoffice_nor_microsoft_office_the_error_says_what_to_install() {
    let f = fixture("neither", "review.xlsx", b"source bytes");
    let fake = Arc::new(Fake::new(false, &[]));
    let error = open(&preview_over(&fake), &f).expect_err("unavailable");
    assert_eq!(error.code(), Some("OFFICE_PREVIEW_UNAVAILABLE"));
    assert!(error.message().contains("needs LibreOffice or Microsoft Office"));
    assert!(error.message().contains("Extensions → Built-in → Office"));
    assert!(!error.message().contains("background mode"));
    assert_eq!(fake.office_calls(), 0);
}

#[test]
fn office_installed_for_another_format_only_does_not_count() {
    let f = fixture("other-format", "deck.pptx", b"source bytes");
    let fake = Arc::new(Fake::new(false, &["xlsx"]));
    let error = open(&preview_over(&fake), &f).expect_err("unavailable");
    assert!(error.message().contains("needs LibreOffice or Microsoft Office"));
    assert_eq!(fake.calls.lock().expect("calls").detect, ["pptx"]);
}

#[test]
fn a_cancelled_render_with_a_still_pending_host_removes_its_locked_copy_after_the_host_exits() {
    let f = fixture("pending-host", "review.xlsx", b"source bytes");
    let locked = Arc::new(AtomicBool::new(true));
    let removed = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let (host_exited, host_exit) = tokio::sync::oneshot::channel::<()>();
    let host_exit = Mutex::new(Some(host_exit));
    let mut fake = Fake::new(false, &ALL);
    fake.removal = {
        let (locked, removed) = (Arc::clone(&locked), Arc::clone(&removed));
        Box::new(move |directory| {
            if locked.load(Ordering::SeqCst) {
                return Err(io::Error::other("EBUSY"));
            }
            removed.lock().expect("removed").push(directory.to_path_buf());
            mixdog_testkit::remove_dir_all(directory);
            Ok(())
        })
    };
    fake.office = Box::new(move |_| {
        let exit = host_exit.lock().expect("exit").take().expect("one call");
        OfficeAnswer {
            value: json!({"ok": false, "cancelled": true, "error": "cancelled", "cleanup": {"ok": false}}),
            host_exit: Some(Box::pin(async move {
                let _ = exit.await;
            })),
        }
    });
    let fake = Arc::new(fake);
    block(async {
        let preview = preview_over(&fake);
        let options = PreviewOptions { cache_root: f.cache_root.clone(), ..PreviewOptions::default() };
        assert!(preview.preview_pdf(&f.source, options).await.is_err());
        let scratch = PathBuf::from(fake.calls.lock().expect("calls").office[0].0["path"].as_str().expect("path")).parent().expect("scratch").to_path_buf();
        mixdog_rt::time::sleep(Duration::from_millis(30)).await;
        assert!(mixdog_testkit::exists(&scratch), "still held while the host runs");
        assert!(removed.lock().expect("removed").is_empty());
        locked.store(false, Ordering::SeqCst);
        host_exited.send(()).expect("the removal waits for the host");
        for _ in 0..100 {
            if !mixdog_testkit::exists(&scratch) {
                break;
            }
            mixdog_rt::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(!mixdog_testkit::exists(&scratch), "removed once the host exited and the lock cleared");
    });
}

#[test]
fn with_libreoffice_present_the_libreoffice_path_is_unchanged() {
    let f = fixture("libre", "review.xlsx", b"source bytes");
    let fake = Arc::new(Fake::new(true, &ALL));
    let result = open(&preview_over(&fake), &f).expect("preview");
    let calls = fake.calls.lock().expect("calls");
    assert_eq!(calls.libre.len(), 1);
    assert_eq!(calls.libre[0].0, f.source);
    assert!(calls.detect.is_empty());
    assert!(calls.office.is_empty());
    assert_eq!(mixdog_testkit::read_string(&result.path), "pdf from libreoffice");
}

#[test]
fn the_convertible_formats_are_the_documents_libreoffice_reads() {
    use mixdog_office_pdf::preview::preview_format;
    for name in ["a.docx", "A.DOCX", "dir\\a.xls", "dir/a.odp", "a.b.pptm", "a.rtf"] {
        assert!(preview_format(name).is_some(), "{name}");
    }
    for name in ["a.pdf", "a.", "a", "", "dir.docx/a", "a.docx.txt", ".dotm"] {
        assert!(preview_format(name).is_none(), "{name}");
    }
}

// ---- documentPreviewPages ---------------------------------------------------------------------------------------------

/// Counts what it is asked for and answers `px-<call>-<page>` for each page.
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

struct PageFixture {
    f: Fixture,
    pdf: PathBuf,
    pixels: Arc<Pixels>,
    preview: DocumentPreview,
}

fn page_fixture(test: &str) -> PageFixture {
    let f = fixture(test, "a.pdf", b"rev1");
    let pdf = f.source.clone();
    let pixels = Arc::new(Pixels { calls: Mutex::new(Vec::new()) });
    let preview = DocumentPreview::new(mixdog_rt::testing::tokens(), Arc::new(Fake::new(false, &[])), Arc::clone(&pixels) as Arc<dyn PageRenderer>);
    PageFixture { f, pdf, pixels, preview }
}

impl PageFixture {
    fn pages(&self, pages: &[u64], max_width: u32) -> Value {
        let options = PagesOptions { pages: pages.to_vec(), max_width, cache_root: self.f.cache_root.clone(), ..PagesOptions::default() };
        block(self.preview.preview_pages(&self.pdf, options)).expect("pages").to_json()
    }

    fn calls(&self) -> Vec<(Vec<u64>, u32)> {
        self.pixels.calls.lock().expect("calls").clone()
    }
}

#[test]
fn a_repeated_page_request_is_served_from_cache_with_an_identical_reply() {
    let p = page_fixture("pages-repeat");
    let first = p.pages(&[1], 800);
    let second = p.pages(&[1], 800);
    assert_eq!(p.calls().len(), 1);
    assert_eq!(second, first);
    assert_eq!(first, json!({"pageCount": 5, "pages": [{"page": 1, "width": 800, "height": 10, "mime": "image/png", "base64": "px-1-1"}]}));
    // A different width or an extra page only rasterizes what is missing.
    p.pages(&[1, 2], 800);
    assert_eq!(p.calls().last().expect("call"), &(vec![2], 800));
    p.pages(&[1], 400);
    assert_eq!(p.calls().len(), 3);
}

#[test]
fn the_disk_cache_serves_a_fresh_process_level_memory_miss() {
    let p = page_fixture("pages-disk");
    let first = p.pages(&[3], 640);
    // Evict memory by filling it with other pages of other widths.
    for width in 321..361 {
        p.pages(&[1], width);
    }
    let before = p.calls().len();
    let again = p.pages(&[3], 640);
    assert_eq!(p.calls().len(), before);
    assert_eq!(again, first);
}

#[test]
fn a_changed_pdf_is_rasterized_again_and_older_revisions_are_pruned() {
    let p = page_fixture("pages-changed");
    let first = p.pages(&[1], 800);
    mixdog_testkit::write(&p.pdf, "revision two is longer");
    let second = p.pages(&[1], 800);
    assert_eq!(p.calls().len(), 2);
    assert_ne!(second["pages"][0]["base64"], first["pages"][0]["base64"]);
    let root = Path::new(&p.f.cache_root).join("document-preview-pages");
    assert!(mixdog_testkit::exists(&root));
    assert_eq!(mixdog_testkit::entry_names(&root).len(), 1);
}
