//! Replay of `native/core/fixtures/media-store-cases` (`record-media-store-cases.mjs`, Node's
//! `src/runtime/media/store.test.mjs`): every case's calls go through the `media/*` protocol methods
//! of [`MediaService`] over a real data dir (a save through [`MediaStore::save_asset`], the store a
//! media job saves through; `mediaOpenCommand` through [`open_command`]), with the recording's clock
//! (`Date.now` held at `clock.dateNow`), its scripted ids (`00000000-0000-4000-8000-<counter>`, one
//! counter over the set, as the recorder's) and its zone (UTC). Each case's observation is compared
//! whole with the recorded one, `thumbnailBurst` (the index cache's counters around a burst of
//! resolves, `mediaStoreCacheStats`) included. A thrown error is compared as it crosses the wire
//! (`call-route.mjs`: `{ error: message, code?, details? }`).

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use base64::Engine as _;
use mixdog_core_api::ids::Method;
use mixdog_core_api::{CallContext, CoreError, CoreRequest, DomainService, Reply};
use mixdog_testkit::Exact;
use serde_json::{Map, Value, json};

use super::jobs::{GeneratedMedia, GenerationRequest, MediaFailure, MediaGenerator, MediaJobs, ResolvedMedia};
use super::renditions::StillRenditions;
use super::service::{MediaService, open_command};
use super::store::{Marks, MediaStore};
use crate::tidy::process::Processes;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/media-store-cases/golden.json");
const DAY: i64 = 24 * 60 * 60 * 1_000;

/// No media lane is reached: every recorded case reads, saves or deletes stored assets.
struct NoLanes;

#[async_trait]
impl MediaGenerator for NoLanes {
    async fn resolve(&self, lane: &str, _: &str, _: &str) -> Result<ResolvedMedia, MediaFailure> {
        Err(MediaFailure::new(format!("unknown media lane \"{lane}\""), "MEDIA_LANE_UNKNOWN"))
    }
    async fn generate(&self, _: GenerationRequest) -> Result<GeneratedMedia, MediaFailure> {
        unreachable!("no case generates")
    }
    async fn lanes(&self) -> Value {
        json!([])
    }
}

/// The recording's clock and its scripted uuids (one counter over the whole set).
struct Script {
    now: i64,
    ids: Arc<AtomicU64>,
}

impl Script {
    fn marks(&self) -> Marks {
        let (now, ids) = (self.now, self.ids.clone());
        Marks {
            now: Arc::new(move || now),
            id: Arc::new(move || format!("00000000-0000-4000-8000-{:012}", ids.fetch_add(1, Ordering::SeqCst) + 1)),
        }
    }
}

/// One store instance (Node's fresh module instance) and its service over `data`.
struct Store {
    store: Arc<MediaStore>,
    service: MediaService,
}

fn open(data: &Path, script: &Script) -> Store {
    let lane = mixdog_rt::testing::tokens().durability_io;
    let store = Arc::new(MediaStore::with_marks(data, lane, script.marks()));
    let jobs = MediaJobs::new(store.clone(), Arc::new(NoLanes), None);
    // The stub bytes cannot render: a host that makes no rendition (the recording asks with `generate: false` or reads a cached one).
    let host = super::renditions::tests::scripted(Ok(json!({"ok": null})), std::time::Duration::ZERO);
    let renditions = StillRenditions::new(Arc::new(mixdog_exthost::ExtImageCodec::new(host)), lane, store.renditions_dir());
    let service = MediaService::new(store.clone(), jobs, Processes::for_tests(), renditions);
    Store { store, service }
}

impl Store {
    async fn call(&self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        let request = CoreRequest { method: Method(method), params, op: None, ctx: CallContext::internal("replay") };
        match self.service.call(request).await? {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(_) => panic!("{method} answers a value"),
        }
    }

    async fn ok(&self, method: &'static str, params: Value) -> Value {
        self.call(method, params.clone()).await.unwrap_or_else(|error| panic!("{method} {params}: {error:?}"))
    }

    /// `thrown(fn)` of the recorder: the call's refusal as it crosses the wire.
    async fn threw(&self, method: &'static str, params: Value) -> Value {
        match self.call(method, params.clone()).await {
            Ok(value) => json!({"returned": value}),
            Err(error) => json!({"threw": wire_of_core(&error)}),
        }
    }

    async fn list(&self, options: Value) -> Value {
        self.ok("media/listMediaAssets", json!({"opId": "o", "options": options})).await
    }

