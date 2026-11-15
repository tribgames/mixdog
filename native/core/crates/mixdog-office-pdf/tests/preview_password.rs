//! Password-protected documents in `documentPreviewPdf`: the ports of the cases of `document-preview-password.slow.test.mjs`
//! that belong to the preview (the descriptor reading and the key derivation queue are `mixdog-office-crypto`'s own tests): the
//! order of the checks (no engine starts before a wrong password is rejected), the integrity check, the unlocked PDF that is
//! never cached and its pages that never reach the disk, the password that reaches only Word and never an error text, the
//! cancellation of a derivation, and the scratch directories tracked until their removal is confirmed. The encrypted documents
//! are those of `native/core/fixtures/office-preview/golden.json`, made by the Node tests' own container writer.

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use mixdog_fsio::Unlaned;
use mixdog_office_pdf::preview::{
    BoxFuture, DocumentPreview, OfficeAnswer, PageRenderer, PagesOptions, PdfPreview, PreviewEngines, PreviewError, PreviewOptions, RawImage,
    RawPages, remove_tracked_preview_scratch_sync, tracked_preview_scratch,
};
use mixdog_rt::CancellationToken;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const GOLDEN: &str = include_str!("../../../fixtures/office-preview/golden.json");

fn golden() -> &'static Value {
    static PARSED: OnceLock<Value> = OnceLock::new();
    PARSED.get_or_init(|| serde_json::from_str(GOLDEN).expect("golden.json parses"))
}

fn password() -> &'static str {
    golden()["password"].as_str().expect("password")
}

fn plain_sha256() -> &'static str {
    golden()["plainSha256"].as_str().expect("plainSha256")
}

fn document(name: &str) -> Vec<u8> {
    let text = golden()["documents"][name].as_str().unwrap_or_else(|| panic!("no document {name}"));
    base64::engine::general_purpose::STANDARD.decode(text).expect("base64")
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn block<F: Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime").block_on(future)
}

/// The tests share the scratch tracking of the process (one of them sweeps it), so they run one at a time.
fn serial() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

struct Fixture {
    source: PathBuf,
    cache_root: String,
}

fn fixture(test: &str, name: &str, content: &[u8]) -> Fixture {
    static NUMBER: AtomicUsize = AtomicUsize::new(0);
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("preview-password").join(format!("{test}-{}", NUMBER.fetch_add(1, Ordering::SeqCst)));
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
    /// The file handed to LibreOffice, its content, and the scratch directories tracked at that moment.
    libre: Vec<(PathBuf, Vec<u8>, PathBuf, Vec<PathBuf>)>,
    detect: Vec<String>,
    /// The request to Word or Excel and the content of the copy it names.
    office: Vec<(Value, Vec<u8>)>,
}

type OfficeBehaviour = Box<dyn Fn(&Value) -> Value + Send + Sync>;
type Removal = Box<dyn Fn(&Path) -> io::Result<()> + Send + Sync>;

struct Fake {
    libre: bool,
    installed: Vec<&'static str>,
    office: OfficeBehaviour,
    removal: Removal,
    calls: Mutex<Calls>,
}

impl Fake {
    fn new(libre: bool, installed: &[&'static str]) -> Self {
        Self {
            libre,
            installed: installed.to_vec(),
            office: Box::new(|request| {
                let output = request["output"].as_str().expect("output");
                mixdog_testkit::write(output, "pdf from office");
                json!({"ok": true, "output": output})
            }),
            removal: Box::new(|directory| {
                mixdog_testkit::remove_dir_all(directory);
                Ok(())
            }),
            calls: Mutex::new(Calls::default()),
        }
    }

    fn engine_calls(&self) -> [usize; 3] {
        let calls = self.calls.lock().expect("calls");
        [calls.libre.len(), calls.detect.len(), calls.office.len()]
    }
}

impl PreviewEngines for Fake {
    fn libre_office_available(&self) -> BoxFuture<'_, bool> {
        Box::pin(async move { self.libre })
    }

