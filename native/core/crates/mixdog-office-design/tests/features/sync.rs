//! Syncing the design library against a scripted network: when a check is due, what a newer, equal or damaged pack does,
//! and what lands in the data folder. The pack is signed with a fixed Ed25519 key; nothing here touches the real network.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_fsio::Unlaned;
use mixdog_office_design::library::core::{Environment, LibraryConfig, canonical_office_design_pack};
use mixdog_office_design::library::pack::{Fetch, FetchRequest, FetchResponse};
use mixdog_office_design::library::store::{Context, SyncOptions, TemplateIndexer, sync_office_design_library};
use ring::digest::{SHA256, digest};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{Value, json};

const SPKI_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
const MANIFEST: &str = "https://packs.example.test/manifest.json";
const TEMPLATE_URL: &str = "https://packs.example.test/deck-a.pptx";
const TEMPLATE_BODY: &[u8] = b"not really a deck, only bytes whose size and digest are checked";

fn pair() -> Ed25519KeyPair {
    Ed25519KeyPair::from_seed_unchecked(&[9; 32]).expect("a key")
}

fn public_pem() -> String {
    let mut der = SPKI_PREFIX.to_vec();
    der.extend_from_slice(pair().public_key().as_ref());
    format!("-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n", STANDARD.encode(der))
}

