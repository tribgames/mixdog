#![allow(clippy::disallowed_methods, reason = "test setup: scratch files are written and read on the test thread")]

use std::sync::atomic::AtomicUsize;
use std::time::Duration;

use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::value;

use super::*;

struct Host(HashMap<String, Vec<u8>>);

#[async_trait]
impl AttachmentHost for Host {
    async fn session_transcript(&self, _session_id: &str) -> Option<Value> {
        None
    }

    async fn attachment_bytes(&self, id: &str) -> Option<Vec<u8>> {
        self.0.get(id).cloned()
    }
}

fn service(dir: &Path, attachments: HashMap<String, Vec<u8>>) -> DesktopResidualBService {
    let mut service = DesktopResidualBService::new(Arc::new(Host(attachments)), &mixdog_rt::testing::tokens(), dir.to_path_buf());
    service.temp = dir.join("temp");
    service
}

fn jpeg(width: u32, height: u32) -> Vec<u8> {
    let rgb: Vec<u8> = (0..width * height).flat_map(|i| [(i % 251) as u8, (i % 127) as u8, 40]).collect();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode(&rgb, width, height, image::ExtendedColorType::Rgb8).unwrap();
    out
}

// ---- local-file-links.test.mjs ---------------------------------------------------------------------------------------

#[test]
fn a_link_names_a_plain_local_path_or_is_refused() {
    assert_eq!(local_link_path("src/a%20b.ts?x=1#L3", false).unwrap(), "src/a b.ts");
    #[cfg(unix)]
    {
        assert_eq!(local_link_path("file:///srv/out/a.pdf", false).unwrap(), "/srv/out/a.pdf");
        assert_eq!(local_link_path("file://localhost/srv/a.txt", false).unwrap(), "/srv/a.txt");
    }
    assert_eq!(local_link_path("a\\b\\c.txt", false).unwrap(), "a/b/c.txt");
    for bad in ["file://server/share/a.txt", "//server/share/a.txt", "a|b.txt", "a*.txt", "a<b>.txt", "x:y.txt", "bad%zz.txt", "bad%ff.txt", "a\u{1}b", "", "C:/x/a.txt"] {
        assert!(local_link_path(bad, false).is_err(), "{bad:?}");
    }
    // A drive path is absolute only on Windows, where device names and trailing dots or spaces are refused too.
    assert_eq!(local_link_path("C:/x/a.txt", true).unwrap(), "C:/x/a.txt");
    for bad in ["x/con.txt", "x/NUL", "x/com1", "x/lpt9.log", "x/name.", "x/name "] {
        assert!(local_link_path(bad, true).is_err(), "{bad:?}");
    }
    assert!(local_link_path("x/com0.txt", true).is_ok());
    assert!(local_link_path("x/../y.txt", true).is_ok());
}

#[test]
fn the_launch_allowlists_follow_the_shared_tables() {
    for confirm in ["a.exe", "a.msi", "a.sh", "a.JS", "a.lnk", "a.appimage", "a.app"] {
        assert!(requires_file_launch_confirmation(confirm), "{confirm}");
    }
    for plain in ["a.txt", "a.zip", "a.pdf", "a"] {
        assert!(!requires_file_launch_confirmation(plain), "{plain}");
    }
    // Native previews and convertible documents stay in the editor; archives, installers and unlisted media go to the OS.
    for os in ["a.zip", "a.7z", "a.exe", "a.iso", "a.mkv", "a.tif"] {
        assert!(opens_in_os(os), "{os}");
    }
    for editor in ["a.ts", "a.md", "a.html", "a.pdf", "a.png", "a.docx", "a.pptx", "a.mp4", "a.js", "a.unknown", "a"] {
        assert!(!opens_in_os(editor), "{editor}");
    }
}