    /// A save in the recording's zone (UTC): the asset's date folder (and a migrated one's) is the
    /// local date. The zone is this thread's only, so the save runs here rather than on a lane, and
    /// no other test of the binary sees it.
    async fn save(&self, kind: &str, lane: &str, model: &str, prompt: &str, options: Value, mime: &str, bytes: &[u8], meta: Value) -> Value {
        let meta: Map<String, Value> = meta.as_object().cloned().unwrap_or_default();
        mixdog_js::time::with_local_zone(mixdog_js::time::Tz::UTC, || self.store.save_asset(kind, lane, model, prompt, options, mime, bytes, meta)).unwrap()
    }
}

/// A refusal on the wire (`call-route.mjs`): its message, its `code` when it has one, and its
/// `details`.
fn wire_of_core(error: &CoreError) -> Value {
    let CoreError::DomainError { code, message, detail, .. } = error else { panic!("a domain refusal, not {error:?}") };
    let mut wire = json!({"error": message.as_deref().unwrap_or_default()});
    if let Some(code) = code {
        wire["code"] = json!(code.as_ref());
    }
    assert!(detail.is_none(), "no media refusal carries details: {detail:?}");
    wire
}

/// The recorded error as Node's `call-route.mjs` sends it: `{ error: message, code?, details? }`.
fn node_wire(value: &Exact) -> Exact {
    match value {
        Exact::Error { message, code, props, .. } => {
            let mut wire = vec![("error".to_owned(), Exact::String(message.clone()))];
            if let Some(code) = code {
                wire.push(("code".to_owned(), (**code).clone()));
            }
            if let Some((_, details)) = props.iter().find(|(key, _)| key == "details") {
                wire.push(("details".to_owned(), details.clone()));
            }
            Exact::Object(wire)
        }
        Exact::Object(entries) => Exact::Object(entries.iter().map(|(k, v)| (k.clone(), node_wire(v))).collect()),
        Exact::Array(items) => Exact::Array(items.iter().map(node_wire).collect()),
        other => other.clone(),
    }
}

/// `<data>` for the temp data dir in a path the manifest lists (`normalised.paths`).
fn data_path(value: &Value, data: &Path) -> Value {
    json!(value.as_str().expect("a path").replace(&*data.to_string_lossy(), "<data>"))
}