fn sha256_hex(bytes: &[u8]) -> String {
    digest(&SHA256, bytes).as_ref().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The signed manifest of a pack of one template.
fn manifest(version: &str, template_body: &[u8]) -> Vec<u8> {
    let pack = json!({
        "id": "acme",
        "version": version,
        "templates": [{ "id": "deck-a", "format": "pptx", "url": TEMPLATE_URL, "sha256": sha256_hex(template_body), "bytes": template_body.len() }],
    });
    let signature = pair().sign(canonical_office_design_pack(&pack).as_bytes());
    let envelope = json!({ "schemaVersion": 1, "keyId": "acme-key", "signature": STANDARD.encode(signature.as_ref()), "pack": pack });
    envelope.to_string().into_bytes()
}

type Answer = Box<dyn Fn(&FetchRequest<'_>) -> Result<FetchResponse, String>>;

/// A network that answers from a closure and remembers every request as (url, entity tag sent).
struct Scripted {
    answer: RefCell<Answer>,
    log: RefCell<Vec<(String, Option<String>)>>,
}

impl Scripted {
    fn new(answer: impl Fn(&FetchRequest<'_>) -> Result<FetchResponse, String> + 'static) -> Self {
        Self { answer: RefCell::new(Box::new(answer)), log: RefCell::new(Vec::new()) }
    }

    fn serve(&self, answer: impl Fn(&FetchRequest<'_>) -> Result<FetchResponse, String> + 'static) {
        *self.answer.borrow_mut() = Box::new(answer);
    }

    fn requests(&self) -> Vec<(String, Option<String>)> {
        self.log.borrow().clone()
    }
}

impl Fetch for Scripted {
    fn get(&self, request: &FetchRequest<'_>) -> Result<FetchResponse, String> {
        self.log.borrow_mut().push((request.url.to_owned(), request.if_none_match.map(str::to_owned)));
        (self.answer.borrow())(request)
    }
}

fn ok(body: Vec<u8>, etag: Option<&str>) -> Result<FetchResponse, String> {
    Ok(FetchResponse { status: 200, content_length: 0.0, etag: etag.map(str::to_owned), body })
}

/// A network serving one version of the pack, its manifest tagged `etag`, answering 304 to that tag.
fn serving(version: &'static str, template_body: &'static [u8], etag: &'static str) -> impl Fn(&FetchRequest<'_>) -> Result<FetchResponse, String> + 'static {
    move |request| match request.url {
        MANIFEST if request.if_none_match == Some(etag) => Ok(FetchResponse { status: 304, ..FetchResponse::default() }),
        MANIFEST => ok(manifest(version, template_body), Some(etag)),
        TEMPLATE_URL => ok(template_body.to_vec(), None),
        other => Err(format!("no such url {other}")),
    }
}

struct NoIndex;

impl TemplateIndexer<Unlaned> for NoIndex {
    fn index(&self, _: &Unlaned, _: &Environment, _: &Path, _: &LibraryConfig) -> Result<Value, String> {
        Ok(json!({ "changed": false, "count": 0, "templates": [] }))
    }
}

struct Library {
    root: tempfile::TempDir,
    env: Environment,
    clock: Arc<AtomicU64>,
}

impl Library {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("tempdir");
        let clock = Arc::new(AtomicU64::new(1_000_000));
        let read = Arc::clone(&clock);
        let env = Environment {
            library_config: String::new(),
            pack_url: String::new(),
            pack_key_id: String::new(),
            pack_public_key: String::new(),
            template_dirs: String::new(),
            windows: false,
            program_files: String::new(),
            program_files_x86: String::new(),
            app_data: String::new(),
            home: String::new(),
            cwd: root.path().to_path_buf(),
            bundled_templates: root.path().join("bundled"),
            now_ms: Arc::new(move || read.load(Ordering::SeqCst) as f64),
        };
        Self { root, env, clock }
    }

    fn data(&self) -> PathBuf {
        self.root.path().join("data")
    }

    fn pack_folder(&self, version: &str) -> PathBuf {
        self.data().join("office").join("design-library").join("packs").join("acme").join(version)
    }

    fn state(&self) -> Value {
        let text = std::fs::read_to_string(self.data().join("office").join("design-library").join("state.json")).expect("state.json");
        serde_json::from_str(&text).expect("json")
    }

    fn advance(&self, ms: u64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    fn sync(&self, network: &Scripted, config: &Value, force: bool) -> Value {
        let data = self.data();
        let cx = Context { lane: &Unlaned, env: &self.env, fetch: network, indexer: &NoIndex };
        let options = SyncOptions { force, config: Some(config), ..SyncOptions::new(&data) };
        sync_office_design_library(&cx, &options).expect("a sync answers even when the check failed").to_value()
    }
}

fn config() -> Value {
    json!({ "manifestUrl": MANIFEST, "trustedKeys": { "acme-key": public_pem() }, "checkIntervalMs": 60_000 })
}

#[test]
fn the_first_check_downloads_verifies_and_activates_the_pack_and_leaves_its_files_and_state() {
    let library = Library::new();
    let network = Scripted::new(serving("1.0.0", TEMPLATE_BODY, "tag-1"));
    let answer = library.sync(&network, &config(), false);
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!((answer["checked"].clone(), answer["updated"].clone()), (json!(true), json!(true)));
    assert_eq!(answer["warning"], "");
    assert_eq!(answer["active"]["id"], "acme");
    assert_eq!(answer["active"]["version"], "1.0.0");
    assert_eq!(answer["active"]["templates"], 1);
    assert_eq!(answer["activePack"]["source"], "remote-pack");
    assert_eq!(network.requests(), [(MANIFEST.to_owned(), None), (TEMPLATE_URL.to_owned(), None)]);
    let folder = library.pack_folder("1.0.0");
    assert_eq!(std::fs::read(folder.join("templates").join("deck-a.pptx")).expect("the template"), TEMPLATE_BODY);
    assert!(folder.join("envelope.json").exists());
    let state = library.state();
    assert_eq!(state["active"], json!({ "id": "acme", "version": "1.0.0" }));
    assert_eq!(state["etag"], "tag-1");
    assert_eq!(state["lastCheckedAt"], 1_000_000);
    assert_eq!(state["lastError"], "");
}

#[test]
fn a_second_sync_before_the_interval_does_not_touch_the_network_and_one_after_it_asks_with_the_tag() {
    let library = Library::new();
    let network = Scripted::new(serving("1.0.0", TEMPLATE_BODY, "tag-1"));
    library.sync(&network, &config(), false);
    let before = network.requests().len();
    library.advance(30_000);
    let early = library.sync(&network, &config(), false);
    assert_eq!((early["ok"].clone(), early["checked"].clone()), (json!(true), json!(false)));
    assert_eq!(early["active"]["version"], "1.0.0", "the cached pack is still the active one");
    assert_eq!(network.requests().len(), before, "no request before the interval is up");
    library.advance(40_000);
    let due = library.sync(&network, &config(), false);
    assert_eq!((due["checked"].clone(), due["updated"].clone()), (json!(true), json!(false)));
    assert_eq!(network.requests()[before], (MANIFEST.to_owned(), Some("tag-1".to_owned())), "the stored tag is sent");
    assert_eq!(library.state()["lastCheckedAt"], 1_070_000, "the unchanged answer still counts as a check");
    let forced = library.sync(&network, &config(), true);
    assert_eq!(forced["checked"], true, "force checks whatever the clock says");
}

#[test]
fn a_newer_version_replaces_the_active_pack_and_an_equal_or_older_one_does_not() {
    let library = Library::new();
    let network = Scripted::new(serving("1.0.0", TEMPLATE_BODY, "tag-1"));
    library.sync(&network, &config(), false);
    network.serve(serving("1.1.0", b"the second edition of the deck, a different size", "tag-2"));
    let newer = library.sync(&network, &config(), true);
    assert_eq!((newer["updated"].clone(), newer["active"]["version"].clone()), (json!(true), json!("1.1.0")));
    assert!(library.pack_folder("1.1.0").join("templates").join("deck-a.pptx").exists());
    assert_eq!(library.state()["active"]["version"], "1.1.0");
    network.serve(serving("1.0.5", TEMPLATE_BODY, "tag-3"));
    let older = library.sync(&network, &config(), true);
    assert_eq!((older["checked"].clone(), older["updated"].clone(), older["active"]["version"].clone()), (json!(true), json!(false), json!("1.1.0")));
    assert!(!library.pack_folder("1.0.5").exists(), "an older pack is not downloaded");
}

#[test]
fn a_template_that_does_not_match_its_digest_fails_the_check_and_leaves_the_active_pack_alone() {
    let library = Library::new();
    let network = Scripted::new(serving("1.0.0", TEMPLATE_BODY, "tag-1"));
    library.sync(&network, &config(), false);
    // The next edition's manifest declares the digest of one body and the network serves another of the same size.
    let tampered: &'static [u8] = b"the second edition of the deck, a different size";
    let declared = manifest("1.2.0", tampered);
    network.serve(move |request| match request.url {
        MANIFEST => ok(declared.clone(), Some("tag-2")),
        _ => ok(vec![b'x'; tampered.len()], None),
    });
    let answer = library.sync(&network, &config(), true);
    assert_eq!(answer["ok"], false);
    assert_eq!((answer["checked"].clone(), answer["updated"].clone()), (json!(true), json!(false)));
    assert_eq!(answer["warning"], "Office design template deck-a sha256 mismatch");
    assert_eq!(answer["active"]["version"], "1.0.0", "the pack that was working keeps working");
    assert!(!library.pack_folder("1.2.0").exists(), "nothing of the failed pack stays behind");
    assert_eq!(library.state()["lastError"], "Office design template deck-a sha256 mismatch");
}

#[test]
fn a_manifest_that_cannot_be_trusted_or_reached_is_a_warning_not_an_error() {
    let library = Library::new();
    let network = Scripted::new(serving("1.0.0", TEMPLATE_BODY, "tag-1"));
    let strangers = json!({ "manifestUrl": MANIFEST, "trustedKeys": { "someone-else": public_pem() } });
    let untrusted = library.sync(&network, &strangers, false);
    assert_eq!((untrusted["ok"].clone(), untrusted["active"].clone()), (json!(false), Value::Null));
    assert_eq!(untrusted["warning"], "Office design pack signing key is not trusted: acme-key");
    let plain = json!({ "manifestUrl": "http://packs.example.test/manifest.json", "trustedKeys": { "acme-key": public_pem() } });
    let insecure = library.sync(&network, &plain, true);
    assert_eq!(insecure["warning"], "Office design pack manifest requires an HTTPS URL");
    network.serve(|_| Ok(FetchResponse { status: 503, ..FetchResponse::default() }));
    let down = library.sync(&network, &config(), true);
    assert_eq!(down["warning"], "Office design pack manifest download failed with HTTP 503");
    assert_eq!(network.requests().len(), 2, "the insecure address is refused before any request");
}

#[test]
fn without_a_manifest_url_or_with_remote_checks_off_the_library_is_only_indexed() {
    let library = Library::new();
    let network = Scripted::new(serving("1.0.0", TEMPLATE_BODY, "tag-1"));
    let local = library.sync(&network, &json!({ "trustedKeys": { "acme-key": public_pem() } }), true);
    assert_eq!((local["ok"].clone(), local["checked"].clone(), local["updated"].clone()), (json!(true), json!(false), Value::Null));
    assert_eq!(local["templates"], json!({ "changed": false, "count": 0, "templates": [] }));
    let data = library.data();
    let cx = Context { lane: &Unlaned, env: &library.env, fetch: &network, indexer: &NoIndex };
    let offline = sync_office_design_library(&cx, &SyncOptions { allow_remote: false, force: true, config: Some(&config()), ..SyncOptions::new(&data) }).expect("offline").to_value();
    assert_eq!(offline["checked"], false);
    assert!(network.requests().is_empty());
}