#[test]
fn a_link_is_decided_inside_the_project_only() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    std::fs::create_dir_all(root.join("docs")).unwrap();
    std::fs::write(root.join("a.ts"), "x").unwrap();
    std::fs::write(root.join("pack.zip"), "x").unwrap();
    std::fs::write(root.join("setup.exe"), "x").unwrap();
    std::fs::write(dir.path().join("outside.txt"), "x").unwrap();
    let project = root.to_string_lossy().into_owned();
    let decide = |href: &str, confirmed: Option<&str>| decide_local_link(&project, href, confirmed, cfg!(windows));
    let real = |name: &str| real_path(&root.join(name)).unwrap().to_string_lossy().into_owned();

    assert_eq!(decide("a.ts", None).unwrap(), LocalLinkOutcome::Editor);
    assert_eq!(decide("pack.zip", None).unwrap(), LocalLinkOutcome::Open { kind: "file", path: real("pack.zip") });
    assert_eq!(decide("docs", None).unwrap(), LocalLinkOutcome::Open { kind: "folder", path: real("docs") });
    // An executable asks first, and the answer must name the very path it asked about.
    assert_eq!(decide("setup.exe", None).unwrap(), LocalLinkOutcome::Confirm(real("setup.exe")));
    assert_eq!(decide("setup.exe", Some("elsewhere")).unwrap(), LocalLinkOutcome::Confirm(real("setup.exe")));
    assert_eq!(decide("setup.exe", Some(&real("setup.exe"))).unwrap(), LocalLinkOutcome::Open { kind: "file", path: real("setup.exe") });

    let escape = format!("{:?}", decide("../outside.txt", None).unwrap_err());
    assert!(escape.contains("escapes the project directory"), "{escape}");
    let gone = format!("{:?}", decide("docs/removed.pdf", None).unwrap_err());
    assert!(gone.contains("The file no longer exists: docs/removed.pdf"), "{gone}");
}

// ---- attachment-files.test.mjs ---------------------------------------------------------------------------------------

#[test]
fn an_attachment_takes_an_inert_extension_or_is_refused() {
    let url = |mime: &str, body: &str| json!(format!("data:{mime};base64,{body}"));
    // base64 of "hello"
    let hello = "aGVsbG8=";
    let (bytes, base, extension) = required_attachment_file(&url("application/pdf", hello), &json!("My Report (final).PDF")).unwrap();
    assert_eq!((bytes.as_slice(), base.as_str(), extension.as_str()), (&b"hello"[..], "My-Report-final", "pdf"));
    // The named extension wins when it is allowed; else the mime's; a text mime is a `.txt`.
    assert_eq!(required_attachment_file(&url("image/png", hello), &json!("shot.jpeg")).unwrap().2, "jpeg");
    assert_eq!(required_attachment_file(&url("image/png", hello), &json!("shot.exe")).unwrap().2, "png");
    assert_eq!(required_attachment_file(&url("text/x-custom", hello), &Value::Null).unwrap().2, "txt");
    assert_eq!(required_attachment_file(&url("application/ld+json", hello), &json!("a.bat")).unwrap().2, "txt");
    for (mime, name) in [("application/x-msdownload", "a.exe"), ("application/octet-stream", "a.bin"), ("text/html", "a.html")] {
        let result = required_attachment_file(&url(mime, hello), &json!(name));
        // `text/html` is a text kind, so it is written as `.txt`; the rest cannot be opened.
        assert_eq!(result.is_ok(), mime == "text/html", "{mime}");
    }
    assert!(required_attachment_file(&json!("data:text/plain;base64,"), &Value::Null).is_err());
    assert!(required_attachment_file(&json!(7), &Value::Null).is_err());
    assert!(required_attachment_file(&json!("data:text/plain;base64,!!!"), &Value::Null).is_err());
    // Percent-encoded and unpadded payloads.
    assert_eq!(required_attachment_file(&json!("data:text/plain,a%20b"), &Value::Null).unwrap().0, b"a b");
    assert_eq!(required_attachment_file(&url("text/plain", "aGVsbG8"), &Value::Null).unwrap().0, b"hello");
    assert_eq!(attachment_base_name(""), "image");
    assert_eq!(attachment_base_name("--.png"), "image");
    assert_eq!(attachment_base_name(&"a".repeat(80)).len(), 60);
}

#[test]
fn an_attachment_is_written_under_the_temp_folder_by_its_digest() {
    let dir = tempfile::tempdir().unwrap();
    let data = json!("data:application/pdf;base64,aGVsbG8=");
    let path = write_attachment_file(dir.path(), &data, &json!("spec.pdf")).unwrap();
    assert_eq!(path.parent().unwrap(), dir.path().join("mixdog-attachments"));
    assert_eq!(path.file_name().unwrap().to_string_lossy(), format!("spec-{}.pdf", &hex16(b"hello")));
    assert_eq!(std::fs::read(&path).unwrap(), b"hello");
    // A refused type touches nothing.
    let other = tempfile::tempdir().unwrap();
    assert!(write_attachment_file(other.path(), &json!("data:application/x-msdownload;base64,aGVsbG8="), &json!("a.exe")).is_err());
    assert!(!other.path().join("mixdog-attachments").exists());
}