    fn render_libre_office(&self, path: PathBuf, output: PathBuf, _cancel: CancellationToken) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let content = mixdog_testkit::read(&path);
            self.calls.lock().expect("calls").libre.push((path, content, output.clone(), tracked_preview_scratch()));
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
            let content = mixdog_testkit::read(request["path"].as_str().expect("path"));
            self.calls.lock().expect("calls").office.push((request.clone(), content));
            OfficeAnswer { value: (self.office)(&request), host_exit: None }
        })
    }

    fn remove_directory(&self, directory: PathBuf) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(async move { (self.removal)(&directory) })
    }

    fn remove_backoff(&self) -> Duration {
        Duration::from_millis(1)
    }
}

/// Three pages of 10 by 10, whatever is asked.
struct Pages;

impl PageRenderer for Pages {
    fn render_pages(&self, _: PathBuf, pages: Vec<u64>, _: u32, _: CancellationToken) -> BoxFuture<'_, Result<RawPages, PreviewError>> {
        Box::pin(async move {
            let images = pages.iter().map(|page| RawImage { page: *page, width: 10, height: 10, mime_type: Some("image/png".to_owned()), data: "AAAA".to_owned() }).collect();
            Ok(RawPages { page_count: 3, images })
        })
    }
}

fn preview_over(fake: &Arc<Fake>) -> DocumentPreview {
    DocumentPreview::new(mixdog_rt::testing::tokens(), Arc::clone(fake) as Arc<dyn PreviewEngines>, Arc::new(Pages))
}

fn open_with(preview: &DocumentPreview, f: &Fixture, password: &str) -> Result<PdfPreview, PreviewError> {
    let options = PreviewOptions { cache_root: f.cache_root.clone(), password: password.to_owned(), ..PreviewOptions::default() };
    block(preview.preview_pdf(&f.source, options))
}

fn cached_documents(f: &Fixture) -> Vec<std::ffi::OsString> {
    let root = Path::new(&f.cache_root).join("document-previews");
    if mixdog_testkit::exists(&root) { mixdog_testkit::entry_names(&root) } else { Vec::new() }
}

/// An error with this code, whose text never carries the password.
fn rejected(result: Result<PdfPreview, PreviewError>, code: &str) -> PreviewError {
    let error = result.expect_err("rejected");
    assert_eq!(error.code(), Some(code), "{error}");
    assert!(!error.message().contains(password()), "the password is never in the error");
    error
}

#[test]
fn without_a_password_the_preview_asks_for_one_before_any_engine_starts() {
    let _serial = serial();
    for scheme in ["agile", "standard"] {
        let f = fixture("asks", "secret.docx", &document(scheme));
        let fake = Arc::new(Fake::new(true, &["docx", "xlsx", "pptx"]));
        rejected(open_with(&preview_over(&fake), &f, ""), "OFFICE_PREVIEW_PASSWORD_PROTECTED");
        assert_eq!(fake.engine_calls(), [0, 0, 0], "{scheme}");
        assert!(cached_documents(&f).is_empty());
    }
}

#[test]
fn a_wrong_password_is_its_own_coded_error_decided_before_any_engine_starts() {
    let _serial = serial();
    for scheme in ["agile", "standard"] {
        let f = fixture("wrong", "secret.xlsx", &document(scheme));
        let fake = Arc::new(Fake::new(true, &["docx", "xlsx", "pptx"]));
        let error = rejected(open_with(&preview_over(&fake), &f, &format!("{}x", password())), "OFFICE_PREVIEW_WRONG_PASSWORD");
        assert_eq!(error.message(), "That password didn't work. (OFFICE_PREVIEW_WRONG_PASSWORD)");
        assert_eq!(fake.engine_calls(), [0, 0, 0], "{scheme}");
        assert!(cached_documents(&f).is_empty());
    }
}

#[test]
fn the_right_password_renders_the_decrypted_package_with_libreoffice() {
    let _serial = serial();
    for scheme in ["agile", "standard"] {
        let f = fixture("right", "secret.docx", &document(scheme));
        let fake = Arc::new(Fake::new(true, &[]));
        let result = open_with(&preview_over(&fake), &f, password()).expect("preview");
        let calls = fake.calls.lock().expect("calls");
        assert_eq!(calls.libre.len(), 1, "{scheme}");
        let (path, content, _, _) = &calls.libre[0];
        assert_ne!(path, &f.source);
        assert_eq!(sha256(content), plain_sha256(), "LibreOffice converts the decrypted package");
        assert!(!mixdog_testkit::exists(path.parent().expect("scratch")), "the decrypted copy is removed after the render");
        assert_eq!(mixdog_testkit::read_string(&result.path), "pdf from libreoffice");
        assert!(!result.path.starts_with(&f.cache_root), "the unlocked PDF never lands in the preview cache");
        assert!(cached_documents(&f).is_empty());
    }
}