/// The manifest's `normalised` message: `<data>` and the temp file's 16 random hex as `<random>`.
fn data_text(text: &str, data: &Path) -> String {
    let text = text.replace(&*data.to_string_lossy(), "<data>");
    let mark = "mixdog-tmp-";
    let mut out = String::new();
    let mut rest = text.as_str();
    while let Some(at) = rest.find(mark) {
        let (head, tail) = rest.split_at(at + mark.len());
        out.push_str(head);
        let hex = tail.chars().take(16).take_while(char::is_ascii_hexdigit).count();
        if hex == 16 {
            out.push_str("<random>");
            rest = &tail[16..];
        } else {
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn assets_file(assets: &Path, file: &Value) -> std::path::PathBuf {
    file.as_str().expect("a file").split('/').fold(assets.to_path_buf(), |path, part| path.join(part))
}

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&mixdog_testkit::read(path)).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn plain(recorded: &Exact) -> Value {
    recorded.to_plain().expect("a plain recorded input")
}

async fn media_assets_are_organized(script: &Script, recorded: &Exact, data: &Path) -> Value {
    let assets = data.join("media").join("assets");
    mixdog_testkit::create_dir_all(&assets);
    mixdog_testkit::write(assets.join("legacy-image.jpg"), b"image");
    mixdog_testkit::write(assets.join("legacy-video.mp4"), b"video");
    let start_index = plain(recorded.get("startIndex"));
    mixdog_testkit::write(data.join("media").join("index.json"), serde_json::to_vec(&start_index).unwrap());
    let s = open(data, script);
    let mut out = json!({"files": plain(recorded.get("files")), "startIndex": start_index});
    let command = |path: &str, platform: &str| {
        let (program, args) = open_command(Path::new(path), true, platform);
        json!([program, args])
    };
    out["openCommands"] = json!([command("C:\\Media Assets\\clip.mp4", "windows"), command("/Users/me/Media Assets/image.png", "macos")]);
    out["beforeMigration"] = s.list(json!({"limit": 10})).await["assets"].clone();
    let saved = s.save("video", "gemini", "veo:3/preview", "new clip", json!({"aspectRatio": "16:9"}), "video/mp4", b"new-video", json!({})).await;
    let migrated = s.list(json!({"limit": 10})).await["assets"].clone();
    let listed: Vec<Value> = ["legacy-image", "legacy-video"]
        .iter()
        .map(|id| migrated.as_array().unwrap().iter().find(|entry| entry["id"] == *id).cloned().unwrap_or(Value::Null))
        .collect();
    out["migrated"] = json!(listed);
    out["migratedFilesExist"] = json!(listed.iter().map(|entry| assets_file(&assets, &entry["file"]).exists()).collect::<Vec<_>>());
    out["legacyFlatFileRemains"] = json!(assets.join("legacy-image.jpg").exists());
    // The burst Node measured with its cache counters: three concurrent resolves of the originals.
    let before = s.store.cache_stats();
    let original = |id: &'static str| s.ok("media/resolveMediaFile", json!({"opId": "o", "id": id}));
    let _burst = tokio::join!(original("legacy-image"), original("legacy-video"), original("legacy-image"));
    out["thumbnailBurst"] = json!({"before": before, "after": s.store.cache_stats()});
    out["cachedOnlyMiss"] = s.ok("media/resolveMediaFile", json!({"opId": "o", "id": "legacy-image", "options": {"variant": "thumb", "generate": false}})).await;
    let mut read_video = s.ok("media/readMediaAsset", json!({"opId": "o", "id": "legacy-video"})).await;
    read_video["path"] = data_path(&read_video["path"], data);
    out["readVideo"] = read_video;
    out["readThumbMiss"] = s.ok("media/readMediaAsset", json!({"opId": "o", "id": "legacy-image", "options": {"variant": "thumb", "generate": false}})).await;
    let mut downgraded = s.ok("media/readMediaAsset", json!({"opId": "o", "id": "legacy-image", "options": {"variant": "thumb", "allowOriginal": true, "generate": false}})).await;
    downgraded["path"] = data_path(&downgraded["path"], data);
    out["readThumbDowngraded"] = downgraded;
    let thumb = json!({"mime": "image/jpeg", "base64": b64(b"browser-generated-thumbnail"), "durationSeconds": 7});
    out["cachedThumbnail"] = s.ok("media/cacheMediaThumbnail", json!({"opId": "o", "id": "legacy-video", "input": thumb})).await;
    let mut target = s.ok("media/resolveMediaFile", json!({"opId": "o", "id": "legacy-video", "options": {"variant": "thumb", "generate": false}})).await;
    target["path"] = data_path(&target["path"], data);
    out["cachedTarget"] = target;
    let mut cached_read = s.ok("media/readMediaAsset", json!({"opId": "o", "id": "legacy-video", "options": {"variant": "thumb"}})).await;
    cached_read["path"] = data_path(&cached_read["path"], data);
    out["cachedRead"] = cached_read;
    out["saved"] = json!({"asset": saved, "fileExists": assets_file(&assets, &saved["file"]).exists()});
    let deleted = s.ok("media/deleteMediaAsset", json!({"opId": "o", "id": saved["id"]})).await;
    out["deleted"] = json!({"result": deleted, "fileExists": assets_file(&assets, &saved["file"]).exists()});
    out["persistedIndex"] = read_json(&data.join("media").join("index.json"));
    out
}

/// Windows only, as Node's test: a read-only `index.json` refuses the rename of the duration write.
#[cfg(windows)]
async fn a_failed_duration_write(script: &Script, recorded: &Exact, data: &Path) -> Value {
    let assets = data.join("media").join("assets");
    mixdog_testkit::create_dir_all(&assets);
    mixdog_testkit::write(assets.join("clip.mp4"), b"video");
    let start_index = plain(recorded.get("startIndex"));
    let index = data.join("media").join("index.json");
    mixdog_testkit::write(&index, serde_json::to_vec(&start_index).unwrap());
    let s = open(data, script);
    s.list(json!({"limit": 10})).await;
    mixdog_testkit::set_readonly(&index, true);
    let cached_row = s.list(json!({"limit": 10})).await["assets"][0].clone();
    let input = json!({"mime": "image/jpeg", "base64": b64(b"thumb"), "durationSeconds": 7});
    let mut error = s.threw("media/cacheMediaThumbnail", json!({"opId": "o", "id": "clip", "input": input})).await;
    if let Some(message) = error.pointer("/threw/error").and_then(Value::as_str).map(|m| data_text(m, data)) {
        error["threw"]["error"] = json!(message);
    }
    let out = json!({"startIndex": start_index, "indexMadeReadOnly": true, "cacheMediaThumbnail": error, "cachedRow": cached_row, "listedAfter": s.list(json!({"limit": 10})).await});
    mixdog_testkit::set_readonly(&index, false);
    let backup = data.join("media").join("index.json.bak");
    if backup.exists() {
        mixdog_testkit::set_readonly(&backup, false);
    }
    out
}

async fn bulk_media_cleanup(script: &Script, recorded: &Exact, data: &Path) -> Value {
    let assets_dir = data.join("media").join("assets");
    mixdog_testkit::create_dir_all(&assets_dir);
    let assets = plain(recorded.get("assets"));
    let now = recorded.get("now").as_f64() as i64;
    // The recorder's rows: every file is written but `gone`'s, each holding its id.
    for row in assets.as_array().unwrap() {
        if row["id"] != "gone" {
            mixdog_testkit::write(assets_file(&assets_dir, &row["file"]), row["id"].as_str().unwrap());
        }
    }
    mixdog_testkit::write(data.join("media").join("index.json"), serde_json::to_vec(&json!({"version": 2, "assets": assets})).unwrap());
    let s = open(data, script);
    let ids = || async { json!(s.list(json!({"limit": 50})).await["assets"].as_array().unwrap().iter().map(|entry| entry["id"].clone()).collect::<Vec<_>>()) };
    let delete = |filter: Value| s.ok("media/deleteMediaAssets", json!({"opId": "o", "filter": filter}));
    let mut out = json!({"assets": assets, "now": now});
    out["noSelector"] = s.threw("media/deleteMediaAssets", json!({"opId": "o", "filter": {"kind": "image"}})).await;
    let preview = delete(json!({"kind": "image", "before": now - 30 * DAY, "dryRun": true})).await;
    out["preview"] = preview.clone();
    out["idsAfterDryRun"] = ids().await;
    out["deleteByIds"] = delete(json!({"ids": preview["ids"]})).await["ids"].clone();
    out["oldFileExists"] = json!(assets_dir.join("old.png").exists());
    out["deleteMissing"] = delete(json!({"kind": "image", "missing": true})).await["ids"].clone();
    out["deletePickedWithinKind"] = delete(json!({"ids": ["picked", "clip"], "kind": "image"})).await["ids"].clone();
    out["deleteAllImages"] = delete(json!({"kind": "image", "all": true})).await["ids"].clone();
    out["idsAfter"] = ids().await;
    out["clipFileExists"] = json!(assets_dir.join("clip.mp4").exists());
    out
}

async fn a_nul_filled_index(script: &Script, recorded: &Exact, data: &Path) -> Value {
    let media = data.join("media");
    mixdog_testkit::create_dir_all(&media);
    mixdog_testkit::write(media.join("index.json"), [0u8; 128]);
    let s = open(data, script);
    let mut out = json!({"indexFile": plain(recorded.get("indexFile"))});
    out["listed"] = s.list(json!({"limit": 10})).await;
    // `readdirSync` order: the directory's own.
    let names: Vec<String> = std::fs::read_dir(&media).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    out["mediaDirNames"] = json!(names);
    let saved = s.save("image", "lane", "model", "p", json!({}), "image/png", b"png-bytes", json!({})).await;
    let file = String::from_utf8(mixdog_testkit::read(assets_file(&media.join("assets"), &saved["file"]))).unwrap();
    out["afterSave"] = json!({"total": s.list(json!({"limit": 10})).await["total"], "fileBytes": file});
    s.save("image", "lane", "model", "q", json!({}), "image/png", b"b", json!({})).await;
    out["backup"] = read_json(&media.join("index.json.bak"));
    out
}

async fn boards_persist(script: &Script, data: &Path) -> Value {
    let s = open(data, script);
    let mut out = json!({});
    let board = s.ok("media/createMediaBoard", json!({"opId": "o", "name": "  Gacha   sprites "})).await;
    out["board"] = board.clone();
    let save = |prompt: &'static str, meta: Value| s.save("image", "gemini", "m", prompt, json!({}), "image/png", prompt.as_bytes(), meta);
    let loose = save("loose", json!({})).await;
    let in_board = save("in board", json!({"boardId": board["id"]})).await;
    out["inBoardList"] = s.list(json!({"boardId": board["id"]})).await;
    out["addLoose"] = s.ok("media/setMediaAssetBoard", json!({"opId": "o", "ids": [loose["id"]], "boardId": board["id"]})).await;
    s.ok("media/renameMediaBoard", json!({"opId": "o", "id": board["id"], "name": "Icons"})).await;
    let reopened = open(data, script);
    out["reopened"] = reopened.ok("media/listMediaBoards", json!({"opId": "o"})).await;
    out["setUnknownBoard"] = reopened.threw("media/setMediaAssetBoard", json!({"opId": "o", "ids": [loose["id"]], "boardId": "missing"})).await;
    out["typeChecks"] = json!({
        "createWithObject": reopened.threw("media/createMediaBoard", json!({"opId": "o", "name": {"name": "x"}})).await,
        "renameWithNumber": reopened.threw("media/renameMediaBoard", json!({"opId": "o", "id": 17, "name": "x"})).await,
        "setBoardFalse": reopened.threw("media/setMediaAssetBoard", json!({"opId": "o", "ids": [loose["id"]], "boardId": false})).await,
        "setObjectId": reopened.threw("media/setMediaAssetBoard", json!({"opId": "o", "ids": [{}], "boardId": board["id"]})).await,
    });
    out["assetsOfBoardAfterRefusals"] = reopened.list(json!({"boardId": board["id"]})).await;
    out["removeFromBoard"] = reopened.ok("media/setMediaAssetBoard", json!({"opId": "o", "ids": [loose["id"]], "boardId": null})).await;
    reopened.ok("media/setMediaAssetBoard", json!({"opId": "o", "ids": [loose["id"]], "boardId": board["id"]})).await;
    out["deleteBoard"] = reopened.ok("media/deleteMediaBoard", json!({"opId": "o", "id": board["id"]})).await;
    out["boardsAfterDelete"] = reopened.ok("media/listMediaBoards", json!({"opId": "o"})).await;
    out["assetsAfterDelete"] = reopened.ok("media/listMediaAssets", json!({"opId": "o"})).await;
    out["ids"] = json!({"board": board["id"], "loose": loose["id"], "inBoard": in_board["id"]});
    out
}

async fn a_malformed_boards_file(script: &Script, recorded: &Exact, data: &Path) -> Value {
    let s = open(data, script);
    for name in ["One", "Two", "Three"] {
        s.ok("media/createMediaBoard", json!({"opId": "o", "name": name})).await;
    }
    let boards = data.join("media").join("boards.json");
    let overwritten = plain(recorded.get("overwrittenWith"));
    mixdog_testkit::write(&boards, serde_json::to_vec(&overwritten).unwrap());
    s.ok("media/createMediaBoard", json!({"opId": "o", "name": "Four"})).await;
    let listed = s.ok("media/listMediaBoards", json!({"opId": "o"})).await;
    let names: Vec<Value> = listed["boards"].as_array().unwrap().iter().map(|board| board["name"].clone()).collect();
    json!({
        "created": ["One", "Two", "Three"],
        "overwrittenWith": overwritten,
        "thenCreated": "Four",
        "names": names,
        "backup": read_json(&data.join("media").join("boards.json.bak")),
        "note": plain(recorded.get("note")),
    })
}

/// The recorded observation with its errors in their wire form.
fn expected(observed: &Exact) -> Exact {
    node_wire(observed)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_media_store_case_replays_through_the_media_methods() {
    let golden = Exact::decode(&serde_json::from_str::<Value>(&GOLDEN).unwrap()).unwrap();
    let script = Script { now: golden.get("clock").get("dateNow").as_f64() as i64, ids: Arc::new(AtomicU64::new(0)) };
    let cases = golden.get("cases").as_array();
    assert_eq!(cases.len(), 6);
    let mut failures = Vec::new();
    for case in cases {
        let name = case.get("case").as_str();
        let recorded = case.get("observed");
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let observed = match name {
            "media assets are organized by kind, provider, model, and local date while flat files migrate" => media_assets_are_organized(&script, recorded, data).await,
            #[cfg(windows)]
            "a failed duration write leaves the cached index row untouched" => a_failed_duration_write(&script, recorded, data).await,
            // Recorded on win32 only (Node's test skips elsewhere: no read-only rename refusal there).
            #[cfg(not(windows))]
            "a failed duration write leaves the cached index row untouched" => continue,
            "bulk media cleanup previews, then deletes by age, missing file, selection, and kind" => bulk_media_cleanup(&script, recorded, data).await,
            "a NUL-filled media index lists an empty gallery, is kept aside, and saving still works" => a_nul_filled_index(&script, recorded, data).await,
            "boards persist with their results; deleting a board keeps its results in the catalog" => boards_persist(&script, data).await,
            "a boards file with a malformed list is recovered from its backup before a create, not overwritten" => a_malformed_boards_file(&script, recorded, data).await,
            other => panic!("no replay for {other:?}"),
        };
        let (got, want) = (Exact::plain(&observed), expected(recorded));
        if got != want {
            failures.push(format!("{name}\n  core: {}\n  node: {}", serde_json::to_string(&observed).unwrap(), serde_json::to_string(&want.to_plain().unwrap()).unwrap()));
        }
    }
    assert!(failures.is_empty(), "{} case(s) differ:\n{}", failures.len(), failures.join("\n"));
}