/// A PNG of `width` x `height` gray-ramp RGB pixels in stored (uncompressed) deflate blocks; the reader does not check the chunk CRCs.
fn stored_png(width: u32, height: u32) -> Vec<u8> {
    let mut raw = Vec::new();
    for y in 0..height {
        raw.push(0u8);
        for x in 0..width {
            raw.extend_from_slice(&[(x % 256) as u8, (y % 256) as u8, 128]);
        }
    }
    let (mut low, mut high) = (1u32, 0u32);
    for byte in &raw {
        low = (low + u32::from(*byte)) % 65521;
        high = (high + low) % 65521;
    }
    let mut zlib = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(60_000).collect();
    for (index, block) in blocks.iter().enumerate() {
        zlib.push(u8::from(index + 1 == blocks.len()));
        zlib.extend_from_slice(&(block.len() as u16).to_le_bytes());
        zlib.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
        zlib.extend_from_slice(block);
    }
    zlib.extend_from_slice(&((high << 16) | low).to_be_bytes());
    let chunk = |kind: &[u8; 4], body: &[u8]| [&(body.len() as u32).to_be_bytes()[..], kind, body, &[0u8; 4]].concat();
    let mut header = Vec::new();
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]);
    [&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][..], &chunk(b"IHDR", &header), &chunk(b"IDAT", &zlib), &chunk(b"IEND", &[])].concat()
}

#[test]
fn a_png_picture_is_scaled_like_a_jpeg_one() {
    let url = thumbnail_of(&stored_png(640, 480), 0).unwrap();
    let bytes = base64::engine::general_purpose::STANDARD.decode(url.strip_prefix("data:image/jpeg;base64,").unwrap()).unwrap();
    assert_eq!(image::load_from_memory(&bytes).unwrap().to_rgb8().dimensions(), (320, 240));
    let small = base64::engine::general_purpose::STANDARD.decode(thumbnail_of(&stored_png(40, 30), 0).unwrap().strip_prefix("data:image/jpeg;base64,").unwrap()).unwrap();
    assert_eq!(image::load_from_memory(&small).unwrap().to_rgb8().dimensions(), (40, 30));
}

// ---- attachment-thumbnail.test.mjs -----------------------------------------------------------------------------------

#[test]
fn a_picture_is_scaled_to_a_thumbnail_or_handed_over_bounded() {
    let big = thumbnail_of(&jpeg(640, 480), 1024 * 1024).unwrap();
    let encoded = big.strip_prefix("data:image/jpeg;base64,").unwrap();
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
    let (width, height) = image::load_from_memory(&bytes).unwrap().to_rgb8().dimensions();
    assert_eq!((width, height), (320, 240));
    // A small picture keeps its size.
    let small = base64::engine::general_purpose::STANDARD.decode(thumbnail_of(&jpeg(40, 30), 0).unwrap().strip_prefix("data:image/jpeg;base64,").unwrap()).unwrap();
    assert_eq!(image::load_from_memory(&small).unwrap().to_rgb8().dimensions(), (40, 30));
    // What does not decode is handed over as it is while it fits the bound, else nothing.
    let png = [&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][..], b"not really a png"].concat();
    assert_eq!(thumbnail_of(&png, 1024).unwrap(), data_url_of("image/png", &png));
    assert_eq!(thumbnail_of(&png, 8), None);
    assert!(thumbnail_of(b"GIF89a....", 100).unwrap().starts_with("data:image/gif;base64,"));
    assert!(thumbnail_of(b"RIFF\0\0\0\0WEBPxx", 100).unwrap().starts_with("data:image/webp;base64,"));
    assert_eq!(thumbnail_of(b"plain text", 100), None);
    assert_eq!(thumbnail_of(&[], 100), None);
    // A broken JPEG falls back to the original.
    assert!(thumbnail_of(&[0xff, 0xd8, 0xff, 0x00, 0x01], 100).unwrap().starts_with("data:image/jpeg;base64,"));
}

#[tokio::test]
async fn the_thumbnail_method_reads_the_store_by_content_hash() {
    let dir = tempfile::tempdir().unwrap();
    let id = hex_of(&[0xab; 32]);
    let service = service(dir.path(), HashMap::from([(id.clone(), jpeg(64, 64))]));
    let ask = |params: Value| value(&service, request("desktop/attachment/thumbnail", params, None));
    assert!(ask(json!({ "attachmentRef": id })).await.unwrap()["dataUrl"].as_str().unwrap().starts_with("data:image/jpeg;base64,"));
    assert_eq!(ask(json!({ "attachmentRef": hex_of(&[2; 32]) })).await.unwrap(), json!({ "dataUrl": null }));
    for bad in [json!("../x"), json!(7), json!(id.to_uppercase())] {
        assert_eq!(ask(json!({ "attachmentRef": bad })).await.unwrap(), json!({ "dataUrl": null }));
    }
}

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---- launch-version.test.mjs -----------------------------------------------------------------------------------------