#[test]
fn an_unlocked_document_serves_later_page_requests_without_its_password_and_keeps_pages_off_disk() {
    let _serial = serial();
    let f = fixture("unlocked", "deck.pptx", &document("agile"));
    let fake = Arc::new(Fake::new(true, &[]));
    let preview = preview_over(&fake);
    let first = open_with(&preview, &f, password()).expect("unlocked");
    let again = open_with(&preview, &f, "").expect("again");
    assert_eq!(again.path, first.path);
    assert!(again.cached);
    assert_eq!(fake.engine_calls()[0], 1, "no second render");
    let pages = block(preview.preview_pages(&first.path, PagesOptions { pages: vec![1], cache_root: f.cache_root.clone(), ..PagesOptions::default() })).expect("pages");
    assert_eq!(pages.page_count, 3);
    assert!(!mixdog_testkit::exists(Path::new(&f.cache_root).join("document-preview-pages")), "no page raster is stored on disk");
    // A changed document is a new identity: it asks for its password again.
    mixdog_testkit::write(&f.source, document("agile"));
    rejected(open_with(&preview, &f, ""), "OFFICE_PREVIEW_PASSWORD_PROTECTED");
}

#[test]
fn without_libreoffice_the_decrypted_package_goes_to_microsoft_office_which_never_gets_the_password() {
    let _serial = serial();
    let f = fixture("office-decrypted", "secret.xlsx", &document("agile"));
    let fake = Arc::new(Fake::new(false, &["docx", "xlsx", "pptx"]));
    open_with(&preview_over(&fake), &f, password()).expect("preview");
    let calls = fake.calls.lock().expect("calls");
    assert_eq!(calls.office.len(), 1);
    let (payload, content) = &calls.office[0];
    assert_eq!(payload["format"], "xlsx");
    assert_eq!(payload["readOnly"], true);
    assert!(payload.get("password").is_none());
    assert_eq!(sha256(content), plain_sha256());
}

#[test]
fn an_encrypted_doc_without_word_says_microsoft_office_is_needed_never_offering_a_password() {
    let _serial = serial();
    let f = fixture("doc-no-word", "old.doc", &document("word-encrypted"));
    let fake = Arc::new(Fake::new(true, &[]));
    rejected(open_with(&preview_over(&fake), &f, ""), "OFFICE_PREVIEW_PASSWORD_NEEDS_OFFICE");
    assert_eq!(fake.calls.lock().expect("calls").detect, ["docx"]);
    assert_eq!(fake.engine_calls()[0], 0);
}

#[test]
fn an_encrypted_doc_asks_for_its_password_then_word_opens_it_with_that_password_from_the_request() {
    let _serial = serial();
    let f = fixture("doc-word", "old.doc", &document("word-encrypted"));
    let fake = Arc::new(Fake::new(true, &["docx", "xlsx", "pptx"]));
    let preview = preview_over(&fake);
    rejected(open_with(&preview, &f, ""), "OFFICE_PREVIEW_PASSWORD_PROTECTED");
    assert_eq!(fake.engine_calls()[2], 0, "Word is not started without a password");
    let result = open_with(&preview, &f, password()).expect("opened");
    let calls = fake.calls.lock().expect("calls");
    assert_eq!(calls.libre.len(), 0, "LibreOffice takes no password, so Word renders it");
    assert_eq!(calls.office.len(), 1);
    assert_eq!(calls.office[0].0["format"], "docx");
    assert_eq!(calls.office[0].0["password"], password(), "the password travels in the request body (stdin)");
    assert_eq!(mixdog_testkit::read_string(&result.path), "pdf from office");
    drop(calls);
    assert!(cached_documents(&f).is_empty());
}