#[tokio::test]
async fn a_launch_is_recorded_and_an_update_announced_until_acknowledged() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("last-launch-version");
    let service = service(dir.path(), HashMap::new());
    let path = file.to_string_lossy().into_owned();
    let record = |version: &str, argv: &[&str]| {
        let params = json!({ "path": path, "version": version, "argv": argv });
        value(&service, request("desktop/launchVersion/record", params, None))
    };
    let announce = |reply: Value| reply["announce"].as_bool().unwrap();
    let stored = || std::fs::read_to_string(&file).unwrap();

    // No record: a fresh install announces nothing; a relaunch after an update (`--updated`) announces.
    assert!(!announce(record("1.0.0", &[]).await.unwrap()));
    assert_eq!(stored(), "{\"lastLaunched\":\"1.0.0\"}\n");
    assert!(!announce(record("1.0.0", &["--updated"]).await.unwrap()));
    // A strictly newer version announces and keeps announcing until acknowledged.
    assert!(announce(record("1.1.0", &[]).await.unwrap()));
    assert_eq!(stored(), "{\"lastLaunched\":\"1.1.0\",\"pendingAnnouncement\":\"1.1.0\"}\n");
    assert!(announce(record("1.1.0", &[]).await.unwrap()));
    let ack = |version: &str| value(&service, request("desktop/launchVersion/acknowledge", json!({ "path": path, "version": version }), None));
    ack("9.9.9").await.unwrap();
    assert!(stored().contains("pendingAnnouncement"));
    ack("1.1.0").await.unwrap();
    assert_eq!(stored(), "{\"lastLaunched\":\"1.1.0\"}\n");
    assert!(!announce(record("1.1.0", &[]).await.unwrap()));
    // A downgrade announces nothing and is recorded.
    assert!(!announce(record("1.0.5", &[]).await.unwrap()));
    assert_eq!(stored(), "{\"lastLaunched\":\"1.0.5\"}\n");
    // The first form of the record (the bare version) reads as that launch.
    std::fs::write(&file, "v1.0.5\n").unwrap();
    assert!(announce(record("1.2.0", &[]).await.unwrap()));
    // A crash-emptied or junk record is no record: nothing is announced for it.
    for junk in ["\0\0\0", "", "   ", "{\"lastLaunched\":", "banana"] {
        std::fs::write(&file, junk).unwrap();
        assert!(!announce(record("1.2.0", &[]).await.unwrap()), "{junk:?}");
        assert_eq!(stored(), "{\"lastLaunched\":\"1.2.0\"}\n");
    }
    // A record the launch cannot write is reported, not raised.
    let blocked = dir.path().join("blocked");
    std::fs::create_dir(&blocked).unwrap();
    let reply = value(&service, request("desktop/launchVersion/record", json!({ "path": blocked, "version": "1.0.0" }), None)).await.unwrap();
    assert_eq!(reply["announce"], json!(false));
    assert!(reply["writeError"].is_string());
}

#[test]
fn a_bare_version_is_what_the_first_form_of_the_record_wrote() {
    for good in ["1.1.0", "v1.1.0", "10.20.30-beta.1", "1.2.3+build_5"] {
        assert!(is_bare_version(good), "{good}");
    }
    for bad in ["1.1", "1.1.x", "v", "a.b.c", "1.1.0 ", "1..0"] {
        assert!(!is_bare_version(bad), "{bad}");
    }
}

// ---- model-bootstrap.test.mjs ----------------------------------------------------------------------------------------

fn preset(id: &str, model: &str) -> Value {
    json!({ "id": id, "name": id, "type": "agent", "provider": "anthropic-oauth", "model": model })
}