#[test]
fn words_incorrect_password_result_is_the_wrong_password_error_and_engine_text_never_carries_the_password() {
    let _serial = serial();
    let f = fixture("doc-wrong", "old.doc", &document("word-encrypted"));
    let mut wrong = Fake::new(true, &["docx", "xlsx", "pptx"]);
    wrong.office = Box::new(|_| json!({"ok": false, "error": "That password didn't work. (OFFICE_PREVIEW_WRONG_PASSWORD)"}));
    rejected(open_with(&preview_over(&Arc::new(wrong)), &f, password()), "OFFICE_PREVIEW_WRONG_PASSWORD");
    let mut echoing = Fake::new(true, &["docx", "xlsx", "pptx"]);
    echoing.office = Box::new(|_| json!({"ok": false, "error": format!("Word failed opening {} somehow", password())}));
    let error = open_with(&preview_over(&Arc::new(echoing)), &f, password()).expect_err("fails");
    assert_eq!(error.message(), "Word failed opening *** somehow");
}

#[test]
fn an_unencrypted_doc_still_converts_with_libreoffice() {
    let _serial = serial();
    let f = fixture("doc-plain", "plain.doc", &document("word-plain"));
    let fake = Arc::new(Fake::new(true, &[]));
    open_with(&preview_over(&fake), &f, "").expect("converts");
    assert_eq!(fake.engine_calls(), [1, 0, 0]);
}

#[test]
fn an_agile_descriptor_with_another_hash_opens_with_its_password() {
    let _serial = serial();
    for hash in ["SHA-1", "SHA1", "SHA256", "SHA384"] {
        let f = fixture("hash", "secret.docx", &document(&format!("agile-{hash}")));
        let fake = Arc::new(Fake::new(true, &[]));
        open_with(&preview_over(&fake), &f, password()).expect("opens");
        assert_eq!(sha256(&fake.calls.lock().expect("calls").libre[0].1), plain_sha256(), "{hash}");
    }
}

#[test]
fn a_package_whose_hmac_does_not_match_is_refused_as_corrupt_after_the_password_and_before_any_engine() {
    let _serial = serial();
    for name in ["tampered-byte", "tampered-size"] {
        let f = fixture("tampered", "secret.docx", &document(name));
        let fake = Arc::new(Fake::new(true, &[]));
        let preview = preview_over(&fake);
        rejected(open_with(&preview, &f, password()), "OFFICE_PREVIEW_PASSWORD_CORRUPT");
        rejected(open_with(&preview, &f, &format!("{}x", password())), "OFFICE_PREVIEW_WRONG_PASSWORD");
        assert_eq!(fake.engine_calls(), [0, 0, 0], "{name}");
        assert!(cached_documents(&f).is_empty(), "{name}");
    }
}

#[test]
fn malformed_integrity_data_is_corrupt_before_a_password_is_asked_and_absent_integrity_data_is_allowed() {
    let _serial = serial();
    let names: Vec<&String> = golden()["documents"].as_object().expect("documents").keys().filter(|name| name.starts_with("integrity-")).collect();
    assert_eq!(names.len(), 5);
    for name in names {
        let f = fixture("malformed", "secret.docx", &document(name));
        let fake = Arc::new(Fake::new(true, &[]));
        let preview = preview_over(&fake);
        for given in ["", password()] {
            rejected(open_with(&preview, &f, given), "OFFICE_PREVIEW_PASSWORD_CORRUPT");
        }
        assert_eq!(fake.engine_calls()[0], 0, "{name}");
    }
    let f = fixture("absent", "plain-agile.docx", &document("agile-no-integrity"));
    let fake = Arc::new(Fake::new(true, &[]));
    open_with(&preview_over(&fake), &f, password()).expect("opens");
    assert_eq!(sha256(&fake.calls.lock().expect("calls").libre[0].1), plain_sha256());
}

#[test]
fn integrity_data_keyed_by_a_saltsize_or_hashsize_salt_verifies_and_one_flipped_byte_fails_it() {
    let _serial = serial();
    let names: Vec<&String> = golden()["documents"].as_object().expect("documents").keys().filter(|name| name.starts_with("salts-") && *name != "salts-flipped").collect();
    assert_eq!(names.len(), 4);
    for name in names {
        let f = fixture("salts", "secret.docx", &document(name));
        let fake = Arc::new(Fake::new(true, &[]));
        open_with(&preview_over(&fake), &f, password()).expect("verifies");
        assert_eq!(sha256(&fake.calls.lock().expect("calls").libre[0].1), plain_sha256(), "{name}");
    }
    let flipped = fixture("salts-flipped", "secret.docx", &document("salts-flipped"));
    let fake = Arc::new(Fake::new(true, &[]));
    rejected(open_with(&preview_over(&fake), &flipped, password()), "OFFICE_PREVIEW_PASSWORD_CORRUPT");
    assert_eq!(fake.engine_calls()[0], 0);
}

#[test]
fn a_cancelled_request_ends_its_password_derivation_at_once_leaving_nothing_behind() {
    let _serial = serial();
    let f = fixture("cancel", "slow.docx", &document("slow-spin"));
    let fake = Arc::new(Fake::new(true, &[]));
    let before = tracked_preview_scratch();
    block(async {
        let preview = preview_over(&fake);
        let cancel = CancellationToken::new();
        let options = PreviewOptions { cache_root: f.cache_root.clone(), password: password().to_owned(), cancel: cancel.clone() };
        let source = f.source.clone();
        let pending = tokio::spawn(async move { preview.preview_pdf(&source, options).await });
        let started = Instant::now();
        while mixdog_office_crypto::key_derivations().running == 0 {
            assert!(started.elapsed() < Duration::from_secs(10), "waiting for the derivation to start");
            mixdog_rt::time::sleep(Duration::from_millis(5)).await;
        }
        let tick = Instant::now();
        mixdog_rt::time::sleep(Duration::from_millis(20)).await;
        assert!(tick.elapsed() < Duration::from_millis(500), "timers still run while the password is hashed");
        let cancelled = Instant::now();
        cancel.cancel();
        let error = pending.await.expect("task").expect_err("aborted");
        assert!(error.is_aborted(), "{error}");
        assert!(cancelled.elapsed() < Duration::from_secs(1), "the abort ends the derivation without waiting for it");
        let waiting = Instant::now();
        while mixdog_office_crypto::key_derivations().running != 0 {
            assert!(waiting.elapsed() < Duration::from_secs(10), "waiting for the derivation thread to end");
            mixdog_rt::time::sleep(Duration::from_millis(5)).await;
        }
    });
    assert_eq!(fake.engine_calls(), [0, 0, 0]);
    let left: Vec<PathBuf> = tracked_preview_scratch().into_iter().filter(|directory| !before.contains(directory)).collect();
    assert!(left.is_empty(), "no scratch left: {left:?}");
}

#[test]
fn scratch_directories_are_tracked_from_creation_until_a_removal_succeeds_then_removed_at_exit() {
    let _serial = serial();
    let f = fixture("tracked", "secret.docx", &document("agile"));
    let mut fake = Fake::new(true, &[]);
    fake.removal = Box::new(|_| Err(io::Error::other("EBUSY")));
    let fake = Arc::new(fake);
    let preview = preview_over(&fake);
    let result = open_with(&preview, &f, password()).expect("unlocked");
    let (copy, pdf, tracked) = {
        let calls = fake.calls.lock().expect("calls");
        let (path, _, output, tracked) = calls.libre[0].clone();
        (path.parent().expect("scratch").to_path_buf(), output.parent().expect("scratch").to_path_buf(), tracked)
    };
    assert!(tracked.contains(&copy), "the decrypted copy is tracked while it is rendered");
    assert!(tracked.contains(&pdf), "the unlocked PDF directory is tracked while it is written");
    // Every background retry fails too (1 + 2 + 4 + 8 + 16 + 32 ms).
    block(mixdog_rt::time::sleep(Duration::from_millis(200)));
    assert!(mixdog_testkit::exists(&copy));
    assert!(tracked_preview_scratch().contains(&copy), "a removal that keeps failing stays tracked");
    // The unlocked PDF disappears: the entry is pushed out, and its directory, whose removal fails, stays tracked.
    mixdog_testkit::remove_file(&result.path);
    rejected(open_with(&preview, &f, ""), "OFFICE_PREVIEW_PASSWORD_PROTECTED");
    block(mixdog_rt::time::sleep(Duration::from_millis(200)));
    assert!(mixdog_testkit::exists(&pdf));
    assert!(tracked_preview_scratch().contains(&pdf), "a pushed-out unlocked PDF stays tracked until it is removed");
    remove_tracked_preview_scratch_sync(&Unlaned);
    assert!(!mixdog_testkit::exists(&copy) && !mixdog_testkit::exists(&pdf), "the exit cleanup removes both");
    let left = tracked_preview_scratch();
    assert!(!left.contains(&copy) && !left.contains(&pdf));
}