#[test]
fn the_first_snapshot_carries_the_default_preset_route() {
    let config = |agent: Value| json!({ "agent": agent });
    let mut high = preset("mine", "claude-x");
    high["effort"] = json!("high");
    let snapshot = model_bootstrap_from_config(&config(json!({ "presets": [high.clone()], "default": "mine" }))).unwrap();
    assert_eq!(
        snapshot,
        json!({ "items": [], "queued": [], "busy": false, "commandBusy": false, "provider": "anthropic-oauth", "model": "claude-x", "effort": "high" })
    );
    // By name; a model setting overrides the effort and the fast flag; fast models and the preset itself come after.
    let by_name = config(json!({
        "presets": [high.clone()], "default": "mine",
        "modelSettings": { "anthropic-oauth/claude-x": { "effort": "low", "fast": true } },
    }));
    let snapshot = model_bootstrap_from_config(&by_name).unwrap();
    assert_eq!((snapshot["effort"].clone(), snapshot["fast"].clone()), (json!("low"), json!(true)));
    let fast_models = config(json!({ "presets": [high.clone()], "default": "mine", "fastModels": { "anthropic-oauth/claude-x": true } }));
    assert_eq!(model_bootstrap_from_config(&fast_models).unwrap()["fast"], json!(true));
    let setting_off = config(json!({
        "presets": [high], "default": "mine",
        "fastModels": { "anthropic-oauth/claude-x": true },
        "modelSettings": { "anthropic-oauth/claude-x": { "fast": false } },
    }));
    assert_eq!(model_bootstrap_from_config(&setting_off).unwrap()["fast"], json!(false));
    // A nested agent document is read when it holds the providers; a numeric default indexes the effective list.
    let nested = json!({ "agent": { "agent": { "providers": { "p": {} }, "presets": [preset("a", "m1"), preset("b", "m2")], "default": 1 } } });
    assert_eq!(model_bootstrap_from_config(&nested).unwrap()["model"], json!("m2"));
    let digits = json!({ "agent": { "presets": [preset("a", "m1"), preset("b", "m2")], "default": "0" } });
    assert_eq!(model_bootstrap_from_config(&digits).unwrap()["model"], json!("m1"));
    // Nothing usable: no agent, no default, an unknown default, an index past the list.
    for none in [json!({}), json!({ "agent": null }), config(json!({ "presets": [preset("a", "m")] })), config(json!({ "default": "" })), config(json!({ "default": "ghost" })), config(json!({ "default": 4000 }))] {
        assert_eq!(model_bootstrap_from_config(&none), None, "{none}");
    }
}

#[tokio::test]
async fn the_model_bootstrap_method_reads_the_config_file() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path(), HashMap::new());
    let ask = || value(&service, request("desktop/modelBootstrap/read", json!({}), None));
    assert_eq!(ask().await.unwrap(), json!({ "snapshot": null }));
    std::fs::write(dir.path().join("mixdog-config.json"), "not json").unwrap();
    assert_eq!(ask().await.unwrap(), json!({ "snapshot": null }));
    std::fs::write(dir.path().join("mixdog-config.json"), json!({ "agent": { "presets": [preset("p", "m")], "default": "p" } }).to_string()).unwrap();
    assert_eq!(ask().await.unwrap()["snapshot"]["model"], json!("m"));
}

// ---- native-runtime-cache-gc.test.mjs and user-file-write.test.mjs ------------------------------------------------------

#[tokio::test]
async fn a_superseded_native_cache_is_removed_and_the_others_stay() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["graph-bin", "spawn-bin", "patch-bin"] {
        std::fs::create_dir_all(dir.path().join(name).join("1.0")).unwrap();
        std::fs::write(dir.path().join(name).join("1.0").join("tool"), "x").unwrap();
    }
    let service = service(dir.path(), HashMap::new());
    let reply = value(&service, request("desktop/nativeToolCache/gc", json!({ "bundledKinds": ["graph", "graph", "bogus", "supervisor", "patch"] }), None)).await.unwrap();
    assert_eq!(reply, json!({ "removed": ["graph", "supervisor", "patch"], "failed": [] }));
    assert!(!dir.path().join("graph-bin").exists() && !dir.path().join("patch-bin").exists());
    assert!(dir.path().join("spawn-bin").join("1.0").join("tool").exists());
}

#[tokio::test]
async fn a_user_file_is_rewritten_in_place_or_created() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path(), HashMap::new());
    let write = |params: Value| value(&service, request("desktop/userFile/write", params, None));
    let file = dir.path().join("notes.txt");
    std::fs::write(&file, "a much longer old content").unwrap();
    assert_eq!(write(json!({ "path": file, "text": "short" })).await.unwrap(), json!({ "bytes": 5 }));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "short");
    write(json!({ "path": file, "dataBase64": "AAEC" })).await.unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), [0, 1, 2]);
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    let created = dir.path().join("sub").join("new.txt");
    write(json!({ "path": created, "text": "fresh" })).await.unwrap();
    assert_eq!(std::fs::read_to_string(&created).unwrap(), "fresh");
    assert!(write(json!({ "path": file })).await.is_err());
    assert!(write(json!({ "path": file, "text": "a", "dataBase64": "AA==" })).await.is_err());
    assert!(write(json!({ "path": file, "dataBase64": "***" })).await.is_err());
    // A symlink stays a link: its target is written.
    #[cfg(unix)]
    {
        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        write(json!({ "path": link, "text": "via link" })).await.unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "via link");
    }
}

// ---- linux-input-access.test.mjs -------------------------------------------------------------------------------------

struct FakeMachine {
    platform: &'static str,
    access: AtomicBool,
    device: bool,
    status: PkexecStatus,
    grants_access: bool,
    pkexec_runs: AtomicUsize,
    waits: AtomicUsize,
}

impl FakeMachine {
    fn new(status: PkexecStatus) -> Arc<Self> {
        Arc::new(Self { platform: "linux", access: AtomicBool::new(false), device: true, status, grants_access: true, pkexec_runs: AtomicUsize::new(0), waits: AtomicUsize::new(0) })
    }
}

#[async_trait]
impl InputAccessProbe for FakeMachine {
    fn platform(&self) -> &'static str {
        self.platform
    }

    fn can_access(&self) -> bool {
        self.access.load(Ordering::SeqCst)
    }

    fn device_exists(&self) -> bool {
        self.device
    }

    async fn run_pkexec(&self, _script: &str) -> PkexecStatus {
        self.pkexec_runs.fetch_add(1, Ordering::SeqCst);
        tokio::task::yield_now().await;
        if self.status == PkexecStatus::Exit(0) && self.grants_access {
            self.access.store(true, Ordering::SeqCst);
        }
        self.status
    }

    async fn wait(&self, _millis: u64) {
        self.waits.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn the_uinput_rule_is_installed_once_and_only_when_needed() {
    let ask = |machine: &Arc<FakeMachine>| {
        let machine = Arc::clone(machine);
        async move { InputAccessRequests::default().request(machine).await }
    };
    let mut other = FakeMachine::new(PkexecStatus::Exit(0));
    Arc::get_mut(&mut other).unwrap().platform = "darwin";
    assert_eq!(ask(&other).await, json!({ "ok": false, "reason": "failed" }));

    let ready = FakeMachine::new(PkexecStatus::Exit(0));
    ready.access.store(true, Ordering::SeqCst);
    assert_eq!(ask(&ready).await, json!({ "ok": true }));
    assert_eq!(ready.pkexec_runs.load(Ordering::SeqCst), 0);

    assert_eq!(ask(&FakeMachine::new(PkexecStatus::Exit(0))).await, json!({ "ok": true }));
    assert_eq!(ask(&FakeMachine::new(PkexecStatus::Missing)).await["reason"], json!("pkexec_missing"));
    assert_eq!(ask(&FakeMachine::new(PkexecStatus::Exit(126))).await["reason"], json!("cancelled"));
    let failed = ask(&FakeMachine::new(PkexecStatus::Exit(3))).await;
    assert_eq!((failed["reason"].clone(), failed["exitCode"].clone()), (json!("failed"), json!(3)));

    // A clean exit that changed nothing: the access is rechecked a bounded number of times, then the cause is named.
    let mut stuck = FakeMachine::new(PkexecStatus::Exit(0));
    Arc::get_mut(&mut stuck).unwrap().grants_access = false;
    let relogin = ask(&stuck).await;
    assert_eq!((relogin["reason"].clone(), relogin["detail"].clone()), (json!("access_unavailable"), json!("relogin")));
    assert_eq!(stuck.waits.load(Ordering::SeqCst), RECHECK_ATTEMPTS);
    let mut no_module = FakeMachine::new(PkexecStatus::Exit(0));
    {
        let machine = Arc::get_mut(&mut no_module).unwrap();
        machine.grants_access = false;
        machine.device = false;
    }
    assert_eq!(ask(&no_module).await["detail"], json!("no-module"));
}

#[tokio::test]
async fn two_requests_in_flight_share_one_prompt() {
    let machine = FakeMachine::new(PkexecStatus::Exit(0));
    let requests = InputAccessRequests::default();
    let (first, second) = futures::join!(requests.request(machine.clone()), requests.request(machine.clone()));
    assert_eq!((first, second), (json!({ "ok": true }), json!({ "ok": true })));
    assert_eq!(machine.pkexec_runs.load(Ordering::SeqCst), 1);
}

#[test]
fn the_privileged_script_holds_constants_only() {
    let script = install_script();
    assert!(script.starts_with("set -e\nprintf '%s\\n' '# Mixdog Computer Use: grant"));
    assert!(script.contains("> /etc/udev/rules.d/70-mixdog-uinput.rules\n"));
    assert!(script.contains("'uinput' > /etc/modules-load.d/mixdog-uinput.conf\n"));
    assert!(script.ends_with("udevadm settle --timeout=5"));
}

// ---- conversation-import-progress.test.mjs ---------------------------------------------------------------------------

struct Jobs {
    jobs: Mutex<Vec<Value>>,
    published: Mutex<Vec<Value>>,
    fail: AtomicBool,
}

#[async_trait]
impl ImportJobSource for Jobs {
    async fn fetch_jobs(&self) -> Result<Vec<Value>, String> {
        if self.fail.load(Ordering::SeqCst) { Err("down".to_owned()) } else { Ok(self.jobs.lock().unwrap().clone()) }
    }

    fn publish(&self, event: &str, job: &Value) {
        assert_eq!(event, "conversation-import-progress");
        self.published.lock().unwrap().push(job.clone());
    }
}

fn job(id: &str, seq: u64, state: &str, processed: u64) -> Value {
    json!({ "jobId": id, "seq": seq, "state": state, "processed": processed })
}

#[tokio::test]
async fn a_changed_job_is_published_once_and_polled_while_it_runs() {
    // The poll runs as a mixdog-rt task: the test backend must be installed.
    mixdog_rt::testing::tokens();
    let source = Arc::new(Jobs { jobs: Mutex::new(vec![]), published: Mutex::new(vec![]), fail: AtomicBool::new(false) });
    let progress = ImportProgress::new(source.clone(), Duration::from_millis(20));
    let published = || source.published.lock().unwrap().len();

    progress.observe("somethingElse", &job("a", 1, "running", 0));
    progress.observe("startConversationImport", &json!({ "noJobId": true }));
    assert_eq!(published(), 0);
    progress.observe("startConversationImport", &job("a", 1, "running", 0));
    progress.observe("cancelConversationImport", &job("a", 1, "running", 0));
    assert_eq!(published(), 1, "an unchanged stamp is not published again");
    progress.observe("getConversationImportJobs", &json!({ "jobs": [job("a", 2, "running", 5), job("b", 1, "done", 9), "junk"] }));
    assert_eq!(published(), 3, "every job of a list is published, the finished one too");

    // The poll picks up the runtime's next state of the running job and stops once nothing runs.
    *source.jobs.lock().unwrap() = vec![job("a", 3, "done", 10), job("b", 1, "done", 9)];
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(published(), 4);
    assert_eq!(source.published.lock().unwrap().last().unwrap()["state"], json!("done"));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(published(), 4);

    // After a dispose, nothing more is published.
    progress.dispose();
    progress.observe("startConversationImport", &job("c", 1, "running", 0));
    assert_eq!(published(), 4);
}

#[test]
fn a_stamp_reads_a_missing_field_as_undefined() {
    assert_eq!(template_text(None), "undefined");
    assert_eq!(template_text(Some(&json!(null))), "null");
    assert_eq!(template_text(Some(&json!(7))), "7");
    assert!(is_job_active(&job("a", 1, "stopping", 0)));
    assert!(!is_job_active(&job("a", 1, "failed", 0)));
}

// ---- network-watch.test.mjs ------------------------------------------------------------------------------------------

#[test]
fn the_network_signature_lists_external_addresses_in_order() {
    assert_eq!(network_signature(&[("wifi", "10.0.0.2", false), ("lo", "127.0.0.1", true), ("eth", "192.168.1.5", false)]), "eth:192.168.1.5|wifi:10.0.0.2");
    assert_eq!(network_signature(&[]), "");
}

#[test]
fn the_leg_redials_when_the_network_returns_or_changes_while_online() {
    let snapshot = |online: bool, signature: &str| NetworkSnapshot { online, signature: signature.to_owned() };
    assert!(!network_changed(&snapshot(true, "a"), &snapshot(true, "a")));
    assert!(network_changed(&snapshot(true, "a"), &snapshot(true, "b")));
    assert!(network_changed(&snapshot(false, ""), &snapshot(true, "a")));
    assert!(!network_changed(&snapshot(true, "a"), &snapshot(false, "")));
    assert!(!network_changed(&snapshot(false, "a"), &snapshot(false, "b")));
}

#[tokio::test]
async fn the_watcher_fires_on_a_change_and_stops() {
    // The poll runs as a mixdog-rt task: the test backend must be installed.
    mixdog_rt::testing::tokens();
    let current = Arc::new(Mutex::new(NetworkSnapshot { online: true, signature: "a".to_owned() }));
    let fired = Arc::new(AtomicUsize::new(0));
    let watcher = NetworkWatcher::start(
        Duration::from_millis(10),
        {
            let current = Arc::clone(&current);
            Arc::new(move || current.lock().unwrap().clone())
        },
        {
            let fired = Arc::clone(&fired);
            Arc::new(move || {
                fired.fetch_add(1, Ordering::SeqCst);
            })
        },
    );
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(fired.load(Ordering::SeqCst), 0);
    current.lock().unwrap().signature = "b".to_owned();
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(fired.load(Ordering::SeqCst), 1);
    watcher.stop();
    current.lock().unwrap().signature = "c".to_owned();
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(fired.load(Ordering::SeqCst), 1);
}

// ---- login-shell-environment.test.mjs --------------------------------------------------------------------------------

fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect()
}

#[test]
fn the_dump_between_the_marks_is_the_environment() {
    let dump = format!("motd chatter\0{LOGIN_ENV_MARK}\0PATH=/usr/bin:/opt/x\0EMPTY=\0WITH=EQ=ual\0=nokey\0junk\0{LOGIN_ENV_MARK}\0more chatter");
    assert_eq!(extract_login_shell_environment(&dump), Some(map(&[("PATH", "/usr/bin:/opt/x"), ("EMPTY", ""), ("WITH", "EQ=ual")])));
    // Until both marks arrived there is no environment.
    assert_eq!(extract_login_shell_environment(&format!("\0{LOGIN_ENV_MARK}\0PATH=/x\0")), None);
    assert_eq!(extract_login_shell_environment("nothing"), None);
}

#[test]
fn the_shell_wins_except_for_the_probe_electron_and_launcher_values() {
    let inherited = map(&[("PATH", "/usr/bin"), ("HOME", "/home/u"), ("MIXDOG_PROFILE", "/isolated"), ("SAME", "1")]);
    let shell = map(&[
        ("PATH", "/opt/bin:/usr/bin"),
        ("HOME", "/home/u"),
        ("MIXDOG_PROFILE", "/shell"),
        ("MIXDOG_NEW", "x"),
        ("ELECTRON_RUN_AS_NODE", "1"),
        ("PWD", "/tmp"),
        ("OLDPWD", "/"),
        ("SHLVL", "2"),
        ("_", "/usr/bin/env"),
        ("DISABLE_AUTO_UPDATE", "true"),
        ("SAME", "1"),
        ("OPENAI_API_KEY", "k"),
    ]);
    assert_eq!(login_shell_overrides(&inherited, &shell), map(&[("PATH", "/opt/bin:/usr/bin"), ("MIXDOG_NEW", "x"), ("OPENAI_API_KEY", "k")]));
}

#[test]
fn homebrew_directories_are_appended_never_prepended() {
    let exists = |dir: &str| dir == "/opt/homebrew/bin" || dir == "/usr/local/bin";
    assert_eq!(with_homebrew_path(Some("/usr/bin:/bin"), exists), ("/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin".to_owned(), vec!["/opt/homebrew/bin".to_owned(), "/usr/local/bin".to_owned()]));
    // A directory already there stays where the user put it; an empty component is kept verbatim.
    assert_eq!(with_homebrew_path(Some("/usr/local/bin::/bin"), exists), ("/usr/local/bin::/bin:/opt/homebrew/bin".to_owned(), vec!["/opt/homebrew/bin".to_owned()]));
    assert_eq!(with_homebrew_path(None, exists).0, "/opt/homebrew/bin:/usr/local/bin");
    assert_eq!(with_homebrew_path(Some("/usr/bin"), |_| false), ("/usr/bin".to_owned(), vec![]));
}

#[test]
fn a_windows_launch_skips_the_read_and_a_spent_budget_records_a_timeout() {
    assert_eq!(read_login_shell_environment("win32", Some(vec!["/bin/zsh".to_owned()]), LOGIN_SHELL_READ_BUDGET), LoginShellRead::default());
    let read = read_login_shell_environment("linux", Some(vec!["/bin/zsh".to_owned(), "/bin/sh".to_owned()]), Duration::ZERO);
    assert_eq!(read.environment, None);
    assert_eq!(read.failures, vec![LoginShellFailure { shell: "/bin/zsh".to_owned(), reason: "timeout".to_owned() }]);
}

#[test]
fn every_method_of_the_service_is_listed_once() {
    let mut names = METHODS.to_vec();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), METHODS.len());
    assert!(METHODS.iter().all(|name| name.starts_with("desktop/")));
}
